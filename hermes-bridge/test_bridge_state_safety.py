"""Spec 5.5 (G16): bounded session tracker and thread-safe bridge counters."""
import os
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import bridge_state  # noqa: E402
from session_tracker import _BoundedSessions  # noqa: E402


def _entry(status="completed", age_s=0.0):
    stamp = (datetime.now(timezone.utc) - timedelta(seconds=age_s)).isoformat()
    return {"status": status, "updated_at": stamp, "created_at": stamp}


class BoundedSessionsTests(unittest.TestCase):
    def test_count_cap_evicts_least_recently_updated_finished_first(self):
        s = _BoundedSessions(max_entries=3, ttl=3600, active_ttl=7200)
        s["old-active"] = _entry("active", age_s=50)
        s["old-done"] = _entry("completed", age_s=40)
        s["mid-done"] = _entry("completed", age_s=30)
        s["new"] = _entry("active", age_s=0)
        self.assertEqual(set(s), {"old-active", "mid-done", "new"})
        s["newer"] = _entry("active", age_s=0)
        self.assertEqual(set(s), {"old-active", "new", "newer"})

    def test_ttl_expires_finished_and_stuck_active(self):
        s = _BoundedSessions(max_entries=100, ttl=60, active_ttl=600)
        s["stale-done"] = _entry("error", age_s=120)
        s["fresh-active"] = _entry("active", age_s=120)
        s["stuck-active"] = _entry("active", age_s=1200)
        s["trigger"] = _entry()
        self.assertEqual(set(s), {"fresh-active", "trigger"})

    def test_inserted_key_is_never_evicted(self):
        s = _BoundedSessions(max_entries=1, ttl=1, active_ttl=1)
        s["a"] = _entry(age_s=10)
        s["b"] = _entry(age_s=10)
        self.assertEqual(set(s), {"b"})


class MetricsCounterTests(unittest.TestCase):
    def test_concurrent_updates_are_not_lost(self):
        with patch.object(bridge_state.brain_client, "_brain_set"):
            before_total = bridge_state._bridge_total_requests
            before_errors = bridge_state._bridge_error_count
            n_threads, per_thread = 8, 250

            def work():
                for _ in range(per_thread):
                    bridge_state._mark_request_started(
                        model="m", enabled_toolsets=[], repo_mode=False,
                        repo_owner="", repo_name="", repo_edit_intent=False,
                    )
                    bridge_state._mark_request_finished(model="m", success=False)

            threads = [threading.Thread(target=work) for _ in range(n_threads)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        n = n_threads * per_thread
        self.assertEqual(bridge_state._bridge_total_requests - before_total, n)
        self.assertEqual(bridge_state._bridge_error_count - before_errors, n)
        self.assertEqual(bridge_state._bridge_active_requests, 0)

    def test_no_duplicate_counter_definitions_in_main(self):
        src = open(os.path.join(os.path.dirname(__file__), "main.py")).read()
        self.assertNotIn("_bridge_iterations_total", src)
        self.assertNotIn("_bridge_request_count", src)


if __name__ == "__main__":
    unittest.main()
