"""Spec 5.6 (G15): one cron code path; legacy data/cron_jobs.json migrates into hermes once."""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import routes.cron as cron_routes  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "cron" / "legacy_cron_jobs.json"


class _FakeHermesCron:
    """In-memory stand-in for hermes cron.jobs."""

    def __init__(self, fail_names=()):
        self.jobs: dict[str, dict] = {}
        self.fail_names = set(fail_names)
        self._n = 0

    def create_job(self, *, prompt, schedule, name=None, deliver=None, origin=None):
        if name in self.fail_names:
            raise RuntimeError(f"cannot create {name}")
        self._n += 1
        job_id = f"h{self._n}"
        self.jobs[job_id] = {"id": job_id, "name": name, "prompt": prompt,
                             "schedule_display": schedule, "enabled": True, "state": "scheduled"}
        return dict(self.jobs[job_id])

    def pause_job(self, job_id):
        self.jobs[job_id].update(enabled=False, state="paused")
        return dict(self.jobs[job_id])

    def list_jobs(self, include_disabled=False):
        return [dict(j) for j in self.jobs.values() if include_disabled or j["enabled"]]

    def patches(self):
        return [
            patch.object(cron_routes, "_hermes_create_job", self.create_job),
            patch.object(cron_routes, "_hermes_pause_job", self.pause_job),
            patch.object(cron_routes, "_hermes_list_jobs", self.list_jobs),
        ]


class LegacyCronMigrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.jobs_file = self.dir / "cron_jobs.json"
        self.history_file = self.dir / "cron_history.json"
        shutil.copy(FIXTURE, self.jobs_file)
        self.history_file.write_text(json.dumps({"a1b2c3d4": [{"run_id": "r1"}]}))

    def tearDown(self):
        self._tmp.cleanup()

    def _migrate(self, fake):
        ps = fake.patches()
        for p in ps:
            p.start()
        try:
            return cron_routes._migrate_legacy_cron_jobs(str(self.jobs_file), str(self.history_file))
        finally:
            for p in ps:
                p.stop()

    def test_migrates_every_valid_job_and_marks_file(self):
        fake = _FakeHermesCron()
        result = self._migrate(fake)
        self.assertEqual(result, {"migrated": 2, "skipped": 1, "failed": 0, "marked": True})
        by_name = {j["name"]: j for j in fake.jobs.values()}
        self.assertEqual(set(by_name), {"daily-digest", "job-e5f6a7b8"})
        self.assertEqual(by_name["daily-digest"]["schedule_display"], "0 9 * * *")
        self.assertEqual(by_name["daily-digest"]["prompt"], "Summarize yesterday's merged PRs.")
        self.assertTrue(by_name["daily-digest"]["enabled"])
        # Paused legacy jobs stay paused.
        self.assertFalse(by_name["job-e5f6a7b8"]["enabled"])
        # The original data is renamed, not deleted.
        self.assertFalse(self.jobs_file.exists())
        migrated = Path(str(self.jobs_file) + ".migrated")
        self.assertEqual(json.loads(migrated.read_text()), json.loads(FIXTURE.read_text()))
        self.assertTrue(Path(str(self.history_file) + ".migrated").exists())

    def test_idempotent_across_restarts(self):
        fake = _FakeHermesCron()
        self._migrate(fake)
        # Second start: file already marked → nothing happens.
        self.assertEqual(self._migrate(fake)["migrated"], 0)
        # Even if the file comes back (e.g. restored), jobs are not duplicated.
        shutil.copy(FIXTURE, self.jobs_file)
        result = self._migrate(fake)
        self.assertEqual(result["migrated"], 0)
        self.assertEqual(len(fake.jobs), 2)

    def test_partial_failure_keeps_file_and_retry_completes_without_duplicates(self):
        flaky = _FakeHermesCron(fail_names={"job-e5f6a7b8"})
        result = self._migrate(flaky)
        self.assertEqual((result["migrated"], result["failed"], result["marked"]), (1, 1, False))
        self.assertTrue(self.jobs_file.exists(), "legacy file must stay until every job migrated")
        flaky.fail_names.clear()
        result = self._migrate(flaky)
        self.assertEqual((result["migrated"], result["failed"], result["marked"]), (1, 0, True))
        self.assertEqual(sorted(j["name"] for j in flaky.jobs.values()), ["daily-digest", "job-e5f6a7b8"])

    def test_unparseable_file_is_left_alone(self):
        self.jobs_file.write_text("{not json")
        fake = _FakeHermesCron()
        result = self._migrate(fake)
        self.assertEqual(result["marked"], False)
        self.assertEqual(self.jobs_file.read_text(), "{not json")
        self.assertEqual(fake.jobs, {})

    def test_no_legacy_file_is_a_noop(self):
        self.jobs_file.unlink()
        self.assertEqual(self._migrate(_FakeHermesCron())["migrated"], 0)


class SingleCronPathTests(unittest.TestCase):
    def test_routes_return_503_when_hermes_cron_unavailable(self):
        with patch.object(cron_routes, "_HERMES_CRON_AVAILABLE", False):
            resp = asyncio.run(cron_routes.delete_cron_job("abc"))
        self.assertEqual(resp.status_code, 503)
        # Other suites stub fastapi's JSONResponse (``content`` instead of ``body``).
        body = getattr(resp, "body", None) or str(getattr(resp, "content", "")).encode()
        self.assertIn(b"Hermes cron backend unavailable", body)

    def test_scheduler_not_started_without_backend(self):
        with patch.object(cron_routes, "_HERMES_CRON_AVAILABLE", False):
            self.assertIsNone(cron_routes._start_cron_scheduler())

    def test_bridge_local_store_is_gone(self):
        for name in ("_cron_jobs", "_load_cron_data", "_save_cron_jobs", "_run_cron_agent", "_compute_next_run"):
            self.assertFalse(hasattr(cron_routes, name), name)

    def test_tick_runs_off_the_event_loop(self):
        calls = []

        async def run():
            loop_thread = __import__("threading").get_ident()

            def tick():
                calls.append(__import__("threading").get_ident() != loop_thread)
                raise asyncio.CancelledError  # stop the loop after one tick

            with patch.object(cron_routes, "_cron_startup", lambda: None), patch.object(
                cron_routes, "_run_hermes_tick_now", tick
            ):
                with self.assertRaises(asyncio.CancelledError):
                    await cron_routes._cron_scheduler_loop()

        asyncio.run(run())
        self.assertEqual(calls, [True])


if __name__ == "__main__":
    unittest.main()
