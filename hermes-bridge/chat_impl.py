"""The /v1/chat/completions implementation (agent-loop, runs, swarm, passthrough routing).

Splitting this into per-transport classes is spec item 4.2, not this move.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import json
import os
import threading
import time
import uuid
from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

import brain_client
import bridge_config
import bridge_providers
import bridge_state
import bridge_workspace
import mcp_telemetry
import routes.swarm
from acp_chat import _acp_chat_completions_impl
from brain_client import _brain_post, _claimed_resources, _claimed_resources_lock
from bridge_config import DEFAULT_TOOLSETS, MINIMAX_KEY
from bridge_events import (
    agent_notice_clear_event,
    agent_status_event,
    fallback_switch_event,
    filter_toolsets_for_plan_mode,
    hermes_run_server_tool_event,
    output_truncation_info,
    stream_retry_event,
    todo_plan_steps,
    tool_activity_event,
    tool_call_begin_event,
    tool_call_end_event,
    transport_status_event,
)
from bridge_providers import (
    _AGGREGATOR_PROVIDERS,
    _circuit_open_error,
    _cli_custom_endpoint_credentialed,
    _match_model_for_provider,
    MAX_AGENT_ITERATIONS,
    _moa_native_adapter_required_error,
    _native_provider_cannot_serve_model,
    _no_api_key_error,
    _resolve_chat_agent_class,
    _resolve_custom_credential_pool_route,
    _synthetic_cli_provider_id,
)
from bridge_state import (
    _mark_request_finished,
    _mark_request_started,
    _update_bridge_metrics,
)
from bridge_workspace import _maybe_expand_skill_command, _save_session_to_db
from chat_common import (
    ChatCompletionRequest,
    _finalize_tracked_session,
    _find_moa_shortcut,
    _format_tool_end_text,
    _format_tool_start_text,
    _get_stream_chunk_size,
    make_delta_chunk,
    _passthrough_chat_completions,
    REPO_EDIT_TOOL_NAMES,
    _resolve_workspace_id,
    _single_message_sse,
    sse_chunk,
)
from moa_config import _enabled_moa_preset_names, MOA_PROVIDER_ID
from provider_config import (
    _get_circuit,
    _KNOWN_HOSTS,
    _MODEL_PREFIX_TO_PROVIDER,
    _PROVIDER_CONFIG,
)
from routes.swarm import SwarmRequest
from session_tracker import (
    _append_session_chat_chunk,
    _MAX_SESSION_CHAT_MESSAGES,
    _normalize_chat_messages,
    _now_iso,
    _sessions,
    _sessions_lock,
    _trim_session_message_content,
)


async def _chat_completions_impl(request: Request, body: ChatCompletionRequest):
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
    from worktree_support import (
        worktree_requested,
        maybe_setup_worktree,
        adjust_toolsets_for_worktree,
        cleanup_worktree,
    )

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

    def _finalize_session(success: bool, error_message: Optional[str] = None):
        _finalize_tracked_session(
            session_id,
            success=success,
            error_message=error_message,
            persist_stub=not _using_real_agent,
        )

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

    if execution_mode == "swarm":
        if resolved_provider == MOA_PROVIDER_ID:
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=swarm error=moa-not-supported",
            )
            _finalize_session(False, "MoA is not supported in swarm mode yet.")
            return JSONResponse(
                status_code=400,
                content={"error": {"message": "MoA presets currently run through the normal Hermes agent loop, not swarm mode."}},
            )
        # Redirect to the dedicated swarm endpoint handler
        print(f"[hermes-bridge] Swarm mode. model={body.model} msgs={len(request_messages)}", flush=True)
        swarm_body = SwarmRequest(
            model=body.model,
            messages=request_messages,
            stream=body.stream,
            **(body.model_extra or {}),
        )
        return await routes.swarm.swarm_endpoint(request, swarm_body)

    if execution_mode == "passthrough":
        if resolved_provider == MOA_PROVIDER_ID:
            _mark_request_finished(
                model=body.model,
                success=False,
                summary=f"model={body.model} mode=passthrough error=moa-not-supported",
            )
            _finalize_session(False, "MoA is not supported in passthrough mode.")
            return JSONResponse(
                status_code=400,
                content={"error": {"message": "MoA presets require the Hermes agent loop so the aggregator can use tools."}},
            )
        print(
            f"[hermes-bridge] Passthrough mode. model={body.model} msgs={len(request_messages)} extra_keys={list((body.model_extra or {}).keys())}",
            flush=True,
        )
        return await _passthrough_chat_completions(
            body,
            agent_api_key,
            base_url=agent_base_url,
            finalize_request=lambda success: (
                _finalize_session(success),
                _mark_request_finished(
                    model=body.model,
                    success=success,
                    summary=f"model={body.model} mode=passthrough success={str(success).lower()}",
                ),
            ),
        )

    if execution_mode == "acp":
        # ACP transport — drive the REAL hermes-agent via Agent Client
        # Protocol (hermes-acp) instead of the reimplemented agent loop.
        return await _acp_chat_completions_impl(request, body)

    # AIAgent/_using_real_agent already resolved at the top of
    # _chat_completions_impl (right after workspace_id).
    if resolved_provider == MOA_PROVIDER_ID and not _using_real_agent:
        return _moa_native_adapter_required_error(
            model=body.model,
            finalize_session=_finalize_session,
        )

    import hermes_runs as _hermes_runs

    _use_runs_flag = _hermes_runs.parse_use_runs_flag(
        env_value=os.environ.get("HERMES_USE_RUNS"),
        header_value=request.headers.get("x-hermes-use-runs"),
        body_value=(body.model_extra or {}).get("hermes_use_runs"),
    )
    _gateway_base = _hermes_runs.resolve_gateway_base_url()
    _gateway_key = (
        api_key
        or os.environ.get("HERMES_API_KEY", "").strip()
        or os.environ.get("API_SERVER_KEY", "").strip()
        or (bridge_providers._get_local_gateway_key() or "")
    )
    _runs_parity = _hermes_runs.runs_parity_available(
        base_url=_gateway_base,
        api_key=_gateway_key or None,
    )
    _route_via_runs = _hermes_runs.should_route_via_runs(
        flag_enabled=_use_runs_flag,
        provider=resolved_provider,
        moa_provider_id=MOA_PROVIDER_ID,
        base_url=_gateway_base,
        api_key=_gateway_key or None,
        runs_moa_flag=_hermes_runs.parse_runs_moa_flag(),
        enabled_toolsets=enabled_toolsets,
    )
    if (
        _use_runs_flag
        and not _route_via_runs
        and _hermes_runs.enabled_toolsets_need_agent_loop_parity(enabled_toolsets)
    ):
        print(
            "[hermes-bridge] HERMES_USE_RUNS set; computer_use uses agent-loop "
            "(gateway runs tool.completed has no screenshot result)",
            flush=True,
        )
    elif _use_runs_flag and resolved_provider == MOA_PROVIDER_ID and not _route_via_runs:
        print(
            "[hermes-bridge] HERMES_USE_RUNS set; MoA using agent-loop "
            "(set HERMES_RUNS_MOA=1 or wait for gateway moa_runs capability)",
            flush=True,
        )
    elif _route_via_runs and resolved_provider == MOA_PROVIDER_ID:
        print(
            f"[hermes-bridge] Routing MoA via gateway /v1/runs. model={body.model} session={workspace_id}",
            flush=True,
        )
    elif _route_via_runs:
        print(
            f"[hermes-bridge] Routing via gateway /v1/runs. model={body.model} session={workspace_id}",
            flush=True,
        )
    _transport_label = "Starting Hermes gateway run..." if _route_via_runs else "Starting Hermes agent loop..."
    _transport_reason = None
    if _use_runs_flag and not _route_via_runs:
        if _hermes_runs.enabled_toolsets_need_agent_loop_parity(enabled_toolsets):
            _transport_reason = "Computer Use still requires the agent loop because gateway runs events do not include screenshot results."
        elif resolved_provider == MOA_PROVIDER_ID:
            _transport_reason = "Mixture of Agents still needs the agent loop unless gateway MoA runs support is enabled."
        else:
            _requested_custom_tools = (body.model_extra or {}).get("custom_tools")
            _needs_loop, _needs_loop_reason = _hermes_runs.needs_agent_loop_parity(
                runs_parity_available=_runs_parity,
                worktree_active=use_worktree,
                explicit_provider=resolved_provider,
                moa_provider_id=MOA_PROVIDER_ID,
                moa_runs_allowed=_hermes_runs.parse_runs_moa_flag(),
                enabled_toolsets=enabled_toolsets,
                toolsets_overridden=toolsets_overridden,
                default_toolsets=default_toolsets,
                repo_mode=has_repo_tools,
                github_pat=github_pat or None,
                custom_tools=_requested_custom_tools if isinstance(_requested_custom_tools, list) else None,
                reasoning_effort=(body.model_extra or {}).get("reasoning_effort"),
                custom_cli_base_url=(
                    cli_base_url
                    if cli_is_custom and (
                        resolved_provider == "custom"
                        or (resolved_provider or "").startswith("custom:")
                        or route_source.startswith("config.yaml-custom")
                        or route_source == "explicit-custom"
                    )
                    else None
                ),
            )
            if _needs_loop and _needs_loop_reason:
                _transport_reason = _needs_loop_reason[:1].upper() + _needs_loop_reason[1:]

    chunk_id = f"chatcmpl-hermes-{os.urandom(8).hex()}"
    # Brain MCP: register per-request session so overseer can address it directly
    try:
        await brain_client._brain_rpc("tools/call", {"name": "brain_register", "arguments": {"name": f"hermes-request-{chunk_id}"}})
    except Exception:
        pass
    # Brain MCP: publish per-request job metadata keyed by chunk_id so the overseer
    # can correlate in-flight requests and inspect individual job state.
    try:
        brain_client._brain_set(f"bridge:active-request:{chunk_id}", active_job_meta)
    except Exception:
        pass
    # Thread-safe asyncio queue for all events (text and tool activity)
    # Replaces sync queue.Queue — now native async, no to_thread bridging needed
    event_queue: asyncio.Queue = asyncio.Queue()
    done_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    # Queue wrapper for safe thread → async put
    def _qput(item):
        loop.call_soon_threadsafe(event_queue.put_nowait, item)

    def _repo_claim_resources(tool_name: str, tool_input: str) -> list[str]:
        try:
            args = json.loads(tool_input) if tool_input else {}
        except (json.JSONDecodeError, TypeError):
            return []

        if tool_name == "batch_edit_repo_files":
            changes = args.get("changes", [])
            if not isinstance(changes, list):
                return []
            paths = [
                change.get("path", "")
                for change in changes
                if isinstance(change, dict)
            ]
        else:
            paths = [args.get("path", "")]

        resources: list[str] = []
        seen: set[str] = set()
        repo_prefix = f"{repo_owner}/{repo_name}" if repo_owner and repo_name else "unknown"
        for path in paths:
            if not isinstance(path, str) or not path:
                continue
            resource = f"hermes-bridge:repo:{repo_prefix}:{path}"
            if resource in seen:
                continue
            seen.add(resource)
            resources.append(resource)
        return resources

    # Structured tool-call state for the agent-loop transport (worker-thread
    # callbacks may fire from parallel tool execution, hence the lock).
    tool_state_lock = threading.Lock()
    _active_tool_state: dict = {}  # call_id -> {"ts": monotonic, "name": tool}
    _pending_tool_ids: dict[str, list] = {}  # tool_name -> [call_ids] (FIFO fallback)

    def on_tool_start(tool_name: str, tool_input: str, call_id: Optional[str] = None):
        # Record MCP tool activity for the MCP dashboard (no-op for non-mcp_ tools).
        mcp_telemetry.record_tool_start(tool_name, tool_input)
        # Structured tool_call_begin: stable call_id across begin/delta/end.
        # Agents that know the provider's tool_call id pass it through; the
        # bridge generates one otherwise and pairs begin/end FIFO per tool.
        with tool_state_lock:
            if call_id is None:
                call_id = f"hermes-{uuid.uuid4().hex[:16]}"
                _pending_tool_ids.setdefault(tool_name, []).append(call_id)
            _active_tool_state[call_id] = {"ts": time.monotonic(), "name": tool_name}
        _qput(("tool_call_begin", tool_call_begin_event(call_id, tool_name)))
        # Emit tool start as visible text so user sees activity
        _qput(("tool_start", tool_name, tool_input))
        _append_session_chat_chunk(
            session_id,
            "assistant",
            _format_tool_start_text(tool_name, tool_input),
        )
        # Brain MCP: claim resource for edit operations to prevent conflicts
        if tool_name in REPO_EDIT_TOOL_NAMES:
            for resource in _repo_claim_resources(tool_name, tool_input):
                brain_client._brain_claim(resource, ttl=120)

    def on_tool_end(
        tool_name: str,
        tool_input: str,
        tool_output: str,
        call_id: Optional[str] = None,
        exit_code: Optional[int] = None,
        output_truncated: bool = False,
        output_truncated_lines: int = 0,
    ):
        # The composer task panel parses these tools' JSON output (todo lists,
        # subagent results, background process previews) — a 500-char cap
        # truncates the JSON mid-document, so give them more headroom.
        cap = 4000 if tool_name in ("todo", "delegate_task", "process", "terminal") else 500
        # Record MCP tool completion (latency, ok/err) for the MCP dashboard.
        mcp_telemetry.record_tool_end(tool_name, tool_output)
        # Pair the end with the matching begin (agent-provided id wins).
        with tool_state_lock:
            if call_id is None:
                pending = _pending_tool_ids.get(tool_name) or []
                call_id = pending.pop(0) if pending else f"hermes-{uuid.uuid4().hex[:16]}"
            state = _active_tool_state.pop(call_id, {})
        started_ts = state.get("ts")
        duration_ms = int((time.monotonic() - started_ts) * 1000) if started_ts else 0
        if not output_truncated:
            output_truncated, output_truncated_lines = output_truncation_info(tool_output, cap)
        success = not (tool_output or "").strip().lower().startswith(("error:", "failed:"))
        _qput(("tool_call_end", tool_call_end_event(
            call_id,
            tool_name,
            success=success,
            exit_code=exit_code,
            duration_ms=duration_ms,
            output_truncated=output_truncated,
            output_truncated_lines=output_truncated_lines,
        )))
        _qput(("tool_end", tool_name, tool_output[:cap]))
        _append_session_chat_chunk(
            session_id,
            "assistant",
            _format_tool_end_text(tool_name, tool_output),
        )
        # Brain MCP: release resource for edit operations
        if tool_name in REPO_EDIT_TOOL_NAMES:
            for resource in _repo_claim_resources(tool_name, tool_input):
                brain_client._brain_release(resource)
        # Plan mode-ish: the hermes ``todo`` tool carries a checklist — surface
        # it as a structured plan_update when parseable (agent-loop path).
        if tool_name == "todo":
            steps = todo_plan_steps(tool_output)
            if steps:
                _qput(("plan_update", {"type": "plan_update", "steps": steps}))

    def on_text(text: str):
        _append_session_chat_chunk(session_id, "assistant", text)
        # Stream normal text in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("text", text[i:i + chunk_size]))

    def on_thinking(iteration: int):
        _qput(("thinking", iteration))
        # Brain MCP: pulse every 5 iterations (not every iteration — avoids noise)
        if iteration % 5 == 0:
            brain_client._brain_pulse("working", f"iteration={iteration} model={body.model}")

    def on_reasoning(text: str):
        # Stream reasoning in small chunks for responsiveness
        chunk_size = _get_stream_chunk_size(text)
        for i in range(0, len(text), chunk_size):
            _qput(("reasoning", text[i:i + chunk_size]))

    def on_server_tool_event(event: dict):
        _qput(("server_tool_event", event))

    def on_fallback_switch(provider: str, model: str):
        _qput(("fallback_switch", fallback_switch_event(provider, model)))

    def on_transport_status(requested: str, actual: str, reason: str | None = None):
        _qput(("transport_status", transport_status_event(requested, actual, reason)))

    def on_stream_retry(attempt: int, max_attempts: int, reason: str, delay_ms: int):
        # The agent-loop retried an upstream stream — surface it once per retry.
        _qput(("stream_retry", stream_retry_event(attempt, max_attempts, reason, delay_ms)))

    def on_computer_use_frame(frame: dict):
        _qput(("computer_use_frame", frame))

    def on_notice(notice: dict):
        # Structured AgentNotice (credits warnings, run-budget wrap-up) from
        # the real hermes agent — surfaced as an SSE agent_notice event.
        _qput(("agent_notice", notice))

    def on_notice_clear(key: str):
        _qput(("agent_notice_clear", agent_notice_clear_event(key)))

    def _run_agent_sync():
        wt_info = None
        worktree_active = False
        try:
            if use_worktree:
                wt_info = maybe_setup_worktree(repo_root_header or None)
                worktree_active = bool(wt_info)
                if wt_info:
                    print(
                        f"[hermes-bridge] Worktree session active: {wt_info.get('path')}",
                        flush=True,
                    )
                else:
                    print(
                        "[hermes-bridge] Worktree requested but setup failed — continuing in original cwd",
                        flush=True,
                    )
            on_transport_status(
                "runs" if _use_runs_flag else "agent-loop",
                "runs" if _route_via_runs else "agent-loop",
                _transport_reason,
            )
            print(f"[hermes-bridge] Using {'real' if _using_real_agent else 'custom'} Hermes agent", flush=True)
            # Log message roles for debugging system prompt delivery
            msg_roles = [m["role"] for m in request_messages]
            has_extra_system = bool((body.model_extra or {}).get("system"))
            print(f"[hermes-bridge] Starting agent. mode={execution_mode} model={body.model} repo_mode={has_repo_tools} has_github={'yes' if github_pat else 'no'} repo={repo_owner}/{repo_name} toolsets={enabled_toolsets} msgs={len(request_messages)} roles={msg_roles} extra_system={has_extra_system}", flush=True)
            if has_repo_tools and not github_pat:
                print(f"[hermes-bridge] WARNING: repo_mode is active but no GitHub PAT provided — read_repo_file will fail", flush=True)
            # Extract repo file tree from request body (sent by server for Hermes agent-loop)
            repo_file_tree_raw = (body.model_extra or {}).get("repo_file_tree")
            repo_file_tree = (
                [p for p in repo_file_tree_raw if isinstance(p, str) and p.strip()]
                if isinstance(repo_file_tree_raw, list)
                else []
            )
            if repo_file_tree:
                print(f"[hermes-bridge] Received repo file tree: {len(repo_file_tree)} paths", flush=True)
            # Extract custom MCP tool definitions from request body
            custom_tools_raw = (body.model_extra or {}).get("custom_tools")
            custom_tools = (
                [t for t in custom_tools_raw if isinstance(t, dict)]
                if isinstance(custom_tools_raw, list)
                else []
            )
            if custom_tools:
                print(f"[hermes-bridge] Received {len(custom_tools)} custom MCP tool(s)", flush=True)
            # Reasoning effort from the CloudChat Effort slider (Faster ↔ Smarter)
            reasoning_effort_raw = (body.model_extra or {}).get("reasoning_effort")
            reasoning_effort = (
                reasoning_effort_raw.strip().lower()
                if isinstance(reasoning_effort_raw, str)
                and reasoning_effort_raw.strip().lower() in {
                    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
                }
                else None
            )
            if reasoning_effort:
                print(f"[hermes-bridge] Reasoning effort: {reasoning_effort}", flush=True)

            conversation_history = [dict(m) for m in request_messages]

            # The AI SDK may send the system prompt as a separate top-level
            # "system" field instead of (or in addition to) a system message
            # in the messages array.  Merge it if present.
            extra = body.model_extra or {}
            extra_system = extra.get("system")
            if isinstance(extra_system, str) and extra_system.strip():
                # Check if there's already a system message
                has_system = any(m.get("role") == "system" for m in conversation_history)
                if has_system:
                    for m in conversation_history:
                        if m.get("role") == "system":
                            m["content"] = extra_system + "\n\n" + (m["content"] or "")
                            break
                else:
                    conversation_history.insert(0, {"role": "system", "content": extra_system})

            # Find the last user message and pass everything before it
            # (including all assistant messages) as history.  Previous code
            # blindly took conversation_history[-1] which could strip an
            # assistant response when the SDK appends messages after it,
            # or — more critically — drop the assistant's analysis from
            # history when the last user message sits right after it.
            last_user_idx = None
            for i in range(len(conversation_history) - 1, -1, -1):
                if conversation_history[i]["role"] == "user":
                    last_user_idx = i
                    break

            if last_user_idx is not None:
                user_message = conversation_history[last_user_idx]["content"]
                # History = everything except the last user message itself.
                # This keeps all prior assistant messages (with their issue
                # analysis, etc.) in context for follow-up requests.
                history = conversation_history[:last_user_idx] + conversation_history[last_user_idx + 1:]
            else:
                user_message = ""
                history = list(conversation_history)

            agent_toolsets = (
                adjust_toolsets_for_worktree(enabled_toolsets)
                if worktree_active
                else enabled_toolsets
            )
            if plan_mode:
                agent_toolsets = filter_toolsets_for_plan_mode(agent_toolsets)
            agent_repo_mode = has_repo_tools and not worktree_active
            if worktree_active and has_repo_tools:
                print(
                    "[hermes-bridge] Worktree active — local file tools enabled, "
                    "GitHub API repo tools disabled for this run",
                    flush=True,
                )

            route_runs = _route_via_runs
            if route_runs:
                moa_runs_allowed = (
                    resolved_provider == MOA_PROVIDER_ID and _route_via_runs
                )
                needs_loop, parity_reason = _hermes_runs.needs_agent_loop_parity(
                    runs_parity_available=_runs_parity,
                    worktree_active=worktree_active,
                    # Use resolved_provider so demoted openrouter → custom still
                    # forces agent-loop; header-only would miss that path.
                    explicit_provider=(explicit_provider or resolved_provider or None),
                    moa_provider_id=MOA_PROVIDER_ID,
                    moa_runs_allowed=moa_runs_allowed,
                    enabled_toolsets=agent_toolsets,
                    toolsets_overridden=request.headers.get("x-hermes-toolsets") is not None,
                    default_toolsets=[t.strip() for t in DEFAULT_TOOLSETS.split(",") if t.strip()],
                    repo_mode=agent_repo_mode,
                    github_pat=github_pat if github_pat else None,
                    custom_tools=custom_tools or None,
                    reasoning_effort=reasoning_effort,
                    custom_cli_base_url=(
                        cli_base_url
                        if cli_is_custom and (
                            resolved_provider == "custom"
                            or str(resolved_provider or "").startswith("custom:")
                            or (agent_base_url and agent_base_url == cli_base_url)
                        )
                        else None
                    ),
                )
                if needs_loop:
                    print(
                        f"[hermes-bridge] Gateway /v1/runs cannot honor request — "
                        f"{parity_reason}; using agent-loop",
                        flush=True,
                    )
                    route_runs = False

            if route_runs:
                print(
                    f"[hermes-bridge] User message (runs): {user_message[:100]}... history_msgs={len(history)}",
                    flush=True,
                )
                system_msgs = [m["content"] for m in history if m.get("role") == "system"]
                non_system_history = [
                    {"role": m["role"], "content": m["content"]}
                    for m in history
                    if m.get("role") in {"user", "assistant"} and (m.get("content") or "").strip()
                ]
                instructions = "\n\n".join(system_msgs) if system_msgs else None
                run_provider = (explicit_provider or resolved_provider or "").strip().lower()
                if run_provider in {"", "auto", "default"}:
                    run_provider = None
                worktree_cwd = None
                if worktree_active and wt_info and _runs_parity:
                    worktree_cwd = str(wt_info.get("path") or "").strip() or None
                status_code, run_payload = _hermes_runs.submit_run(
                    base_url=_gateway_base,
                    api_key=_gateway_key or None,
                    input_text=user_message,
                    session_id=workspace_id,
                    conversation_history=non_system_history,
                    instructions=instructions,
                    model=body.model,
                    session_key=request.headers.get("x-hermes-session-key"),
                    cwd=worktree_cwd,
                    enabled_toolsets=agent_toolsets if _runs_parity else None,
                    provider=run_provider,
                    reasoning_effort=reasoning_effort,
                    include_parity_fields=_runs_parity,
                )
                if status_code != 202:
                    if (
                        resolved_provider == MOA_PROVIDER_ID
                        and _hermes_runs.is_moa_runs_rejection(status_code, run_payload)
                    ):
                        err = _hermes_runs.extract_gateway_error_text(run_payload)
                        print(
                            "[hermes-bridge] Gateway /v1/runs rejected provider=moa "
                            f"({status_code}: {err}) — falling back to agent-loop",
                            flush=True,
                        )
                        route_runs = False
                    else:
                        err = run_payload.get("error")
                        if isinstance(err, dict):
                            err = err.get("message") or json.dumps(err)
                        raise RuntimeError(f"Gateway /v1/runs failed ({status_code}): {err}")

            if route_runs:
                run_id = str(run_payload.get("run_id") or "").strip()
                if not run_id:
                    raise RuntimeError("Gateway /v1/runs returned no run_id")

                _hermes_runs.register_active_run(
                    workspace_id,
                    run_id=run_id,
                    base_url=_gateway_base,
                    api_key=_gateway_key or None,
                )
                _qput((
                    "server_tool_event",
                    hermes_run_server_tool_event(run_id, workspace_id),
                ))

                def _emit_run_event(*args):
                    _qput(args)

                try:
                    _hermes_runs.pump_run_events(
                        base_url=_gateway_base,
                        api_key=_gateway_key or None,
                        run_id=run_id,
                        emit=_emit_run_event,
                        should_stop=lambda: _hermes_runs.is_run_cancelled(workspace_id),
                    )
                finally:
                    # Pass run_id so a late-finishing run cannot delete a newer
                    # overlapping run's cancel handle for the same conversation.
                    _hermes_runs.unregister_active_run(workspace_id, run_id)
                print(f"[hermes-bridge] Gateway run completed. run_id={run_id}", flush=True)
                brain_client._brain_pulse("working", "completed")
                _update_bridge_metrics(success=True, decrement_active=True)
                _finalize_session(True)
                _mark_request_finished(
                    model=body.model,
                    success=True,
                    summary=f"model={body.model} mode=runs run_id={run_id}",
                )
                return

            agent_kwargs: dict = {
                "base_url": agent_base_url,
                "api_key": agent_api_key,
                "model": body.model,
                "max_iterations": MAX_AGENT_ITERATIONS,
                "enabled_toolsets": agent_toolsets,
                "repo_mode": agent_repo_mode,
                "worktree_mode": worktree_active,
                "repo_edit_intent": repo_edit_intent,
                "github_pat": github_pat if github_pat else None,
                "github_repo_owner": repo_owner if repo_owner else None,
                "github_repo_name": repo_name if repo_name else None,
                "repo_file_tree": repo_file_tree,
                "custom_tools": custom_tools,
                "workspace_id": workspace_id,
                "reasoning_effort": reasoning_effort,
                "plan_mode": plan_mode,
                "on_tool_start": on_tool_start,
                "on_tool_end": on_tool_end,
                "on_text": on_text,
                "on_server_tool_event": on_server_tool_event,
                "on_stream_retry": on_stream_retry,
            }
            if _using_real_agent:
                agent_kwargs["on_fallback_switch"] = on_fallback_switch
                agent_kwargs["on_computer_use_frame"] = on_computer_use_frame
                # Structured notices (credits/run-budget) — real-agent only.
                agent_kwargs["on_notice"] = on_notice
                agent_kwargs["on_notice_clear"] = on_notice_clear
                # Real-agent only: run_agent.AIAgent's fallback signature does not
                # accept this. Tells the adapter which profile's config.yaml to
                # read instead of the hard-coded ~/.hermes (B9).
                agent_kwargs["hermes_home"] = str(bridge_workspace._resolve_hermes_home(request_profile))
                if run_budget_seconds:
                    agent_kwargs["run_budget_seconds"] = run_budget_seconds
            if resolved_provider == MOA_PROVIDER_ID:
                agent_kwargs["provider_override"] = MOA_PROVIDER_ID
            agent = AIAgent(**agent_kwargs)
            agent.on_thinking = on_thinking
            agent.on_reasoning = on_reasoning

            print(f"[hermes-bridge] User message: {user_message[:100]}... history_msgs={len(history)} has_system={any(m.get('role') == 'system' for m in history)}", flush=True)
            agent.run_conversation(
                user_message=user_message,
                conversation_history=history,
            )
            print(f"[hermes-bridge] Agent conversation completed.", flush=True)
            # Brain MCP: pulse on successful completion
            brain_client._brain_pulse("working", "completed")
            # Update bridge health metrics (decrement active request counter)
            _update_bridge_metrics(success=True, decrement_active=True)
            _finalize_session(True)
        except Exception as e:
            error_message = str(e)
            print(f"[hermes-bridge] Agent error: {error_message}", flush=True)
            _append_session_chat_chunk(session_id, "assistant", f"\n\n[Error: {error_message}]")
            _qput(("text", f"\n\n[Error: {error_message}]"))
            # Brain MCP: report failure
            brain_client._brain_pulse("failed", f"error={error_message[:100]}")
            _update_bridge_metrics(success=False, decrement_active=True)
            _finalize_session(False, error_message=error_message)
        finally:
            if worktree_active and wt_info:
                try:
                    cleanup_worktree(wt_info)
                except Exception as wt_cleanup_err:
                    print(f"[hermes-bridge] Worktree cleanup error: {wt_cleanup_err}", flush=True)
            # Brain MCP: clean up per-request state to prevent zombies
            try:
                # Delete the active request key for this chunk
                brain_client._brain_set(f"bridge:active-request:{chunk_id}", "")
                # Release all claimed resources for this request's repo prefix
                # (TTL=120 auto-releases on crash; explicit release on clean exit)
                repo_prefix = f"hermes-bridge:repo:{repo_owner}/{repo_name}:" if repo_owner and repo_name else None
                with _claimed_resources_lock:
                    to_release = [r for r in list(_claimed_resources) if repo_prefix is None or r.startswith(repo_prefix)]
                    for r in to_release:
                        _claimed_resources.discard(r)
                for r in to_release:
                    brain_client._brain_release(r)
                # Pulse done status
                brain_client._brain_pulse("done", f"completed chunk={chunk_id}")
            except Exception:
                pass  # Best-effort cleanup
            loop.call_soon_threadsafe(done_event.set)

    async def event_stream():
        # Role chunk
        print(f"[hermes-bridge] SSE stream started. chunk_id={chunk_id}", flush=True)
        stream_started_at = time.monotonic()
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"role": "assistant"}))
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
            "agent_status": agent_status_event(
                phase="starting",
                label=_transport_label,
                started_at=stream_started_at,
            ),
        }))

        agent_task = asyncio.ensure_future(asyncio.to_thread(_run_agent_sync))
        event_count = 0
        idle_ticks = 0  # counts consecutive empty polls (~50ms each)
        HEARTBEAT_INTERVAL = 60  # ticks ≈ 3 seconds of silence

        while not done_event.is_set() or not event_queue.empty():
            drained = False
            while not event_queue.empty():
                drained = True
                idle_ticks = 0
                try:
                    event = event_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

                event_count += 1
                if event[0] == "text":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": event[1]}))
                elif event[0] == "tool_start":
                    tool_name, tool_input = event[1], event[2]
                    # Emit as both visible text and structured tool_activity
                    text = _format_tool_start_text(tool_name, tool_input)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": tool_activity_event(tool_name, "running", tool_input, None)
                    }))
                elif event[0] == "tool_end":
                    tool_name, tool_output = event[1], event[2]
                    text = _format_tool_end_text(tool_name, tool_output)
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"content": text}))
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "tool_activity": tool_activity_event(tool_name, "completed", "", tool_output)
                    }))
                elif event[0] == "tool_call_begin":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_begin": event[1]}))
                elif event[0] == "tool_call_delta":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_delta": event[1]}))
                elif event[0] == "tool_call_end":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"tool_call_end": event[1]}))
                elif event[0] == "stream_retry":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"stream_retry": event[1]}))
                elif event[0] == "plan_update":
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {"plan_update": event[1]}))
                elif event[0] == "thinking":
                    iteration = event[1]
                    status_label = (
                        "Analyzing repository context..."
                        if has_repo_tools and iteration == 1
                        else "Analyzing your request..."
                        if iteration == 1
                        else f"Planning iteration {iteration}..."
                    )
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_status": agent_status_event(
                            phase="thinking",
                            label=status_label,
                            started_at=stream_started_at,
                            iteration=iteration,
                        ),
                    }))
                    if iteration > 1:
                        # Show a thinking indicator between iterations so the
                        # user knows the agent is still working
                        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                            "content": "\n\n> *Thinking...*\n\n"
                        }))
                elif event[0] == "reasoning":
                    reasoning_text = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "reasoning": reasoning_text
                    }))
                elif event[0] == "transport_status":
                    status_event = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "transport_status": status_event
                    }))
                elif event[0] == "server_tool_event":
                    switch = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "fallback_switch": switch
                    }))
                elif event[0] == "computer_use_frame":
                    frame = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "computer_use_frame": frame
                    }))
                elif event[0] == "agent_notice":
                    notice = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_notice": notice
                    }))
                elif event[0] == "agent_notice_clear":
                    clear = event[1]
                    yield sse_chunk(make_delta_chunk(chunk_id, body.model, {
                        "agent_notice_clear": clear
                    }))

            if not done_event.is_set():
                idle_ticks += 1
                # Send SSE comment as keepalive to prevent connection timeout
                if idle_ticks % HEARTBEAT_INTERVAL == 0:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(0.05)

        # Final chunk
        print(f"[hermes-bridge] SSE stream ending. Total events emitted: {event_count}", flush=True)
        # Brain MCP: post completion status and update metrics
        elapsed_ms = int((time.monotonic() - stream_started_at) * 1000)
        _brain_post(f"hermes-bridge completed: model={body.model} events={event_count} elapsed_ms={elapsed_ms}", channel="hermes-bridge")
        brain_client._brain_set("hermes-bridge:active_request", "")
        brain_client._brain_set("hermes-bridge:active_sessions", str(bridge_state._bridge_active_requests), "global")
        brain_client._brain_set("hermes-bridge:last_completion", f"model={body.model} events={event_count} elapsed_ms={elapsed_ms}", "global")
        # Bridge metrics — publish final state via _update_bridge_metrics (called from
        # _run_agent_sync) plus api_calls for the completed request
        brain_client._brain_set("bridge:metrics", json.dumps({
            "active_requests": bridge_state._bridge_active_requests,
            "error_rate": round(bridge_state._bridge_error_count / max(bridge_state._bridge_total_requests, 1), 4),
            "uptime": round(time.time() - bridge_state._bridge_start_time, 1) if bridge_state._bridge_start_time > 0 else 0.0,
            "start_time": bridge_state._bridge_start_time,
            "total_requests": bridge_state._bridge_total_requests,
            "error_count": bridge_state._bridge_error_count,
            "api_calls": event_count,
            "estimated_cost_usd": round(event_count * 0.001, 4),
        }))
        # Brain MCP: per-request metrics keyed by chunk_id for per-request auditing
        try:
            brain_client._brain_set(f"bridge:metrics:{chunk_id}", json.dumps({
                "tokens": 0,
                "api_calls": event_count,
                "cost": round(event_count * 0.001, 4),
                "elapsed_ms": elapsed_ms,
                "model": body.model,
                "repo_mode": has_repo_tools,
            }))
        except Exception:
            pass
        yield sse_chunk(make_delta_chunk(chunk_id, body.model, {}, finish_reason="stop"))
        yield "data: [DONE]\n\n"

        await agent_task

    return StreamingResponse(event_stream(), media_type="text/event-stream")
