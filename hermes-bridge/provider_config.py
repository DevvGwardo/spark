import os
import time
from typing import Optional

# ------------------------------------------------------------------
# Circuit breaker for upstream API calls
# ------------------------------------------------------------------
class CircuitBreaker:
    """Prevents cascading failures by opening the circuit after consecutive errors."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failures = 0
        self.last_failure_time: Optional[float] = None
        self.state = "closed"  # closed | open | half-open

    def record_success(self):
        self.failures = 0
        self.state = "closed"

    def record_failure(self):
        self.failures += 1
        self.last_failure_time = time.monotonic()
        if self.failures >= self.failure_threshold:
            self.state = "open"

    def is_available(self) -> bool:
        if self.state == "closed":
            return True
        if self.state == "open":
            if self.last_failure_time and (time.monotonic() - self.last_failure_time) >= self.recovery_timeout:
                self.state = "half-open"
                return True
            return False
        # half-open: allow one attempt
        return True

    def get_state(self) -> str:
        return self.state


# Circuit breakers per upstream provider (created lazily below)
_provider_circuits: dict[str, CircuitBreaker] = {}
_brain_circuit = CircuitBreaker(failure_threshold=3, recovery_timeout=15.0)

def _get_circuit(provider: str) -> CircuitBreaker:
    """Get or create a circuit breaker for a provider."""
    if provider not in _provider_circuits:
        _provider_circuits[provider] = CircuitBreaker(failure_threshold=5, recovery_timeout=30.0)
    return _provider_circuits[provider]

# Backward-compatible circuit references (evaluated at each use via _get_circuit)
_openrouter_circuit_ref = "openrouter"
_minimax_circuit_ref = "minimax"
_nous_circuit_ref = "nous"

# ── Provider base URL registry ──────────────────────────────────────────────
# Mirrors the hermes-agent PROVIDER_REGISTRY in hermes_cli/auth.py.
# Each entry maps a provider_id → (base_url, description, model_prefixes).
# Model prefixes are used for automatic routing when the model name starts with
# one of these prefixes (e.g. "anthropic/" → Anthropic, "deepseek/" → DeepSeek).
# OpenRouter handles everything else as the universal fallback.
MINIMAX_BASE_URL = os.environ.get("MINIMAX_BASE_URL", "https://api.minimax.io/anthropic")

_PROVIDER_CONFIG: dict[str, dict] = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "name": "OpenRouter",
        "model_prefixes": [],  # Default — handles everything not explicitly routed
        "auth_json_provider": "openrouter",
        "env_var": "HERMES_OPENROUTER_KEY",
    },
    "minimax": {
        "base_url": MINIMAX_BASE_URL,
        "name": "MiniMax",
        "model_prefixes": ["MiniMax-", "minimax-"],
        "auth_json_provider": "minimax",
        "env_var": "HERMES_MINIMAX_KEY",
    },
    "nous": {
        "base_url": "https://inference-api.nousresearch.com/v1",
        "name": "Nous Research",
        "model_prefixes": ["nousresearch/", "nous/"],
        "auth_json_provider": "nous",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com",
        "name": "Anthropic",
        "model_prefixes": ["anthropic/", "claude-"],
        "auth_json_provider": "anthropic",
        "env_var": "ANTHROPIC_API_KEY",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "name": "DeepSeek",
        "model_prefixes": ["deepseek/"],
        "auth_json_provider": "deepseek",
        "env_var": "DEEPSEEK_API_KEY",
    },
    "google": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "name": "Google AI Studio",
        "model_prefixes": ["google/", "gemini-"],
        "auth_json_provider": "google",
        "env_var": "GOOGLE_API_KEY",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "name": "OpenAI",
        "model_prefixes": ["openai/", "gpt-", "o1-", "o3-", "o4-"],
        "auth_json_provider": "openai",
        "env_var": "OPENAI_API_KEY",
    },
    "xai": {
        "base_url": "https://api.x.ai/v1",
        "name": "xAI (Grok)",
        "model_prefixes": ["xai/", "grok-"],
        "auth_json_provider": "xai",
        "env_var": "XAI_API_KEY",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "name": "Groq",
        "model_prefixes": ["groq/"],
        "auth_json_provider": "groq",
        "env_var": "GROQ_API_KEY",
    },
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "name": "Mistral",
        "model_prefixes": ["mistral/", "mistral-", "mistralai/", "codestral/", "codestral-"],
        "auth_json_provider": "mistral",
        "env_var": "MISTRAL_API_KEY",
    },
    "kimi": {
        "base_url": "https://api.moonshot.ai/v1",
        "name": "Kimi / Moonshot",
        "model_prefixes": ["kimi/", "kimi-", "moonshot/", "moonshotai/"],
        "auth_json_provider": "kimi-coding",
        "env_var": "KIMI_API_KEY",
    },
    "zai": {
        "base_url": "https://api.z.ai/api/paas/v4",
        "name": "Z.AI / GLM",
        "model_prefixes": ["z-ai/", "glm-", "z.ai/"],
        "auth_json_provider": "zai",
        "env_var": "GLM_API_KEY",
    },
    "alibaba": {
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "name": "Alibaba DashScope",
        "model_prefixes": ["alibaba/", "qwen/"],
        "auth_json_provider": "alibaba",
        "env_var": "DASHSCOPE_API_KEY",
    },
    "huggingface": {
        "base_url": "https://api-inference.huggingface.co/v1",
        "name": "Hugging Face",
        "model_prefixes": ["huggingface/", "hf/"],
        "auth_json_provider": "huggingface",
        "env_var": "HF_TOKEN",
    },
    "kilocode": {
        "base_url": "https://api.kilocode.ai/v1",
        "name": "Kilo Code",
        "model_prefixes": ["kilocode/"],
        "auth_json_provider": "kilocode",
        "env_var": "KILOCODE_API_KEY",
    },
    "cerebras": {
        "base_url": "https://api.cerebras.ai/v1",
        "name": "Cerebras",
        "model_prefixes": ["cerebras/"],
        "auth_json_provider": "cerebras",
        "env_var": "CEREBRAS_API_KEY",
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "name": "Together AI",
        "model_prefixes": ["together/", "together_ai/"],
        "auth_json_provider": "together",
        "env_var": "TOGETHER_API_KEY",
    },
    "cursor-composer": {
        "base_url": os.environ.get("CURSOR_COMPOSER_BRIDGE_URL", "http://127.0.0.1:8790/v1"),
        "name": "Cursor Composer (local bridge)",
        "model_prefixes": ["composer-"],
        "auth_json_provider": "custom:Cursor-Composer",
        "env_var": "CURSOR_API_KEY",
    },
    # --- Providers synced from hermes-agent's PROVIDER_REGISTRY (hermes_cli/auth.py) ---
    # Sync check:
    #   python3 -c "import re;auth=open('~/.hermes/hermes-agent/hermes_cli/auth.py').read();\
    #   ids=set(re.findall(r'id=\"([a-z0-9_]+)\"',auth));main=open('hermes-bridge/main.py').read();\
    #   m=re.search(r'_PROVIDER_CONFIG[^=]*=\s*\{',main);keys=set(re.findall(r'\"([a-z0-9_]+)\":\s*\{',main[m.end():]));\
    #   print(sorted(ids-keys))"
    "xiaomi": {
        "base_url": "https://api.xiaomimimo.com/v1",
        "name": "Xiaomi MiMo",
        "model_prefixes": ["xiaomi/", "mimo"],
        "auth_json_provider": "xiaomi",
        "env_var": "XIAOMI_API_KEY",
    },
    "gemini": {
        # Distinct registry id upstream; same endpoint as google/ai-studio.
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "name": "Google AI Studio (gemini)",
        "model_prefixes": ["gemini/"],
        "auth_json_provider": "gemini",
        "env_var": "GEMINI_API_KEY",
    },
    "lmstudio": {
        "base_url": "http://127.0.0.1:1234/v1",
        "name": "LM Studio (local)",
        "model_prefixes": ["lmstudio/"],
        "auth_json_provider": "lmstudio",
        "env_var": "LM_API_KEY",
    },
    "copilot": {
        "base_url": "https://api.githubcopilot.com",
        "name": "GitHub Copilot",
        "model_prefixes": ["copilot/"],
        "auth_json_provider": "copilot",
        "env_var": "COPILOT_GITHUB_TOKEN",
    },
    "stepfun": {
        "base_url": "https://api.stepfun.ai/step_plan/v1",
        "name": "StepFun Step Plan",
        "model_prefixes": ["stepfun/"],
        "auth_json_provider": "stepfun",
        "env_var": "STEPFUN_API_KEY",
    },
    "arcee": {
        "base_url": "https://api.arcee.ai/api/v1",
        "name": "Arcee AI",
        "model_prefixes": ["arcee/"],
        "auth_json_provider": "arcee",
        "env_var": "ARCEEAI_API_KEY",
    },
    "gmi": {
        "base_url": "https://api.gmi-serving.com/v1",
        "name": "GMI Cloud",
        "model_prefixes": ["gmi/"],
        "auth_json_provider": "gmi",
        "env_var": "GMI_API_KEY",
    },
    "actual": {
        "base_url": "https://api.actual.inc/v1",
        "name": "Actual Computer",
        "model_prefixes": ["actual/"],
        "auth_json_provider": "actual",
        "env_var": "ACTUAL_API_KEY",
    },
    "nvidia": {
        "base_url": "https://integrate.api.nvidia.com/v1",
        "name": "NVIDIA NIM",
        "model_prefixes": ["nvidia/", "nvidia-nim/"],
        "auth_json_provider": "nvidia",
        "env_var": "NVIDIA_API_KEY",
    },
    # aws_sdk / vertex auth types — no bearer-token proxying via the bridge;
    # registered so model-prefix routing and /health credential reporting
    # recognize them instead of falling through to OpenRouter with a wrong key.
    "bedrock": {
        "base_url": "https://bedrock-runtime.us-east-1.amazonaws.com",
        "name": "AWS Bedrock (no bridge proxying — SDK auth)",
        "model_prefixes": ["bedrock/"],
        "auth_json_provider": "bedrock",
    },
    "vertex": {
        "base_url": "",
        "name": "Google Vertex AI (no bridge proxying — ADC auth)",
        "model_prefixes": ["vertex/"],
        "auth_json_provider": "vertex",
    },
}

# Build a reverse lookup: model_prefix → provider_id
_MODEL_PREFIX_TO_PROVIDER: dict[str, str] = {}
for _pid, _cfg in _PROVIDER_CONFIG.items():
    for _pfx in _cfg.get("model_prefixes", []):
        _MODEL_PREFIX_TO_PROVIDER[_pfx] = _pid

# Known hosts for custom base_url detection
def _known_host_label(hostname: str) -> str:
    """Collapse a provider's public host to its matchable form.

    Strips only a LEADING ``api.`` / ``www.`` label. ``str.replace`` also
    mangled hosts where those labels appear mid-name — e.g. Nous's
    ``inference-api.nousresearch.com`` became ``inference-nousresearch.com``,
    an entry that never substring-matches the real base_url, so the native
    nous config was misclassified as a custom endpoint (bogus synthetic
    ``custom:<host>`` provider row + stale UI pins routing to OpenRouter).
    """
    for prefix in ("api.", "www."):
        if hostname.startswith(prefix):
            return hostname[len(prefix):]
    return hostname


_KNOWN_HOSTS: tuple[str, ...] = tuple(
    # Filter empty strings: a provider entry with base_url "" (e.g. vertex,
    # resolved at request time) would otherwise yield "" as a host and
    # `"" in url` is always True — silently marking every base_url "known"
    # and killing the cli_is_custom passthrough path.
    h
    for h in {
        _known_host_label(u.split("://")[-1].split("/")[0])
        for u in [_c["base_url"] for _c in _PROVIDER_CONFIG.values()]
    }
    if h
)

# Backward-compatible constants
MINIMAX_MODEL_PREFIX = "MiniMax-"
NOUS_MODEL_PREFIX = "nousresearch/"
NOUS_BASE_URL = _PROVIDER_CONFIG["nous"]["base_url"]

# Vision-capable models — these support image input (base64, URLs, or multimodal content)
# Models NOT in this list will have image content stripped before being sent upstream
_VISION_CAPABLE_MODELS: set[str] = {
    # MiniMax models with vision support
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    # Claude Opus 4 and Sonnet 4 support vision
    "anthropic/claude-opus-4-5",
    "anthropic/claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    # Gemini 2.x flash variants support vision
    "google/gemini-2.0-flash-exp",
    "google/gemini-3.1-flash-preview",
    "gemini-2.0-flash-exp",
    "gemini-3.1-flash-preview",
    # GPT-4o and vision models
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "gpt-4o",
    "gpt-4o-mini",
    # Nous Hermès variants with multimodal
    "nousresearch/hermes-3-llama-3.3-70b",
}


def _model_supports_vision(model: str) -> bool:
    """Check if a model supports image/vision input."""
    if model in _VISION_CAPABLE_MODELS:
        return True
    model_lower = model.lower()
    for capable in _VISION_CAPABLE_MODELS:
        if capable.lower() in model_lower or model_lower in capable.lower():
            return True
    if model_lower.startswith("claude") and "sonnet" in model_lower:
        return True
    if model_lower.startswith("gpt-4o"):
        return True
    if "gemini-2" in model_lower or "gemini-3" in model_lower:
        return True
    if "minimax-m2" in model_lower:
        return True
    return False
