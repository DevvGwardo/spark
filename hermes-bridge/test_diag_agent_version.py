"""/diag reports the installed hermes-agent release (spec 3.5 follow-up).

server/lib/hermes-agent-update.ts restartBridgeAndVerify reads
``hermes_agent_version`` (e.g. "2026.9.24") and compares it with the tag the
update moved to (``v2026.9.24``).
"""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from routes import health  # noqa: E402


class _Req:
    headers: dict = {}


def _agent_dir(tmp: str, init_text: str | None) -> str:
    root = Path(tmp) / "hermes-agent"
    (root / "hermes_cli").mkdir(parents=True)
    if init_text is not None:
        (root / "hermes_cli" / "__init__.py").write_text(init_text)
    return str(root)


class HermesAgentVersionTests(unittest.TestCase):
    def setUp(self):
        health._hermes_agent_version.cache_clear()

    def tearDown(self):
        health._hermes_agent_version.cache_clear()

    def test_reads_release_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = _agent_dir(tmp, '"""doc"""\nimport sys\n\n__release_date__ = "2026.9.24"\n__version__: str\n')
            with patch.dict(os.environ, {"HERMES_AGENT_DIR": d}):
                payload = asyncio.run(health.diag(_Req()))
        self.assertEqual(payload["hermes_agent_version"], "2026.9.24")

    def test_null_when_not_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"HERMES_AGENT_DIR": str(Path(tmp) / "missing")}):
                payload = asyncio.run(health.diag(_Req()))
        self.assertIn("hermes_agent_version", payload)
        self.assertIsNone(payload["hermes_agent_version"])

    def test_null_when_no_release_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = _agent_dir(tmp, "__version__ = '0.0.0'\n")
            with patch.dict(os.environ, {"HERMES_AGENT_DIR": d}):
                self.assertIsNone(health._hermes_agent_version())

    def test_cached_per_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = _agent_dir(tmp, '__release_date__ = "2026.7.20"\n')
            with patch.dict(os.environ, {"HERMES_AGENT_DIR": d}):
                self.assertEqual(health._hermes_agent_version(), "2026.7.20")
                (Path(d) / "hermes_cli" / "__init__.py").write_text('__release_date__ = "2026.9.24"\n')
                self.assertEqual(health._hermes_agent_version(), "2026.7.20")


if __name__ == "__main__":
    unittest.main()
