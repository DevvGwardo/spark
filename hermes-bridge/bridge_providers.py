"""Provider, model and credential resolution shared by health, providers and chat.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi.responses import JSONResponse

from bridge_logger import log as _log
from bridge_state import _mark_request_finished
from moa_config import (
    _coerce_moa_fanout,
    _coerce_moa_model_ref,
    _coerce_optional_float,
    _coerce_optional_int,
    _enabled_moa_preset_names,
    _load_moa_config,
    MOA_NATIVE_REQUIRED_CODE,
    MOA_NATIVE_REQUIRED_MESSAGE,
    MOA_PROVIDER_ID,
    MOA_PROVIDER_NAME,
    _normalize_moa_config,
    _normalize_moa_preset,
    _preset_to_yaml,
    _read_config_yaml,
    _save_moa_config,
)
from provider_config import (
    _brain_circuit,
    CircuitBreaker,
    _get_circuit,
    _known_host_label,
    _KNOWN_HOSTS,
    MINIMAX_BASE_URL,
    _minimax_circuit_ref,
    MINIMAX_MODEL_PREFIX,
    _MODEL_PREFIX_TO_PROVIDER,
    _model_supports_vision,
    NOUS_BASE_URL,
    _nous_circuit_ref,
    NOUS_MODEL_PREFIX,
    _openrouter_circuit_ref,
    _provider_circuits,
    _PROVIDER_CONFIG,
    _VISION_CAPABLE_MODELS,
)


def _load_cli_model_config(hermes_home: Optional[Path] = None) -> dict:
    """Read the `model:` block from <hermes_home>/config.yaml (Hermes CLI config).

    Defaults to ~/.hermes; pass a profile home to read that profile's config.
    Returns a dict with keys: default, provider, base_url, api_key (each may be None).
    """
    result = {"default": None, "provider": None, "base_url": None, "api_key": None}
    try:
        config_path = (hermes_home or Path.home() / ".hermes") / "config.yaml"
        if not config_path.is_file():
            return result
        try:
            import yaml
            with open(config_path) as f:
                cfg = yaml.safe_load(f)
            model_cfg = (cfg or {}).get("model", {}) if isinstance(cfg, dict) else {}
            if isinstance(model_cfg, dict):
                for k in ("default", "provider", "base_url", "api_key"):
                    v = model_cfg.get(k)
                    if isinstance(v, str) and v.strip():
                        result[k] = v.strip()
        except ImportError:
            # Fallback: simple parse for keys under "model:" section
            text = config_path.read_text()
            in_model = False
            for line in text.splitlines():
                stripped = line.strip()
                if stripped == "model:":
                    in_model = True
                    continue
                if in_model:
                    if not line.startswith(" ") and not line.startswith("\t"):
                        break
                    for k in ("default", "provider", "base_url", "api_key"):
                        prefix = f"{k}:"
                        if stripped.startswith(prefix):
                            v = stripped.split(prefix, 1)[1].strip().strip('"').strip("'")
                            if v:
                                result[k] = v
    except Exception:
        pass
    return result


def _load_cli_default_model() -> str | None:
    """Backward-compat shim — returns just the default model string."""
    return _load_cli_model_config().get("default")


def _cli_config_is_custom(cfg: dict) -> bool:
    """True when config.yaml model.base_url is a non-hardcoded custom endpoint."""
    base_url = (cfg.get("base_url") or "").strip()
    if not base_url:
        return False
    return not any(h in base_url for h in _KNOWN_HOSTS)


def _synthetic_cli_provider_id(cfg: dict) -> str:
    """Stable id for a config.yaml custom endpoint (e.g. custom:api.bullinf.fun)."""
    from urllib.parse import urlparse

    base_url = (cfg.get("base_url") or "").strip()
    provider = (cfg.get("provider") or "").strip().lower()
    if provider and provider not in _PROVIDER_CONFIG and provider not in ("", "custom", "auto", "default"):
        return provider if provider.startswith("custom:") else f"custom:{provider}"
    host = ""
    try:
        host = (urlparse(base_url).hostname or "").strip().lower()
    except Exception:
        host = ""
    if host:
        return f"custom:{host}"
    return "custom"


def _load_custom_providers_list(hermes_home: Optional[Path] = None) -> list[dict]:
    """Read config.yaml `custom_providers:` entries (name/base_url/model/models/api_key)."""
    try:
        config_path = (hermes_home or Path.home() / ".hermes") / "config.yaml"
        if not config_path.is_file():
            return []
        try:
            import yaml
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
        except ImportError:
            return []
        raw = cfg.get("custom_providers") if isinstance(cfg, dict) else None
        if not isinstance(raw, list):
            return []
        return [entry for entry in raw if isinstance(entry, dict)]
    except Exception:
        return []


def _models_for_custom_base_url(base_url: str, hermes_home: Optional[Path] = None) -> list[str]:
    """Collect model ids declared for a custom base_url in custom_providers."""
    base_norm = (base_url or "").strip().rstrip("/").lower()
    if not base_norm:
        return []
    models: list[str] = []
    seen: set[str] = set()
    for entry in _load_custom_providers_list(hermes_home):
        entry_base = (entry.get("base_url") or "").strip().rstrip("/").lower()
        if entry_base != base_norm:
            continue
        for mid in entry.get("models") or []:
            if isinstance(mid, str) and mid.strip() and mid.strip() not in seen:
                seen.add(mid.strip())
                models.append(mid.strip())
        default = entry.get("model")
        if isinstance(default, str) and default.strip() and default.strip() not in seen:
            seen.add(default.strip())
            models.insert(0, default.strip())
    return models


def _has_pool_entry(provider_name: str) -> bool:
    if not provider_name:
        return False
    try:
        auth_path = os.path.expanduser("~/.hermes/auth.json")
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}).get(provider_name, [])
        return bool(pool)
    except Exception:
        return False

def _cli_custom_endpoint_credentialed(cfg: dict, hermes_home: Optional[Path] = None) -> bool:
    """True when the CLI custom base_url has its own key (not OpenClaw gateway alone).

    A local gateway token does not prove the custom host accepts that token, so
    synthetic /v1/providers rows must not show as connected unless config.yaml or
    auth.json actually supplies a key for this endpoint.
    """
    if (cfg.get("api_key") or "").strip():
        return True
    provider = (cfg.get("provider") or "").strip().lower()
    if provider and (_get_credential_pool_key(provider) or _has_pool_entry(provider)):
        return True
    if provider:
        env_key = provider.upper().replace("-", "_").replace(":", "_") + "_API_KEY"
        if os.environ.get(env_key):
            return True
        # OPENCODE_* keys only prove credentials for opencode providers — a
        # generic custom host (e.g. api.bullinf.fun) must not inherit them.
        if provider.startswith("opencode") or provider.startswith("custom:opencode"):
            if os.environ.get("OPENCODE_GO_API_KEY") or os.environ.get("OPENCODE_API_KEY"):
                return True
    custom_id = _synthetic_cli_provider_id(cfg)
    if _get_credential_pool_key(custom_id) or _get_credential_pool_key("custom") or _has_pool_entry(custom_id) or _has_pool_entry("custom"):
        return True
    base_norm = (cfg.get("base_url") or "").strip().rstrip("/").lower()
    if not base_norm:
        return False
    for entry in _load_custom_providers_list(hermes_home):
        entry_base = (entry.get("base_url") or "").strip().rstrip("/").lower()
        if entry_base == base_norm and (entry.get("api_key") or "").strip():
            return True
    return False


def _cli_custom_provider_row(cfg: dict, hermes_home: Optional[Path] = None) -> Optional[dict]:
    """Synthetic /v1/providers row for the active CLI custom base_url, or None."""
    if not _cli_config_is_custom(cfg):
        return None
    base_url = (cfg.get("base_url") or "").strip()
    default_model = (cfg.get("default") or "").strip() or "auto"
    pid = _synthetic_cli_provider_id(cfg)
    models = _models_for_custom_base_url(base_url, hermes_home)
    # Always surface the configured default first so Settings/model pickers do
    # not lock onto catalog lead entries (e.g. e2ee-*) when default is present.
    if default_model:
        models = [m for m in models if m != default_model]
        models = [default_model, *models]
    # Prefer a short human name from matching custom_providers entries.
    name = pid.removeprefix("custom:") if pid.startswith("custom:") else pid
    base_norm = base_url.rstrip("/").lower()
    for entry in _load_custom_providers_list(hermes_home):
        entry_base = (entry.get("base_url") or "").strip().rstrip("/").lower()
        if entry_base == base_norm and isinstance(entry.get("name"), str) and entry["name"].strip():
            name = entry["name"].strip()
            break
    return {
        "id": pid,
        "name": name,
        "base_url": base_url,
        "is_aggregator": True,
        "credentialed": _cli_custom_endpoint_credentialed(cfg, hermes_home),
        "models": models,
        "default_model": default_model,
    }


_cli_model_config = _load_cli_model_config()
_cli_default_model = _cli_model_config.get("default")
DEFAULT_MODEL = os.environ.get("HERMES_DEFAULT_MODEL", _cli_default_model or "meta-llama/llama-4-maverick")


def _resolve_chat_agent_class():
    """Return (agent_class, using_real_adapter). Falls back to run_agent on import failure."""
    try:
        from hermes_adapter import HermesAgentAdapter as AIAgent
        return AIAgent, True
    except Exception as adapter_err:
        _log.warning("adapter", "adapter import failed, using legacy run_agent", error=str(adapter_err))
        from run_agent import AIAgent
        return AIAgent, False


def _moa_native_adapter_required_error(
    *,
    model: str,
    finalize_session,
) -> JSONResponse:
    """Refuse MoA when only the legacy run_agent fallback is available."""
    _mark_request_finished(
        model=model,
        success=False,
        summary=f"model={model} mode=agent-loop error=moa-native-required",
    )
    finalize_session(False, MOA_NATIVE_REQUIRED_MESSAGE)
    return JSONResponse(
        status_code=400,
        content={
            "error": {
                "message": MOA_NATIVE_REQUIRED_MESSAGE,
                "code": MOA_NATIVE_REQUIRED_CODE,
            }
        },
    )



# ------------------------------------------------------------------
# Retry helper for brain gateway calls
# ------------------------------------------------------------------
def _retry_brain_call(func, *args, retries: int = 2, backoff: float = 0.5, **kwargs):
    """Call a brain gateway function with retry and exponential backoff."""
    for attempt in range(retries + 1):
        if not _brain_circuit.is_available():
            return None
        try:
            result = func(*args, **kwargs)
            if result is not None:
                _brain_circuit.record_success()
                return result
            # None means brain unavailable — treat as failure
            _brain_circuit.record_failure()
        except Exception as e:
            print(f"[hermes-bridge] brain call attempt {attempt + 1} failed: {e}", flush=True)
            _brain_circuit.record_failure()
        if attempt < retries:
            time.sleep(backoff * (2 ** attempt))
    return None

# ------------------------------------------------------------------
# Error message helpers for common failures
# ------------------------------------------------------------------
def _no_api_key_error(provider: str) -> JSONResponse:
    """Build a user-friendly 401 error for a missing API key."""
    cfg = _PROVIDER_CONFIG.get(provider, {})
    name = cfg.get("name", provider)
    env_var = cfg.get("env_var", f"HERMES_{provider.upper()}_KEY")
    messages = {
        "openrouter": "No API key provided. Set HERMES_OPENROUTER_KEY, pass Authorization: Bearer *** header, or run the local OpenClaw gateway.",
        "minimax": "MiniMax API key required. Set HERMES_MINIMAX_KEY, configure a MiniMax key in Settings, or run the local OpenClaw gateway.",
        "nous": "Nous API key required. Configure a Nous agent key in ~/.hermes/auth.json or run `hermes auth login --provider nous`.",
        "github": "GitHub token required for repository operations. Provide x-hermes-github-pat header or configure a GitHub token in Settings.",
    }
    if provider in messages:
        return JSONResponse(
            status_code=401,
            content={"error": {"message": messages[provider]}},
        )
    # Generic message for all other providers
    return JSONResponse(
        status_code=401,
        content={"error": {"message": f"{name} API key required. Set {env_var} environment variable, "
                                      f"add {provider} credentials to ~/.hermes/auth.json, or run `hermes auth add`."}},
    )


def _repo_not_found_error(owner: str, repo: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={
            "error": {
                "message": f"Repository '{owner}/{repo}' not found or not accessible. Check the repository name and ensure your GitHub token has access.",
                "code": "REPO_NOT_FOUND",
            }
        },
    )


def _github_token_expired_error() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={
            "error": {
                "message": "GitHub token is invalid or expired. Please update your GitHub Personal Access Token in Settings.",
                "code": "GITHUB_TOKEN_EXPIRED",
            }
        },
    )


def _circuit_open_error(provider: str) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "message": f"{provider} service is temporarily unavailable (circuit open). Please retry shortly.",
                "code": "CIRCUIT_OPEN",
            }
        },
    )


def _get_local_gateway_key() -> Optional[str]:
    """Read the gateway auth token from local openclaw.json config.

    Returns the gateway's Bearer token (gateway.auth.token) if the gateway
    is configured and the file is readable. Returns None if not configured
    or file missing/parseable.
    """
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path, "r") as f:
            config = json.load(f)
        token = config.get("gateway", {}).get("auth", {}).get("token")
        if token and isinstance(token, str) and len(token) > 0:
            return token
    except Exception:
        pass
    return None


def _get_openrouter_key_from_hermes_creds() -> Optional[str]:
    """Read OpenRouter API keys from ~/.hermes/auth.json credential_pool.

    Returns the highest-priority (lowest priority number) OpenRouter API key.
    Returns None if auth.json doesn't exist or has no OpenRouter credentials.
    """
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}).get("openrouter", [])
        if not pool:
            return None
        # Sort by priority (lower = higher priority), pick first with a key
        sorted_creds = sorted(pool, key=lambda c: c.get("priority", 99))
        for cred in sorted_creds:
            key = cred.get("access_token", "")
            if key and key != "***" and len(key) > 0:
                return key
    except Exception:
        pass
    return None


def _get_nous_agent_key() -> Optional[str]:
    """Read Nous inference agent key from ~/.hermes/auth.json.

    Returns the agent_key from the nous provider entry.
    Returns None if auth.json doesn't exist or has no Nous credentials.
    """
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        nous = auth.get("providers", {}).get("nous", {})
        key = nous.get("agent_key", "")
        if key and len(key) > 0:
            return key
    except Exception:
        pass
    return None


_HERMES_DOTENV_CACHE: Optional[dict] = None

def _read_hermes_dotenv_var(name: str) -> str:
    """Read one var from ~/.hermes/.env (KEY=value lines, no quotes stripping
    beyond what dotenv does). Cached per-process; returns "" when absent."""
    global _HERMES_DOTENV_CACHE
    if _HERMES_DOTENV_CACHE is None:
        _HERMES_DOTENV_CACHE = {}
        try:
            dotenv_path = os.path.expanduser("~/.hermes/.env")
            with open(dotenv_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    _HERMES_DOTENV_CACHE[k.strip()] = v.strip().strip('"').strip("'")
        except Exception:
            pass
    return _HERMES_DOTENV_CACHE.get(name, "")


def _get_credential_pool_key(provider_name: str) -> Optional[str]:
    """Read an API key from ~/.hermes/auth.json credential_pool[provider_name].

    Returns the highest-priority (lowest priority number) entry's access_token.
    Returns None if auth.json doesn't exist or has no matching credentials.
    """
    if not provider_name:
        return None
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}).get(provider_name, [])
        if not pool:
            return None
        sorted_creds = sorted(pool, key=lambda c: c.get("priority", 99))
        for cred in sorted_creds:
            key = cred.get("access_token", "")
            if key and key != "***":
                return key
            # Env-sourced pool entries (source: "env:VARNAME") don't persist the
            # secret in auth.json — only a fingerprint. Resolve by reading the
            # referenced env var at lookup time, mirroring hermes_cli.auth.
            # When the bridge is spawned by Electron it may not inherit the
            # user's shell exports — fall back to ~/.hermes/.env (hermes loads
            # that file itself, and it takes precedence over stale shell vars).
            source = str(cred.get("source") or "").strip()
            if source.startswith("env:"):
                env_var = source.split(":", 1)[1].strip()
                if env_var:
                    env_key = os.environ.get(env_var, "")
                    if not env_key or env_key == "***":
                        env_key = _read_hermes_dotenv_var(env_var)
                    if env_key and env_key != "***":
                        return env_key
    except Exception:
        pass
    return None


def _get_active_provider() -> Optional[str]:
    """Read the active_provider from ~/.hermes/auth.json."""
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        return auth.get("active_provider")
    except Exception:
        pass
    return None


def _load_credential_pool() -> dict[str, list[dict]]:
    """Return ~/.hermes/auth.json credential_pool entries keyed by provider id."""
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    try:
        with open(auth_path, "r") as f:
            auth = json.load(f)
        pool = auth.get("credential_pool", {}) or {}
        return pool if isinstance(pool, dict) else {}
    except Exception:
        return {}


def _credential_pool_entry_usable(entry: dict) -> bool:
    key = (entry.get("access_token") or "").strip()
    base_url = (entry.get("base_url") or "").strip()
    if not key or key == "***" or not base_url:
        return False
    status = (entry.get("last_status") or "").strip().lower()
    return status not in ("error", "failed", "unauthorized", "invalid", "exhausted")


def _best_usable_credential_pool_entry(pool: dict[str, list[dict]], provider_name: str) -> Optional[dict]:
    entries = pool.get(provider_name) or []
    for entry in sorted(entries, key=lambda c: c.get("priority", 99)):
        if _credential_pool_entry_usable(entry):
            return entry
    return None


def _provider_serves_model(pid: str, model: str) -> bool:
    """Whether a bridge provider's catalog includes this model id."""
    catalog = _models_for_provider(pid)
    if not catalog:
        return True
    return _match_model_for_provider(pid, model) is not None


