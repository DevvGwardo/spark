"""The /v1/chat/completions entry: session tracking, provider routing, dispatch.

Everything here is transport-independent. The tail packs the routed request
into a ``ChatContext`` and hands it to the transport ``select_transport``
picks (``chat_transports/``, spec 4.2), which owns the response from there.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import os
from dataclasses import dataclass
from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse

import bridge_config
import bridge_providers
import bridge_workspace
from bridge_config import DEFAULT_TOOLSETS, MINIMAX_KEY
from bridge_providers import (
    _AGGREGATOR_PROVIDERS,
    _circuit_open_error,
    _cli_custom_endpoint_credentialed,
    _match_model_for_provider,
    _native_provider_cannot_serve_model,
    _no_api_key_error,
    _resolve_chat_agent_class,
    _resolve_custom_credential_pool_route,
    _synthetic_cli_provider_id,
)
from bridge_state import _mark_request_started
from bridge_workspace import _maybe_expand_skill_command, _save_session_to_db
from chat_transports.base import ChatContext
from chat_transports.runs_plan import RunsPlan, plan_runs_route
from chat_transports.selection import select_transport
from chat_common import (
    ChatCompletionRequest,
    _finalize_tracked_session,
    _find_moa_shortcut,
    _resolve_workspace_id,
    _single_message_sse,
)
from moa_config import _enabled_moa_preset_names, MOA_PROVIDER_ID
from provider_config import (
    _get_circuit,
    _KNOWN_HOSTS,
    _MODEL_PREFIX_TO_PROVIDER,
    _PROVIDER_CONFIG,
)
from session_tracker import (
    _MAX_SESSION_CHAT_MESSAGES,
    _normalize_chat_messages,
    _now_iso,
    _sessions,
    _sessions_lock,
    _trim_session_message_content,
)


_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _background_requested(request: Request, body: ChatCompletionRequest) -> bool:
    """Spec 4.4: ``background: true`` (body) or ``X-Hermes-Background: 1``.

    A background turn keeps running when its client stream goes away; any
    other turn is cancelled on disconnect.
    """
    raw = (body.model_extra or {}).get("background")
    if raw is True or (isinstance(raw, str) and raw.strip().lower() in _TRUTHY):
        return True
    header = request.headers.get("x-hermes-background", "")
    return str(header or "").strip().lower() in _TRUTHY


async def _chat_completions_impl(request: Request, body: ChatCompletionRequest):
    """Route the request off the event loop, then hand it to its transport.

    Routing is all synchronous I/O: hermes config and auth.json reads, the
    credential pool, session-row sqlite writes, skill expansion and, for a
    custom endpoint, a model-catalog fetch. It used to run inline on the event
    loop and stall every other request while it did (spec 5.1 / G10).
    """
    routed = await asyncio.to_thread(_route_chat_request, request, body)
    if not isinstance(routed, _RoutedChat):
        return routed  # an early response (error, /moa usage, …)
    return await routed.transport_cls(routed.ctx, runs_plan=routed.runs_plan).handle()


@dataclass
class _RoutedChat:
    ctx: ChatContext
    transport_cls: type
    runs_plan: Optional[RunsPlan]


def _route_chat_request(request: Request, body: ChatCompletionRequest):
    """Everything transport-independent; runs on a worker thread.

    Returns a ``_RoutedChat`` or an early response.
    """
    toolsets_header = request.headers.get("x-hermes-toolsets", DEFAULT_TOOLSETS)
    enabled_toolsets = [t.strip() for t in toolsets_header.split(",") if t.strip()]
    # Plan mode: mutating tools are stripped before the agent is built (the
    # server sends this in the request extra fields for the streamText path).
    plan_mode = bool((body.model_extra or {}).get("plan_mode"))
    if plan_mode:
        print(f"[hermes-bridge] plan_mode: stripping mutating toolsets from {enabled_toolsets}", flush=True)
    # Wall-clock run budget (seconds) — optional request extra, forwarded to
    # the real AIAgent (agent.run_budget_seconds). 0/absent = unlimited.
    _raw_budget = (body.model_extra or {}).get("run_budget_seconds")
    try:
        run_budget_seconds = max(0, int(_raw_budget)) if _raw_budget else None
    except (TypeError, ValueError):
        run_budget_seconds = None
    execution_mode = request.headers.get("x-hermes-execution-mode", "agent-loop").strip().lower() or "agent-loop"
    request_profile = bridge_workspace._resolve_profile_name(request)
    repo_owner = request.headers.get("x-hermes-repo-owner", "")
    repo_name = request.headers.get("x-hermes-repo-name", "")
    github_pat = request.headers.get("x-hermes-github-pat", "")
    repo_edit_intent = request.headers.get("x-hermes-repo-edit-intent", "") == "1"
    repo_root_header = request.headers.get("x-hermes-repo-root", "").strip()
    from worktree_support import worktree_requested

    use_worktree = worktree_requested(request.headers.get("x-hermes-worktree"))
    request_messages = _normalize_chat_messages(body.messages, model=body.model, strip_images=True)

    # Resolve workspace_id from conversation_id (header or body) for per-conversation isolation
    workspace_id = _resolve_workspace_id(request, body)

    # Resolve the agent class early: whether we run the real hermes agent
    # (hermes_adapter) decides if the bridge writes its own stub session row.
    # The real agent creates and owns the state.db session itself.
    AIAgent, _using_real_agent = _resolve_chat_agent_class()

    # Session tracking for Hermes Chats view
    session_id = workspace_id
    last_user_msg = ""
    initial_chat: list[dict] = []
    for m in request_messages:
        role = m["role"]
        content = (m["content"] or "").strip()
        if content:
            initial_chat.append(
                {
                    "role": role,
                    "content": _trim_session_message_content(content),
                }
            )
        if role == "user":
            last_user_msg = content

    created_at = _now_iso()
    with _sessions_lock:
        _sessions[session_id] = {
            "id": session_id,
            "profile": request_profile,
            "model": body.model,
            "status": "active",
            "created_at": created_at,
            "updated_at": created_at,
            "messages": len(initial_chat),
            "toolsets": enabled_toolsets,
            "repo": f"{repo_owner}/{repo_name}" if repo_owner and repo_name else None,
            "firstUserMessage": last_user_msg[:100] if last_user_msg else "",
            "chat": initial_chat[-_MAX_SESSION_CHAT_MESSAGES:],
            "error": None,
        }
    # Only the legacy fallback agent needs a bridge-owned stub row: the real
    # hermes agent creates its own state.db session (source=cloudchat, full
    # transcript) keyed on the same session_id. Writing a stub here would
    # INSERT OR REPLACE over it.
    if not _using_real_agent:
        _save_session_to_db(_sessions[session_id])

    # If the latest user message is a hermes-agent skill command (/skill ...),
    # expand it in place into the skill's invocation prompt so the agent loop
    # actually runs the skill. The session record above keeps the original
    # slash command for display.
    _maybe_expand_skill_command(request_messages)
    moa_shortcut = _find_moa_shortcut(request_messages)
    if moa_shortcut:
        shortcut_index, shortcut_prompt = moa_shortcut
        if not shortcut_prompt:
            _finalize_tracked_session(
                session_id,
                success=True,
                persist_stub=not _using_real_agent,
            )
            return _single_message_sse(
                body.model,
                "Usage: /moa <prompt>\n\nRun one prompt through the default Mixture of Agents preset.",
            )
        request_messages[shortcut_index]["content"] = shortcut_prompt

    # Detect repo mode from either the request body tools OR the repo headers.
    # In agent-loop mode the server sends repo info via headers (not body tools),
    # so we must check both sources to enable repo_mode correctly.
    has_repo_tools = False
    extra = body.model_extra or {}
    tools_list = extra.get("tools")
    if isinstance(tools_list, (list, dict)):
        tool_names = set()
        if isinstance(tools_list, list):
            for fn in tools_list:
                name = fn.get("name", "") if isinstance(fn, dict) else ""
                if name:
                    tool_names.add(name)
        has_repo_tools = "edit_repo_file" in tool_names
    # Also enable repo mode when repo headers are present (agent-loop proxy path).
    # Enable even without a PAT so the agent gets the repo system prompt
    # (which explains the limitation) instead of being told about a repo
    # in the server system prompt with no tools to access it.
    if not has_repo_tools and repo_owner and repo_name:
        has_repo_tools = True

    # Key priority: 1. Explicit Authorization header, 2. HERMES_OPENROUTER_KEY env var,
    # 3. OpenRouter keys from hermes auth.json credential pool, 4. Local gateway token fallback.
    # Strip whitespace/placeholders — Spark used to send `Bearer ` / `Bearer undefined`,
    # which is truthy and blocked the env/config fallbacks (and produced misleading 401s).
    auth_header = request.headers.get("authorization", "") or ""
    header_key = ""
    if auth_header.lower().startswith("bearer "):
        header_key = auth_header[7:].strip()
    if header_key.lower() in {"", "undefined", "null", "none"}:
        header_key = ""
    api_key = (
        header_key
        or bridge_config.OPENROUTER_KEY
        or bridge_providers._get_openrouter_key_from_hermes_creds()
        or bridge_providers._get_local_gateway_key()
        or ""
    )
    if isinstance(api_key, str):
        api_key = api_key.strip()
    if not api_key or str(api_key).lower() in {"undefined", "null", "none"}:
        api_key = ""

    # ── Provider Routing ──────────────────────────────────────────────────
    # Priority, strongest first:
    #   1. model-name prefix match in MODEL_PREFIX_TO_PROVIDER (e.g. anthropic/* → Anthropic)
    #   2. config.yaml model.provider (explicit CLI declaration via `hermes model`)
    #   3. config.yaml model.base_url is a custom non-known host → custom passthrough
    #   4. auth.json active_provider (legacy fallback)
    #   5. OpenRouter (default)
    active_provider = bridge_providers._get_active_provider()

    # Explicit provider selection via header wins over all other resolution.
    explicit_provider = (request.headers.get("x-hermes-provider", "") or "").strip().lower()
    if explicit_provider in ("", "auto", "default"):
        explicit_provider = ""
    moa_config = bridge_providers._load_moa_config(bridge_workspace._resolve_hermes_home(request_profile))
    if moa_shortcut:
        explicit_provider = MOA_PROVIDER_ID
        body.model = str(moa_config.get("default_preset") or "default")
    elif isinstance(body.model, str) and body.model.lower().startswith("moa:"):
        explicit_provider = MOA_PROVIDER_ID
        body.model = body.model.split(":", 1)[1].strip() or str(moa_config.get("default_preset") or "default")

    cli_cfg = bridge_providers._load_cli_model_config(bridge_workspace._resolve_hermes_home(request_profile))
    cli_base_url = (cli_cfg.get("base_url") or "").strip()
    cli_provider = (cli_cfg.get("provider") or "").strip().lower()
    cli_api_key = (cli_cfg.get("api_key") or "").strip()

    # Detect custom (non-whitelisted) base_urls
    cli_is_custom = bool(cli_base_url) and not any(h in cli_base_url for h in _KNOWN_HOSTS)

    # Resolve provider from model prefix
    def _resolve_provider_from_model(model: str) -> Optional[str]:
        model_lower = model.lower()
        for prefix, provider_id in sorted(_MODEL_PREFIX_TO_PROVIDER.items(), key=lambda x: -len(x[0])):
            if not model_lower.startswith(prefix):
                continue
            # A vendor-style prefix (e.g. "deepseek/") is a *namespace*, not proof
            # of the native provider: aggregators (nous, opencode-zen, openrouter)
            # serve "deepseek/deepseek-v4-flash" too. Only let the prefix force the
            # native provider when that provider actually offers this exact model
            # id. If we have a non-empty catalog for it and the id isn't in it,
            # fall through so routing defers to the caller's active_provider/config
            # instead of 401-ing at the native API with an unknown model.
            known = bridge_providers._models_for_provider(provider_id)
            if known and not any(model_lower == m.lower() for m in known):
                continue
            return provider_id
        return None

    #   0. Explicit provider header (strongest — caller named the provider)
    model_prefix_provider = _resolve_provider_from_model(body.model)
    # A vendor prefix only names the provider when we can verify it against a
    # catalog. When the catalog is empty/unknown (no hermes_cli.models import,
    # fresh installs, CI), the prefix is unverified guesswork — an explicit
    # config.yaml provider or auth.json active_provider naming a DIFFERENT
    # provider must win instead of 401-ing at the guessed native API.
    if (
        model_prefix_provider
        and not bridge_providers._models_for_provider(model_prefix_provider)
        and (
            (cli_provider and cli_provider in _PROVIDER_CONFIG and cli_provider != model_prefix_provider)
            or (active_provider and active_provider in _PROVIDER_CONFIG and active_provider != model_prefix_provider)
        )
    ):
        model_prefix_provider = None
    # Synthetic CLI custom id from /v1/providers (e.g. custom:api.bullinf.fun).
    # Treat as an explicit request to use config.yaml's custom base_url — NOT openrouter.
    cli_custom_id = _synthetic_cli_provider_id(cli_cfg) if cli_is_custom else ""
    if explicit_provider == MOA_PROVIDER_ID:
        resolved_provider = MOA_PROVIDER_ID
        route_source = "explicit-header"
    elif (
        explicit_provider
        and cli_is_custom
        and explicit_provider in {cli_custom_id, "custom", cli_provider}
    ):
        # UI picked the CLI custom endpoint row — keep custom routing, don't force openrouter.
        resolved_provider = "custom"
        route_source = "explicit-custom"
    elif explicit_provider and explicit_provider in _PROVIDER_CONFIG:
        resolved_provider = explicit_provider
        route_source = "explicit-header"
    #   1. Model prefix match (strongest signal — the model identifier names the provider)
    elif model_prefix_provider:
        resolved_provider = model_prefix_provider
        route_source = "model-prefix"
    #   2. CLI config.yaml provider
    elif cli_provider == MOA_PROVIDER_ID:
        resolved_provider = MOA_PROVIDER_ID
        route_source = "config.yaml"
    elif cli_provider and cli_provider in _PROVIDER_CONFIG:
        resolved_provider = cli_provider
        route_source = "config.yaml"
    elif cli_is_custom:
        # provider: custom / unknown with a non-hardcoded base_url — do NOT fall
        # through to openrouter (that produces a misleading HERMES_OPENROUTER_KEY 401).
        resolved_provider = "custom"
        route_source = "config.yaml-custom"
    #   3. auth.json active_provider
    elif active_provider and active_provider in _PROVIDER_CONFIG:
        resolved_provider = active_provider
        route_source = "auth.json"
    #   4. Default
    else:
        resolved_provider = "openrouter"
        route_source = "default"

    pool_custom_route: Optional[tuple[str, str, str]] = None
    if route_source != "explicit-header" and not cli_is_custom:
        native_needs_pool = (
            resolved_provider not in _AGGREGATOR_PROVIDERS
            and resolved_provider in _PROVIDER_CONFIG
            and (
                not bridge_providers._provider_has_credentials(resolved_provider)
                or _native_provider_cannot_serve_model(resolved_provider, body.model)
            )
        )
        if native_needs_pool:
            pool_custom_route = _resolve_custom_credential_pool_route(
                prefer_providers=[cli_provider, active_provider],
                model=body.model,
            )

    # Credential-aware reroute: if the resolved provider can't be served (no usable
    # credential) but the gateway IS authed for another provider that serves this
    # model, switch to it so a running, credentialed Hermes gateway "just works"
    # instead of 401-ing at an uncredentialed native API (e.g. deepseek-v4-flash
    # name-routes to native DeepSeek, but only Nous is credentialed and serves it
    # as deepseek/deepseek-v4-flash). The caller's explicit provider header and an
    # explicit custom base_url both still win — only auto-resolved routes reroute.
    if (
        not pool_custom_route
        and route_source != "explicit-header"
        and not cli_is_custom
        and resolved_provider != MOA_PROVIDER_ID
        and (
            resolved_provider not in _PROVIDER_CONFIG
            or not bridge_providers._provider_has_credentials(resolved_provider)
        )
    ):
        candidates = []
        if active_provider and active_provider in _PROVIDER_CONFIG:
            candidates.append(active_provider)
        candidates += [p for p in _PROVIDER_CONFIG if p not in candidates]
        for cand in candidates:
            if not bridge_providers._provider_has_credentials(cand):
                continue
            remapped = _match_model_for_provider(cand, body.model)
            if not remapped:
                continue
            print(
                f"[hermes-bridge] Credential-aware reroute: {resolved_provider} → {cand} "
                f"(model {body.model} → {remapped}); source was {route_source}",
                flush=True,
            )
            if remapped != body.model:
                body.model = remapped
            resolved_provider = cand
            route_source = "credential-fallback"
            break

    # If the UI pinned OpenRouter (often from a stale picker default when the
    # CLI is actually on a custom endpoint) but OpenRouter is not credentialed
    # and config.yaml has a custom base_url, always prefer the CLI endpoint.
    # Do NOT require the Authorization header to be empty — Spark always sends
    # `Bearer ${apiKey}` (often empty or a placeholder), and treating that as
    # an OpenRouter key produced the misleading HERMES_OPENROUTER_KEY 401.
    # IMPORTANT: use native OpenRouter credentials only — a local OpenClaw
    # gateway token must NOT count as OpenRouter auth or demotion never runs
    # on typical Hermes+OpenClaw installs.
    openrouter_credentialed = bool(
        bridge_config.OPENROUTER_KEY
        or bridge_providers._get_openrouter_key_from_hermes_creds()
        or bridge_providers._provider_has_native_credentials("openrouter")
    )
    if (
        resolved_provider == "openrouter"
        and cli_is_custom
        and not openrouter_credentialed
        and (
            cli_api_key
            or bridge_providers._get_credential_pool_key(cli_provider)
            or bridge_providers._get_credential_pool_key(cli_custom_id)
            or _cli_custom_endpoint_credentialed(cli_cfg, bridge_workspace._resolve_hermes_home(request_profile))
            # Gateway alone is still a last-resort route signal so demotion can
            # attempt custom base_url rather than hard-401ing OpenRouter.
            or bridge_providers._get_local_gateway_key()
        )
    ):
        print(
            "[hermes-bridge] Ignoring uncredentialed openrouter pin — "
            f"using CLI custom base_url={cli_base_url} model={body.model} "
            f"(was source={route_source})",
            flush=True,
        )
        resolved_provider = "custom"
        route_source = "config.yaml-custom-override"

    # Custom non-hardcoded base_url overrides the resolved provider — UNLESS the
    # caller explicitly named a provider (UI picker), which always wins so the
    # selection isn't silently hijacked by a custom base_url in config.yaml.
    if resolved_provider == MOA_PROVIDER_ID:
        preset_name = (body.model or "").strip() or str(moa_config.get("default_preset") or "default")
        presets = moa_config.get("presets") if isinstance(moa_config.get("presets"), dict) else {}
        preset = presets.get(preset_name) if isinstance(presets, dict) else None
        if not preset or preset.get("enabled") is False:
            available = ", ".join(_enabled_moa_preset_names(moa_config)) or "none"
            _finalize_tracked_session(
                session_id,
                success=False,
                error_message=f"MoA preset '{preset_name}' is not configured or is disabled",
            )
            return JSONResponse(
                status_code=400,
                content={
                    "error": {
                        "message": (
                            f"MoA preset '{preset_name}' is not configured or is disabled. "
                            f"Available presets: {available}. Configure `moa.presets` in ~/.hermes/config.yaml."
                        ),
                        "code": "MOA_PRESET_NOT_FOUND",
                    }
                },
            )
        body.model = preset_name
        agent_base_url = "virtual://moa"
        agent_api_key = api_key or "moa"
        print(
            f"[hermes-bridge] Routing via native Hermes MoA preset. preset={preset_name}",
            flush=True,
        )
    elif cli_is_custom and (
        route_source in {
            "explicit-custom",
            "config.yaml-custom",
            "config.yaml-custom-override",
        }
        # After the openrouter demotion above, always honor custom base_url.
        or resolved_provider == "custom"
        or (
            # Legacy path: custom base_url with unknown provider id.
            # Do NOT hijack when model-prefix/credential-fallback already
            # resolved a real native provider (e.g. MiniMax-M2.7 → minimax).
            cli_provider not in _PROVIDER_CONFIG
            and resolved_provider not in _PROVIDER_CONFIG
            and resolved_provider != MOA_PROVIDER_ID
            and route_source not in {
                "explicit-header",
                "model-prefix",
                "credential-fallback",
            }
        )
    ):
        # Credential priority for a custom base_url: the api_key configured
        # alongside the model in ~/.hermes/config.yaml wins (the user set it
        # there explicitly), then the auth.json credential pool, then a key
        # forwarded by the client, then the local gateway token. Without the
        # config.yaml fallback the bridge ignored a perfectly good key and
        # returned 401 — e.g. deepseek-v4-pro via opencode-go.
        cli_key = (
            cli_api_key
            or bridge_providers._get_credential_pool_key(cli_provider)
            or bridge_providers._get_credential_pool_key(cli_custom_id)
            or (api_key if api_key and api_key.lower() not in {"undefined", "null", "none"} else "")
            or bridge_providers._get_local_gateway_key()
        )
        if not cli_key:
            return _no_api_key_error(cli_provider or "cli-config")
        agent_base_url = cli_base_url
        agent_api_key = cli_key
        # `auto`/`fast` are router aliases some gateways accept for plain chat
        # but reject (or 500) when tools are attached. Prefer a concrete model
        # from the matching custom_providers entry so agent-loop can run.
        # Prefer a known-good id that appears in the catalog over the first
        # listed entry — catalogs often lead with e2ee-* / offline models that
        # 404 with "no chat offers" (BullInf).
        model_lower = (body.model or "").strip().lower()
        if model_lower in {"", "auto", "fast", "default"}:
            catalog = [
                mid.strip()
                for mid in bridge_providers._models_for_custom_base_url(
                    cli_base_url, bridge_workspace._resolve_hermes_home(request_profile)
                )
                if isinstance(mid, str) and mid.strip()
                and mid.strip().lower() not in {"", "auto", "fast", "default"}
            ]
            catalog_by_lower = {m.lower(): m for m in catalog}
            # Prefer known-good ids *when they appear in the catalog* — never
            # invent a BullInf-specific id for an empty/unrelated custom host.
            preferred_order = (
                "deepseek-v4-flash",
                "mimo-v2.5",
                "mimo-v2.5-pro",
                "gpt-5.4-mini",
                "minimax-m2.5",
                "minimax-m2.1",
                "deepseek-v4-pro",
            )
            concrete = None
            for preferred in preferred_order:
                hit = catalog_by_lower.get(preferred.lower())
                if hit:
                    concrete = hit
                    break
            if not concrete:
                # Skip e2ee-* / private-prefix entries when a public model exists.
                for mid in catalog:
                    if not mid.lower().startswith("e2ee-"):
                        concrete = mid
                        break
            if not concrete and catalog:
                concrete = catalog[0]
            # Fall back to config.yaml model.default when it is a concrete id.
            if not concrete:
                cfg_default = (cli_cfg.get("default") or "").strip()
                if cfg_default and cfg_default.lower() not in {"", "auto", "fast", "default"}:
                    concrete = cfg_default
            # Do NOT invent preferred_order[0] when catalog is empty — that
            # hard-coded BullInf id 404s on generic custom base_urls.
            if concrete:
                print(
                    f"[hermes-bridge] Resolving model {body.model!r} → {concrete!r} "
                    f"for custom base_url (agent/tool compatible)",
                    flush=True,
                )
                body.model = concrete
        print(
            f"[hermes-bridge] Routing via ~/.hermes/config.yaml custom base_url. "
            f"provider={cli_provider} base_url={cli_base_url} model={body.model} "
            f"source={route_source}",
            flush=True,
        )
    elif pool_custom_route:
        pool_provider, agent_base_url, agent_api_key = pool_custom_route
        print(
            f"[hermes-bridge] Routing via credential_pool. "
            f"provider={pool_provider} base_url={agent_base_url} model={body.model} "
            f"(native {resolved_provider} does not serve this model id)",
            flush=True,
        )
    else:
        # Resolve provider from the central config table
        provider_cfg = _PROVIDER_CONFIG.get(resolved_provider)
        if not provider_cfg:
            # Unknown provider — fall back to OpenRouter
            provider_cfg = _PROVIDER_CONFIG["openrouter"]
            resolved_provider = "openrouter"
            route_source = "fallback"

        circuit = _get_circuit(resolved_provider)
        if not circuit.is_available():
            return _circuit_open_error(provider_cfg["name"])

        # Resolve API key — try credential pool first, then env var, then gateway
        agent_api_key = ""
        if resolved_provider == "nous":
            agent_api_key = bridge_providers._get_nous_agent_key() or ""
        elif resolved_provider == "openrouter":
            agent_api_key = api_key or ""
        elif resolved_provider == "minimax":
            agent_api_key = (
                request.headers.get("x-hermes-minimax-key", "").strip()
                or getattr(body, "hermes_minimax_key", "").strip()
                or MINIMAX_KEY
                or ""
            )
        else:
            # Generic provider: try credential pool first, then env var.
            # Pool-only providers (opencode-go, opencode-zen, custom:*) aren't
            # in _PROVIDER_CONFIG, so provider_cfg.get("env_var", "") is "" —
            # fall back to the well-known OPENCODE_* env vars by resolved_provider.
            auth_provider = provider_cfg.get("auth_json_provider", resolved_provider)
            env_var = provider_cfg.get("env_var", "")
            if not env_var:
                if resolved_provider in ("opencode-go", "custom:opencode-go"):
                    env_var = "OPENCODE_GO_API_KEY"
                elif resolved_provider in ("opencode-zen", "custom:opencode-zen", "custom:opencode.ai"):
                    env_var = "OPENCODE_API_KEY"
            agent_api_key = (
                bridge_providers._get_credential_pool_key(auth_provider)
                or os.environ.get(env_var, "")
                or (os.environ.get("OPENCODE_API_KEY") or os.environ.get("OPENCODE_GO_API_KEY")
                    if resolved_provider.startswith("opencode") or resolved_provider.startswith("custom:opencode")
                    else "")
                or bridge_providers._get_local_gateway_key()
                or ""
            )

        if not agent_api_key:
            return _no_api_key_error(resolved_provider)

        agent_base_url = provider_cfg["base_url"]
        print(
            f"[hermes-bridge] Routing via {provider_cfg['name']}. "
            f"source={route_source} model={body.model} base_url={agent_base_url}",
            flush=True,
        )

    active_job_meta = _mark_request_started(
        model=body.model,
        enabled_toolsets=enabled_toolsets,
        repo_mode=has_repo_tools,
        repo_owner=repo_owner,
        repo_name=repo_name,
        repo_edit_intent=repo_edit_intent,
    )

    ctx = ChatContext(
        request=request,
        body=body,
        execution_mode=execution_mode,
        request_messages=request_messages,
        enabled_toolsets=enabled_toolsets,
        plan_mode=plan_mode,
        run_budget_seconds=run_budget_seconds,
        request_profile=request_profile,
        repo_owner=repo_owner,
        repo_name=repo_name,
        github_pat=github_pat,
        repo_edit_intent=repo_edit_intent,
        repo_root_header=repo_root_header,
        use_worktree=use_worktree,
        workspace_id=workspace_id,
        session_id=session_id,
        agent_class=AIAgent,
        using_real_agent=_using_real_agent,
        has_repo_tools=has_repo_tools,
        api_key=api_key,
        explicit_provider=explicit_provider,
        resolved_provider=resolved_provider,
        route_source=route_source,
        cli_base_url=cli_base_url,
        cli_is_custom=cli_is_custom,
        agent_base_url=agent_base_url,
        agent_api_key=agent_api_key,
        active_job_meta=active_job_meta,
        background=_background_requested(request, body),
    )

    # Transport choice happens only in select_transport. The runs decision
    # probes the gateway, so it runs lazily and only for agent-loop mode.
    runs_plan: Optional[RunsPlan] = None

    def _route_via_runs() -> bool:
        nonlocal runs_plan
        runs_plan = plan_runs_route(ctx)
        return runs_plan.route_via_runs

    transport_cls = select_transport(execution_mode, route_via_runs=_route_via_runs)
    return _RoutedChat(ctx=ctx, transport_cls=transport_cls, runs_plan=runs_plan)
