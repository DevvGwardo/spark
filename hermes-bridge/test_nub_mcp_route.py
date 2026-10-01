"""Spark's nub MCP entry: the bridge points Hermes's config.yaml at Spark's
loopback endpoint, and only ever edits or removes the entry it owns."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

from routes import mcp as mcp_routes

URL = "http://127.0.0.1:3001/api/nub/mcp"


class _Response:
    """Status + JSON of a handler's JSONResponse (real, or test_main's stub)."""

    def __init__(self, response):
        self.status_code = response.status_code
        content = getattr(response, "content", None)
        self._json = content if content is not None else json.loads(response.body)

    def json(self):
        return self._json


class _Client:
    """Calls the route handlers directly. test_main stubs FastAPI for the whole
    suite (decorators become no-ops), so TestClient isn't available here."""

    def post(self, path, json):
        assert path == "/workspace/nub-mcp"
        body = mcp_routes.NubMcpRequest(**json)
        return _Response(asyncio.run(mcp_routes.workspace_nub_mcp_register(None, body)))

    def delete(self, path):
        assert path == "/workspace/nub-mcp"
        return _Response(asyncio.run(mcp_routes.workspace_nub_mcp_unregister(None)))


class NubMcpRouteTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.client = _Client()
        patches = [
            mock.patch.object(mcp_routes.bridge_workspace, "_resolve_hermes_home", return_value=self.home),
            mock.patch.object(mcp_routes.bridge_workspace, "_resolve_profile_name", return_value=None),
            mock.patch.object(mcp_routes, "_reload_agent_mcp", return_value=True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def config(self):
        return yaml.safe_load((self.home / "config.yaml").read_text())

    def write_config(self, data):
        (self.home / "config.yaml").write_text(yaml.safe_dump(data))

    def test_register_writes_entry_and_is_idempotent(self):
        self.write_config({"model": {"provider": "openrouter"}})

        res = self.client.post("/workspace/nub-mcp", json={"url": URL, "token": "tok"})
        self.assertEqual(res.json(), {"ok": True, "changed": True, "reloaded": True})
        self.assertEqual(
            self.config(),
            {
                "model": {"provider": "openrouter"},
                "mcp_servers": {
                    "nub": {"url": URL, "headers": {"Authorization": "Bearer tok"}, "timeout": 300},
                },
            },
        )

        again = self.client.post("/workspace/nub-mcp", json={"url": URL, "token": "tok"})
        self.assertEqual(again.json(), {"ok": True, "changed": False, "reloaded": False})

    def test_register_repoints_its_own_entry_to_a_new_port(self):
        self.write_config({"mcp_servers": {"nub": {"url": URL, "headers": {"Authorization": "Bearer old"}}}})
        new_url = "http://127.0.0.1:51234/api/nub/mcp"

        res = self.client.post("/workspace/nub-mcp", json={"url": new_url, "token": "new"})

        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.config()["mcp_servers"]["nub"]["url"], new_url)

    def test_register_rejects_non_loopback_urls_and_foreign_entries(self):
        bad = self.client.post("/workspace/nub-mcp", json={"url": "https://evil.example/api/nub/mcp", "token": "t"})
        self.assertEqual(bad.status_code, 400)

        self.write_config({"mcp_servers": {"nub": {"command": "npx", "args": ["someone-elses-nub"]}}})
        clash = self.client.post("/workspace/nub-mcp", json={"url": URL, "token": "t"})
        self.assertEqual(clash.status_code, 409)
        self.assertEqual(self.config()["mcp_servers"]["nub"], {"command": "npx", "args": ["someone-elses-nub"]})

    def test_unregister_only_removes_sparks_entry(self):
        self.write_config({"mcp_servers": {"nub": {"command": "npx"}}})
        self.assertEqual(self.client.delete("/workspace/nub-mcp").json(), {"ok": True, "removed": False})

        self.write_config({"mcp_servers": {"nub": {"url": URL}, "fetch": {"command": "uvx"}}})
        res = self.client.delete("/workspace/nub-mcp")
        self.assertEqual(res.json(), {"ok": True, "removed": True, "reloaded": True})
        self.assertEqual(self.config(), {"mcp_servers": {"fetch": {"command": "uvx"}}})


if __name__ == "__main__":
    unittest.main()
