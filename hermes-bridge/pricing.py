"""Per-provider / per-model token pricing for Hermes cost estimation.

The Hermes session store records token counts per session, but its stored
``estimated_cost_usd`` is unreliable: upstream ``/models`` price feeds report
wildly inconsistent per-token rates (some imply tens of thousands of dollars per
million tokens), many providers report nothing at all, and ``actual_cost_usd`` is
effectively never populated. Summing those values produced a meaningless headline
"Cost" in the Usage panel.

This module recomputes cost from the recorded token counts using a curated,
versioned price table, so the figure reflects realistic per-provider spend.

All prices are **USD per 1,000,000 tokens** (list / reference prices). They are an
estimate — alias models routed through aggregators are priced at their underlying
family's reference rate. Bump ``PRICING_VERSION`` whenever the table changes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

PRICING_VERSION = "2026-06-01"

# Any session whose *stored* estimate implies a blended rate above this (USD per
# 1M tokens) is treated as corrupt and ignored when falling back to it. The
# priciest mainstream model (Claude Opus output) is $75/Mtok, so 100 is a safe
# ceiling that still rejects the garbage outliers (which imply $1,000s/Mtok).
MAX_PLAUSIBLE_RATE_PER_MTOK = 100.0


@dataclass(frozen=True)
class ModelPrice:
    """Reference price in USD per 1,000,000 tokens."""

    input: float
    output: float
    cache_read: Optional[float] = None   # default: 10% of input (prompt-cache hit)
    cache_write: Optional[float] = None  # default: 125% of input (prompt-cache write)

    def rate_cache_read(self) -> float:
        return self.cache_read if self.cache_read is not None else self.input * 0.10

    def rate_cache_write(self) -> float:
        return self.cache_write if self.cache_write is not None else self.input * 1.25


# Real first-party providers we can price by a sensible default. Aggregators /
# passthroughs (openrouter, custom, crofai, opencode-go, groq, cerebras, …) are
# intentionally absent: their cost depends on the underlying model, which we match
# by name instead.
PROVIDER_DEFAULTS: dict[str, ModelPrice] = {
    "anthropic": ModelPrice(3.0, 15.0),
    "openai": ModelPrice(1.25, 10.0),
    "google": ModelPrice(0.10, 0.40),
    "deepseek": ModelPrice(0.27, 1.10, cache_read=0.07),
    "xai": ModelPrice(3.0, 15.0),
    "mistral": ModelPrice(0.40, 2.0),
    "kimi": ModelPrice(0.60, 2.50),
    "zai": ModelPrice(0.60, 2.20),
    "alibaba": ModelPrice(0.40, 1.20),
    "minimax": ModelPrice(0.30, 1.20),
    "nous": ModelPrice(0.90, 0.90),
}

# Map a billing_provider string (possibly "custom:foo" or "gemini") to a real
# provider id we can default-price. Aggregators map to None.
_BILLING_PROVIDER_ALIASES: dict[str, str] = {
    "gemini": "google",
    "openai-codex": "openai",
    "google": "google",
    "anthropic": "anthropic",
    "deepseek": "deepseek",
    "xai": "xai",
    "mistral": "mistral",
    "kimi": "kimi",
    "kimi-coding": "kimi",
    "zai": "zai",
    "alibaba": "alibaba",
    "minimax": "minimax",
    "nous": "nous",
}

# Infer a provider from the model name when billing_provider is an aggregator.
# Order matters: more specific prefixes first. Mirrors main._PROVIDER_CONFIG.
_MODEL_NAME_PROVIDER: tuple[tuple[str, str], ...] = (
    ("claude", "anthropic"),
    ("anthropic/", "anthropic"),
    ("gpt-", "openai"),
    ("o1-", "openai"),
    ("o3-", "openai"),
    ("o4-", "openai"),
    ("openai/", "openai"),
    ("gemini", "google"),
    ("google/", "google"),
    ("deepseek", "deepseek"),
    ("grok", "xai"),
    ("xai/", "xai"),
    ("codestral", "mistral"),
    ("mistral", "mistral"),
    ("kimi", "kimi"),
    ("moonshot", "kimi"),
    ("glm", "zai"),
    ("z-ai/", "zai"),
    ("z.ai/", "zai"),
    ("qwen", "alibaba"),
    ("alibaba/", "alibaba"),
    ("minimax", "minimax"),
    ("nous", "nous"),
    ("hermes-", "nous"),
)

# Model-name pricing rules, tried in order; first regex match wins. Patterns run
# against the lowercased model name. These take precedence over provider defaults
# so aggregator-routed aliases (e.g. "deepseek-v4-pro" billed as "custom") are
# priced at their family rate rather than guessed from the billing provider.
_MODEL_RULES: tuple[tuple[re.Pattern, ModelPrice], ...] = (
    # Free tiers (":free" / "-free" suffixes) cost nothing.
    (re.compile(r"(:free\b|-free\b|\bfree$)"), ModelPrice(0.0, 0.0, 0.0, 0.0)),

    # Anthropic Claude
    (re.compile(r"opus"), ModelPrice(15.0, 75.0, cache_read=1.5, cache_write=18.75)),
    (re.compile(r"sonnet"), ModelPrice(3.0, 15.0, cache_read=0.30, cache_write=3.75)),
    (re.compile(r"haiku"), ModelPrice(0.80, 4.0, cache_read=0.08, cache_write=1.0)),
    (re.compile(r"claude"), ModelPrice(3.0, 15.0, cache_read=0.30, cache_write=3.75)),

    # OpenAI
    (re.compile(r"gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini|gpt-5\.\d+-mini"), ModelPrice(0.15, 0.60)),
    (re.compile(r"gpt-4o|gpt-4\.1"), ModelPrice(2.5, 10.0)),
    (re.compile(r"\bo[134]\b|^o[134]-|o1-|o3-|o4-"), ModelPrice(15.0, 60.0)),
    (re.compile(r"gpt-5|gpt-"), ModelPrice(1.25, 10.0)),

    # Google Gemini (must be gemini-qualified — a bare "flash" belongs to other
    # providers, e.g. deepseek-v4-flash / step-3.5-flash).
    (re.compile(r"gemini.*flash-lite"), ModelPrice(0.0375, 0.15)),
    (re.compile(r"gemini.*flash"), ModelPrice(0.075, 0.30)),
    (re.compile(r"gemini.*pro"), ModelPrice(1.25, 5.0)),
    (re.compile(r"gemini"), ModelPrice(0.10, 0.40)),

    # DeepSeek family
    (re.compile(r"deepseek.*flash"), ModelPrice(0.14, 0.28, cache_read=0.014)),
    (re.compile(r"deepseek.*(pro|reasoner|precision|r1)"), ModelPrice(0.55, 2.19, cache_read=0.14)),
    (re.compile(r"deepseek"), ModelPrice(0.27, 1.10, cache_read=0.07)),

    # Others observed in the wild
    (re.compile(r"qwen"), ModelPrice(0.40, 1.20)),
    (re.compile(r"glm"), ModelPrice(0.60, 2.20)),
    (re.compile(r"kimi|moonshot|\bk2\b|k2[.-]"), ModelPrice(0.60, 2.50)),
    (re.compile(r"minimax|m2\.\d"), ModelPrice(0.30, 1.20)),
    (re.compile(r"\bmimo"), ModelPrice(0.30, 1.0)),
    (re.compile(r"grok"), ModelPrice(3.0, 15.0)),
    (re.compile(r"mistral|codestral"), ModelPrice(0.40, 2.0)),
    (re.compile(r"step(fun)?|step-\d"), ModelPrice(0.30, 1.20)),
    (re.compile(r"hunyuan|\bhy\d|tencent"), ModelPrice(0.30, 1.20)),
    (re.compile(r"llama"), ModelPrice(0.20, 0.60)),
    (re.compile(r"hermes|nous"), ModelPrice(0.90, 0.90)),
)


def resolve_provider(model: Optional[str], billing_provider: Optional[str]) -> str:
    """Best-effort provider id for a session. Returns 'unknown' if undeterminable."""
    bp = (billing_provider or "").strip().lower()
    if bp:
        base = bp.split(":", 1)[0]
        if base in PROVIDER_DEFAULTS:
            return base
        if base in _BILLING_PROVIDER_ALIASES:
            return _BILLING_PROVIDER_ALIASES[base]
    name = (model or "").strip().lower()
    for prefix, provider in _MODEL_NAME_PROVIDER:
        if name.startswith(prefix) or prefix in name:
            return provider
    return "unknown"


def price_for(model: Optional[str], billing_provider: Optional[str] = None) -> Optional[ModelPrice]:
    """Resolve a ModelPrice for a session, or None if the model can't be priced.

    Model-name rules win first (so aggregator aliases are priced by family); then a
    provider default if the provider is identifiable.
    """
    name = (model or "").strip().lower()
    for pattern, price in _MODEL_RULES:
        if pattern.search(name):
            return price
    provider = resolve_provider(model, billing_provider)
    return PROVIDER_DEFAULTS.get(provider)


def cost_for_tokens(
    price: ModelPrice,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    reasoning_tokens: int = 0,
) -> float:
    """USD cost for a bundle of tokens at the given price (reasoning billed as output)."""
    return (
        input_tokens * price.input
        + output_tokens * price.output
        + cache_read_tokens * price.rate_cache_read()
        + cache_write_tokens * price.rate_cache_write()
        + reasoning_tokens * price.output
    ) / 1_000_000.0