# Aggregators proxy arbitrary model ids — don't second-guess them via pool routing
# when the local catalog is incomplete (e.g. OpenRouter hosting llama-3-70b).
_AGGREGATOR_PROVIDERS = frozenset({"openrouter", "nous", "minimax"})


def _native_provider_cannot_serve_model(pid: str, model: str) -> bool:
    """True when a native API provider is selected but its catalog lacks this model."""
    if pid in _AGGREGATOR_PROVIDERS or pid not in _PROVIDER_CONFIG:
        return False
    return not _provider_serves_model(pid, model)


# Pool-only providers Hermes CLI commonly uses for models that native APIs
# don't host (deepseek-v4-flash via opencode-zen, etc.). Checked before the
# alphabetical pool scan so crofai doesn't win by sort order.
_POOL_ROUTE_PRIORITY = (
    "opencode-zen",
    "opencode-go",
    "custom:opencode.ai",
    "custom:opencode-go",
)


def _resolve_custom_credential_pool_route(
    *,
    prefer_providers: list[str],
    model: str = "",
) -> Optional[tuple[str, str, str]]:
    """Pick a custom credential_pool provider (opencode-zen, etc.) for routing."""
    pool = _load_credential_pool()
    if not pool:
        return None

    ordered: list[str] = []
    for raw in prefer_providers:
        pid = (raw or "").strip().lower()
        if pid and pid not in _PROVIDER_CONFIG and pid not in ordered:
            ordered.append(pid)
    for pid in _POOL_ROUTE_PRIORITY:
        if pid in pool and pid not in ordered:
            ordered.append(pid)
    for pid in sorted(pool.keys()):
        if pid not in ordered:
            ordered.append(pid)

    model_lower = (model or "").strip().lower()
    best: Optional[tuple[int, str, str, str]] = None
    for pid in ordered:
        if pid in _PROVIDER_CONFIG:
            continue
        entry = _best_usable_credential_pool_entry(pool, pid)
        if not entry:
            continue
        base_url = (entry.get("base_url") or "").strip().rstrip("/")
        if not base_url or any(host in base_url for host in _KNOWN_HOSTS):
            continue
        key = (entry.get("access_token") or "").strip()
        score = 0
        if model_lower and _match_model_for_provider(pid, model):
            score += 100
        if model_lower.startswith("deepseek") and "opencode" in pid:
            score += 80
        if pid in _POOL_ROUTE_PRIORITY:
            score += 10 * (_POOL_ROUTE_PRIORITY.index(pid) + 1)
        candidate = (score, pid, base_url, key)
        if best is None or candidate[0] > best[0]:
            best = candidate
    if not best:
        return None
    _, pid, base_url, key = best
    return (pid, base_url, key)


