"""Regression: runs fallback reason path must use _runs_parity (not a missing name)."""
from __future__ import annotations

import unittest
from pathlib import Path


class RunsParityNameTests(unittest.TestCase):
    def test_main_uses_defined_runs_parity_name(self):
        # main.py → chat_impl.py (spec 4.1) → chat_transports/runs_plan.py (spec 4.2)
        src = (Path(__file__).resolve().parent / "chat_transports" / "runs_plan.py").read_text(encoding="utf-8")
        self.assertNotIn("_runs_parity_available", src)
        self.assertIn("runs_parity_available=_runs_parity,", src)


if __name__ == "__main__":
    unittest.main()
