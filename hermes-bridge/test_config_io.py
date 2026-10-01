"""Spec 5.4 (G12): atomic, locked config writes with bounded backups."""
import builtins
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import config_io  # noqa: E402
from bridge_errors import BridgeError  # noqa: E402
from routes import mcp as mcp_routes  # noqa: E402

YAML_WITH_COMMENTS = """# top comment
model:
  default: foo  # inline comment
mcp_servers: {}
"""


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.path = self.dir / "config.yaml"

    def tearDown(self):
        self._tmp.cleanup()

    def test_keeps_at_most_five_backups(self):
        self.path.write_text("v0\n")
        for i in range(1, 9):
            config_io.atomic_write_text(self.path, f"v{i}\n")
        backups = sorted(self.dir.glob("config.yaml.bak-*"))
        self.assertEqual(len(backups), config_io.BACKUP_KEEP)
        # The newest five previous versions are the ones kept.
        self.assertEqual({b.read_text() for b in backups}, {f"v{i}\n" for i in range(3, 8)})
        self.assertEqual(self.path.read_text(), "v8\n")

    def test_failed_write_leaves_original_intact_and_no_temp_files(self):
        self.path.write_text("original\n")
        with patch.object(config_io.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                config_io.atomic_write_text(self.path, "new\n", backup=False)
        self.assertEqual(self.path.read_text(), "original\n")
        self.assertEqual([p.name for p in self.dir.iterdir() if p.suffix == ".tmp"], [])

    def test_preserves_mode_and_new_file_mode(self):
        self.path.write_text("x\n")
        os.chmod(self.path, 0o640)
        config_io.atomic_write_text(self.path, "y\n", backup=False)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o640)
        env = self.dir / ".env"
        config_io.atomic_write_text(env, "A=1\n", backup=False, mode=0o600)
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)

    @unittest.skipIf(config_io._fcntl is None, "no fcntl on this platform")
    def test_file_lock_excludes_another_holder(self):
        order = []
        entered = threading.Event()

        def holder():
            with config_io.file_lock(self.path):
                order.append("a-in")
                entered.set()
                time.sleep(0.2)
                order.append("a-out")

        t = threading.Thread(target=holder)
        t.start()
        entered.wait()
        with config_io.file_lock(self.path):
            order.append("b-in")
        t.join()
        self.assertEqual(order, ["a-in", "a-out", "b-in"])

    def test_edit_yaml_preserves_comments(self):
        self.path.write_text(YAML_WITH_COMMENTS)
        with config_io.edit_yaml(self.path) as data:
            data["model"]["default"] = "bar"
        text = self.path.read_text()
        self.assertIn("# top comment", text)
        self.assertIn("# inline comment", text)
        self.assertIn("default: bar", text)

    def test_edit_yaml_exception_writes_nothing(self):
        self.path.write_text(YAML_WITH_COMMENTS)
        with self.assertRaises(RuntimeError):
            with config_io.edit_yaml(self.path) as data:
                data["model"]["default"] = "bar"
                raise RuntimeError("abort")
        self.assertEqual(self.path.read_text(), YAML_WITH_COMMENTS)

    def test_missing_ruamel_fails_loudly(self):
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("ruamel"):
                raise ImportError("no ruamel")
            return real_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", fake_import):
            with self.assertRaises(config_io.ConfigWriteError):
                config_io.require_ruamel()


class McpConfigEditableTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.path = mcp_routes._hermes_config_path(self.home)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(YAML_WITH_COMMENTS)

    def tearDown(self):
        self._tmp.cleanup()

    def test_round_trip_keeps_comments_and_backs_up(self):
        dump, data = mcp_routes._load_hermes_config_editable(self.home)
        data["mcp_servers"]["x"] = {"command": "npx", "enabled": True}
        dump()
        text = self.path.read_text()
        self.assertIn("# top comment", text)
        self.assertIn("x:", text)
        self.assertEqual(len(list(self.path.parent.glob("config.yaml.bak-*"))), 1)

    def test_concurrent_external_change_is_refused_not_clobbered(self):
        dump, data = mcp_routes._load_hermes_config_editable(self.home)
        data["mcp_servers"]["x"] = {"command": "npx"}
        self.path.write_text(YAML_WITH_COMMENTS + "other: edit\n")
        with self.assertRaises(BridgeError) as ctx:
            dump()
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("other: edit", self.path.read_text())

    def test_missing_ruamel_raises_bridge_error(self):
        with patch.object(
            config_io, "require_ruamel", side_effect=config_io.ConfigWriteError("ruamel.yaml is required")
        ):
            with self.assertRaises(BridgeError) as ctx:
                mcp_routes._load_hermes_config_editable(self.home)
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertIn("ruamel", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