# ── Provider → model catalog ──────────────────────────────────────────────
# Best-effort import of the canonical Hermes CLI model catalog. Never crash the
# bridge if the import fails (sys.path may not include the agent in all setups).
try:
    import hermes_cli.models as _hermes_cli_models
    _CLI_PROVIDER_MODELS = dict(getattr(_hermes_cli_models, "_PROVIDER_MODELS", {}) or {})
except Exception:
    _CLI_PROVIDER_MODELS = {}

# Bridge provider id → hermes_cli provider id (where they differ)
_BRIDGE_TO_CLI_PROVIDER = {
    "anthropic": "anthropic", "deepseek": "deepseek", "google": "gemini",
    "gemini": "gemini", "openai": "openai-api", "xai": "xai", "kimi": "kimi-coding",
    "zai": "zai", "alibaba": "alibaba", "huggingface": "huggingface",
    "kilocode": "kilocode", "nous": "nous", "minimax": "minimax",
    "xiaomi": "xiaomi", "copilot": "copilot", "stepfun": "stepfun",
    "arcee": "arcee", "gmi": "gmi", "actual": "actual", "nvidia": "nvidia",
    "lmstudio": "lmstudio",
}

# Static fallbacks for bridge ids with no clean cli source.
_STATIC_PROVIDER_MODELS = {
    "openrouter": [
        "anthropic/claude-sonnet-4", "anthropic/claude-opus-4.8",
        "google/gemini-3.1-flash-lite-preview", "deepseek/deepseek-v3.2",
        "meta-llama/llama-4-maverick", "openai/gpt-4.1-mini",
        "x-ai/grok-4.3", "qwen/qwen3-coder", "moonshotai/kimi-k2.6",
    ],
    "groq": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    "mistral": ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "open-mistral-nemo"],
    "cerebras": ["llama-3.3-70b", "qwen-3-32b", "openai/gpt-oss-120b", "llama-3.1-8b"],
    "together": ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo", "mistralai/Mixtral-8x22B-Instruct-v0.1", "deepseek-ai/DeepSeek-V3"],
    "cursor-composer": ["composer-2.5", "composer-2.5-fast", "composer-2"],
}


