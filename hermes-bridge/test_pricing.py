"""Unit tests for the per-provider pricing table (pricing.py)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import pricing

# An opaque aggregator alias with no family hint (stands in for real-world names
# like the "big-pickle"-style codenames seen in the session store).
OPAQUE_ALIAS = "zz-opaque-codename-x"


class PriceResolutionTests(unittest.TestCase):
    def test_claude_families(self):
        self.assertEqual(
            pricing.price_for("anthropic/claude-opus-4-5"),
            pricing.ModelPrice(15.0, 75.0, cache_read=1.5, cache_write=18.75),
        )
        self.assertEqual(pricing.price_for("claude-sonnet-4-5").output, 15.0)
        self.assertEqual(pricing.price_for("claude-haiku").input, 0.80)

    def test_openai_tiers(self):
        self.assertEqual(pricing.price_for("gpt-5.4"), pricing.ModelPrice(1.25, 10.0))
        self.assertEqual(pricing.price_for("gpt-4o-mini").input, 0.15)
        self.assertEqual(pricing.price_for("o3-pro").output, 60.0)

    def test_deepseek_flash_cheaper_than_pro(self):
        flash = pricing.price_for("deepseek-v4-flash")
        pro = pricing.price_for("deepseek-v4-pro")
        self.assertLess(flash.output, pro.output)
        # cache reads are discounted vs input
        self.assertLess(pro.rate_cache_read(), pro.input)

    def test_free_models_cost_nothing(self):
        for name in ("stepfun/step-3.5-flash:free", "minimax-m2.5-free", "tencent/hy3-preview:free"):
            price = pricing.price_for(name)
            self.assertEqual((price.input, price.output), (0.0, 0.0), name)

    def test_gemini_flash_lite_is_cheapest_gemini(self):
        self.assertLess(
            pricing.price_for("gemini-3.1-flash-lite-preview").input,
            pricing.price_for("gemini-3-flash-preview").input,
        )

    def test_unpriceable_opaque_alias_returns_none(self):
        self.assertIsNone(pricing.price_for(OPAQUE_ALIAS, "custom"))
        self.assertIsNone(pricing.price_for("openrouter/elephant-alpha", "openrouter"))

    def test_provider_default_when_name_has_no_rule(self):
        # No model rule matches, but billing_provider identifies a real provider.
        self.assertEqual(
            pricing.price_for("some-internal-codename", "anthropic"),
            pricing.PROVIDER_DEFAULTS["anthropic"],
        )

    def test_resolve_provider_aliases_and_inference(self):
        self.assertEqual(pricing.resolve_provider("gemini-3-flash", "gemini"), "google")
        self.assertEqual(pricing.resolve_provider("deepseek-v4-pro", "custom"), "deepseek")
        self.assertEqual(pricing.resolve_provider(OPAQUE_ALIAS, "custom"), "unknown")


class CostMathTests(unittest.TestCase):
    def test_cost_for_tokens(self):
        price = pricing.ModelPrice(input=1.0, output=2.0, cache_read=0.1, cache_write=1.25)
        # 1M input @ $1 + 1M output @ $2 = $3
        self.assertAlmostEqual(
            pricing.cost_for_tokens(price, input_tokens=1_000_000, output_tokens=1_000_000), 3.0
        )
        # cache + reasoning (reasoning billed as output)
        cost = pricing.cost_for_tokens(
            price, cache_read_tokens=1_000_000, cache_write_tokens=1_000_000, reasoning_tokens=1_000_000
        )
        self.assertAlmostEqual(cost, 0.1 + 1.25 + 2.0)

    def test_sanity_ceiling_is_reasonable(self):
        # Above the priciest mainstream output rate, below the corrupt-data range.
        self.assertGreater(pricing.MAX_PLAUSIBLE_RATE_PER_MTOK, 75.0)
        self.assertLess(pricing.MAX_PLAUSIBLE_RATE_PER_MTOK, 1000.0)


if __name__ == "__main__":
    unittest.main()
