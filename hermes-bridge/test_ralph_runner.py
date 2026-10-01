"""Tests for server/scripts/run-ralph-round.py report extraction and setup errors."""

import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
RUNNER_PATH = REPO_ROOT / "server" / "scripts" / "run-ralph-round.py"


def _load_runner_module():
    spec = importlib.util.spec_from_file_location("run_ralph_round", RUNNER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TestExtractReport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = _load_runner_module()

    def test_marker_split_across_stream_deltas(self):
        # on_text delivers per-token deltas; the marker can straddle chunks.
        deltas = ["Done.\n", "RALPH_", "REPORT:", '{"status":', ' "complete"', ', "summary": "ok"}', "\n"]
        report = self.runner.extract_report("".join(deltas))
        self.assertEqual(report, {"status": "complete", "summary": "ok"})

    def test_last_marker_wins(self):
        text = 'RALPH_REPORT:{"status":"continue"}\nmore work\nRALPH_REPORT:{"status":"complete"}'
        self.assertEqual(self.runner.extract_report(text)["status"], "complete")

    def test_trailing_code_fence_and_prose_ignored(self):
        text = '```\nRALPH_REPORT: {"status":"blocked","blocker":"x"}\n```\nThanks!'
        self.assertEqual(self.runner.extract_report(text)["status"], "blocked")

    def test_falls_back_to_earlier_marker_when_last_is_malformed(self):
        text = 'RALPH_REPORT:{"status":"continue"}\nRALPH_REPORT:{not json'
        self.assertEqual(self.runner.extract_report(text)["status"], "continue")

    def test_no_marker_or_no_status_returns_none(self):
        self.assertIsNone(self.runner.extract_report("no report here"))
        self.assertIsNone(self.runner.extract_report('RALPH_REPORT:{"summary":"missing status"}'))
        self.assertIsNone(self.runner.extract_report('RALPH_REPORT:["status"]'))


class TestRunnerSetupErrors(unittest.TestCase):
    def _run(self, env_overrides):
        env = {k: v for k, v in os.environ.items() if not k.startswith("RALPH_")}
        env.update(env_overrides)
        return subprocess.run(
            [sys.executable, str(RUNNER_PATH)], env=env, capture_output=True, text=True, timeout=30,
        )

    def test_missing_prompt_exits_2(self):
        proc = self._run({"RALPH_WORKSPACE_DIR": str(REPO_ROOT)})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("RALPH_ERROR:RALPH_ROUND_PROMPT is required", proc.stdout)

    def test_missing_workspace_exits_2(self):
        proc = self._run({"RALPH_ROUND_PROMPT": "x", "RALPH_WORKSPACE_DIR": "/nonexistent/ralph"})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("RALPH_ERROR:RALPH_WORKSPACE_DIR does not exist", proc.stdout)


if __name__ == "__main__":
    unittest.main()