def _models_for_provider(pid: str) -> list[str]:
    """Return the model id list for a bridge provider id (best-effort)."""
    return _CLI_PROVIDER_MODELS.get(_BRIDGE_TO_CLI_PROVIDER.get(pid, pid)) or _STATIC_PROVIDER_MODELS.get(pid, [])


def _match_model_for_provider(pid: str, model: str) -> Optional[str]:
    """Return this provider's catalog id for `model`, or None if it can't serve it.

    Matches exactly first, then ignores any vendor namespace prefix on either
    side so a bare `deepseek-v4-flash` resolves to an aggregator's namespaced
    `deepseek/deepseek-v4-flash`. Used by credential-aware rerouting so a model
    requested under its native id can be served by a credentialed aggregator.
    """
    models = _models_for_provider(pid)
    if not models:
        return None
    ml = model.lower()
    for m in models:
        if m.lower() == ml:
            return m
    base = ml.split("/")[-1]
    for m in models:
        if m.lower().split("/")[-1] == base:
            return m
    return None


def _read_positive_int_env(name: str, fallback: int) -> int:
    raw_value = os.environ.get(name)
    if not raw_value:
        return fallback
    try:
        parsed_value = int(raw_value)
    except ValueError:
        return fallback
    return parsed_value if parsed_value > 0 else fallback


