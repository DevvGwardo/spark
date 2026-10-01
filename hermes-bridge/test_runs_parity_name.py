"""Regression: runs fallback reason path must use _runs_parity (not a missing name)."""
from __future__ import annotations

import unittest
from pathlib import Path


class RunsParityNameTests(unittest.TestCase):
    def test_main_uses_defined_runs_parity_name(self):
        src = (Path(__file__).resolve().parent / "chat_impl.py").read_text(encoding="utf-8")  # moved from main.py (spec 4.1)
        self.assertNotIn("_runs_parity_available", src)
        self.assertIn("runs_parity_available=_runs_parity,", src)


if __name__ == "__main__":
    unittest.main()