MAX_AGENT_ITERATIONS = _read_positive_int_env("HERMES_MAX_ITERATIONS", 60)
PASSTHROUGH_TIMEOUT_SECONDS = _read_positive_int_env(
    "HERMES_PROVIDER_TIMEOUT_SECONDS", 5400
)
REQUEST_TIMEOUT_SECONDS = _read_positive_int_env("HERMES_REQUEST_TIMEOUT_SECONDS", 600)

# ── Dynamic model discovery from OpenRouter ─────────────────────────────────
# Fetches available models from OpenRouter API and caches them.
# Falls back to a hardcoded list if the fetch fails.

_FALLBACK_AGENT_MODELS = [
    # Paid models (curated defaults)
    {"id": "anthropic/claude-sonnet-4", "object": "model", "owned_by": "anthropic"},
    {"id": "openai/gpt-4.1-mini", "object": "model", "owned_by": "openai"},
    {"id": "MiniMax-M2.7", "object": "model", "owned_by": "minimax"},
    {"id": "MiniMax-M2.7-highspeed", "object": "model", "owned_by": "minimax"},
    {"id": "google/gemini-3.1-flash-lite-preview", "object": "model", "owned_by": "google"},
    {"id": "google/gemini-2.5-flash", "object": "model", "owned_by": "google"},
    {"id": "deepseek/deepseek-v3.2", "object": "model", "owned_by": "deepseek"},
    {"id": "deepseek/deepseek-chat-v3.1", "object": "model", "owned_by": "deepseek"},
    {"id": "meta-llama/llama-4-maverick", "object": "model", "owned_by": "meta"},
    {"id": "meta-llama/llama-4-scout", "object": "model", "owned_by": "meta"},
    # Free models
    {"id": "deepseek/deepseek-r1-0528", "object": "model", "owned_by": "deepseek"},
    {"id": "google/gemini-2.0-flash-001", "object": "model", "owned_by": "google"},
    {"id": "nousresearch/hermes-3-llama-3.1-405b:free", "object": "model", "owned_by": "nousresearch"},
    {"id": "meta-llama/llama-3.3-70b-instruct:free", "object": "model", "owned_by": "meta"},
    {"id": "qwen/qwen3-next-80b-a3b-instruct:free", "object": "model", "owned_by": "qwen"},
    {"id": "mistralai/mistral-small-3.1-24b-instruct:free", "object": "model", "owned_by": "mistral"},
    # Nous Research models
    {"id": "xiaomi/mimo-v2-pro", "object": "model", "owned_by": "xiaomi"},
]

# MiniMax models aren't on OpenRouter — always include them
_MINIMAX_MODELS = [
    {"id": "MiniMax-M2.7", "object": "model", "owned_by": "minimax"},
    {"id": "MiniMax-M2.7-highspeed", "object": "model", "owned_by": "minimax"},
]

_MODEL_CACHE_TTL_SECONDS = 3600  # 1 hour
_model_cache: Optional[list[dict]] = None
_model_cache_time: float = 0


async def _fetch_openrouter_models() -> list[dict]:
    """Fetch all available models from OpenRouter and format as OpenAI-style model list."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://openrouter.ai/api/v1/models")
            resp.raise_for_status()
            data = resp.json()
            models = []
            for m in data.get("data", []):
                mid = m.get("id", "")
                if not mid:
                    continue
                # Determine owner from model ID prefix
                owner = mid.split("/")[0] if "/" in mid else "unknown"
                models.append({"id": mid, "object": "model", "owned_by": owner})
            return models
    except Exception as e:
        print(f"[bridge] OpenRouter model fetch failed: {e}", file=sys.stderr)
        return []


async def _get_agent_models() -> list[dict]:
    """Return the model list, fetching from OpenRouter if cache is stale."""
    global _model_cache, _model_cache_time
    now = time.time()
    if _model_cache is not None and (now - _model_cache_time) < _MODEL_CACHE_TTL_SECONDS:
        return _model_cache

    openrouter_models = await _fetch_openrouter_models()
    if openrouter_models:
        # Merge: OpenRouter models + always-include MiniMax models
        model_ids = {m["id"] for m in openrouter_models}
        for mm in _MINIMAX_MODELS:
            if mm["id"] not in model_ids:
                openrouter_models.append(mm)
        _model_cache = openrouter_models
        _model_cache_time = now
        print(f"[bridge] Loaded {len(openrouter_models)} models from OpenRouter", file=sys.stderr)
        return _model_cache

    # Fallback to hardcoded list
    _model_cache = list(_FALLBACK_AGENT_MODELS)
    _model_cache_time = now
    print(f"[bridge] Using fallback model list ({len(_model_cache)} models)", file=sys.stderr)
    return _model_cache


def _provider_has_native_credentials(pid: str) -> bool:
    """Whether a provider has its own credentials (excludes OpenClaw gateway token).

    The gateway token can talk to the local OpenClaw gateway, but it is not an
    OpenRouter/Anthropic/etc. key. Callers that demote or advertise provider-
    specific auth must use this rather than `_provider_has_credentials`.
    """
    if pid == "cursor-composer":
        try:
            from cursor_composer_bridge import probe_bridge_health

            if probe_bridge_health().get("reachable"):
                return True
        except Exception:
            pass

    pcfg = _PROVIDER_CONFIG.get(pid, {})
    env_var = pcfg.get("env_var", "")
    auth_provider = pcfg.get("auth_json_provider", pid)
    return bool(
        (env_var and os.environ.get(env_var))
        or _get_credential_pool_key(auth_provider)
        or (pid == "nous" and _get_nous_agent_key())
        or (pid == "openrouter" and _get_openrouter_key_from_hermes_creds())
    )


def _provider_has_credentials(pid: str) -> bool:
    """Whether a configured bridge provider has usable credentials.

    Mirrors the exact credential logic the /health endpoint reports.
    Includes the local OpenClaw gateway token as a last-resort "can serve
    something" signal for generic provider_credentials maps.
    """
    return _provider_has_native_credentials(pid) or bool(_get_local_gateway_key())


def _default_model_credentialed(hermes_home: Optional[Path] = None) -> bool:
    """Whether the agent's configured default model can actually be served.

    `provider_credentials` only covers _PROVIDER_CONFIG, so a default model
    routed through a config.yaml custom base_url — e.g. deepseek-v4-pro via
    opencode-go, which is not a _PROVIDER_CONFIG entry — is invisible there.
    This mirrors the chat route's credential resolution for the configured
    model so /health doesn't under-report what the bridge can serve.

    Profile-aware when `hermes_home` is passed (active profile home).
    Custom base_url endpoints require a real endpoint key — gateway alone
    does not count.
    """
    cfg = _load_cli_model_config(hermes_home)
    if (cfg.get("api_key") or "").strip():
        return True
    if _cli_config_is_custom(cfg):
        return _cli_custom_endpoint_credentialed(cfg, hermes_home)
    provider = (cfg.get("provider") or "").strip().lower()
    if provider in _PROVIDER_CONFIG and _provider_has_native_credentials(provider):
        return True
    if provider and _get_credential_pool_key(provider):
        return True
    return bool(_get_local_gateway_key())


def _provider_ids_for_chat_routing(profile_home: Optional[Path] = None) -> set[str]:
    """Provider ids a chat request may legitimately pin via x-hermes-provider.

    Mirrors what /v1/providers exposes: the built-in _PROVIDER_CONFIG ids, the
    synthetic CLI custom endpoint id (custom:<host> / custom:<name>), and the
    MoA virtual provider. A pin outside this set is stale UI state (the CLI
    config moved on) and must be dropped rather than forwarded to routing —
    forwarding it makes the real agent resolve an unknown custom endpoint and
    400 at OpenRouter with "<host>:<model> is not a valid model ID".
    """
    ids = set(_PROVIDER_CONFIG.keys())
    ids.add(MOA_PROVIDER_ID)
    cfg = _load_cli_model_config(profile_home)
    if _cli_config_is_custom(cfg):
        ids.add(_synthetic_cli_provider_id(cfg))
    return ids
