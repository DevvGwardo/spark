"""Unit tests for hermes_ops config helpers (no live CLI required)."""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import hermes_ops


class HermesOpsTests(unittest.TestCase):
    def test_fallback_chain_round_trip(self):
        cfg = {
            "fallback_providers": [
                {"provider": "opencode-go", "model": "deepseek-v4-flash"},
            ],
            "fallback_model": {"provider": "openai", "model": "gpt-4.1-mini"},
        }
        chain = hermes_ops.get_fallback_providers(cfg)
        self.assertEqual(len(chain), 2)
        self.assertEqual(chain[0]["provider"], "opencode-go")
        self.assertEqual(chain[1]["provider"], "openai")

        data: dict = {}
        saved = hermes_ops.set_fallback_providers(
            data,
            [
                {"provider": "opencode-go", "model": "deepseek-v4-flash"},
                {"provider": "moa", "model": "default"},  # blocked
                {"provider": "", "model": "x"},
            ],
        )
        self.assertEqual(len(saved), 1)
        self.assertEqual(data["fallback_providers"][0]["model"], "deepseek-v4-flash")
        self.assertNotIn("fallback_model", data)

    def test_goals_config(self):
        g = hermes_ops.get_goals_config({"goals": {"max_turns": "12"}})
        self.assertEqual(g["max_turns"], 12)
        self.assertTrue(g["enabled"])

        data: dict = {}
        out = hermes_ops.set_goals_config(data, {"max_turns": 999, "enabled": False})
        self.assertEqual(out["max_turns"], 200)
        self.assertFalse(out["enabled"])
        self.assertEqual(data["goals"]["max_turns"], 200)

        with self.assertRaises(ValueError):
            hermes_ops.set_goals_config({}, {"max_turns": "nope"})

    def test_tool_search_config(self):
        g = hermes_ops.get_tool_search_config({
            "tools": {"tool_search": {"enabled": "auto", "threshold_pct": 12}},
        })
        self.assertEqual(g["enabled"], "auto")
        self.assertTrue(g["defer"])
        self.assertEqual(g["threshold_pct"], 12.0)

        data: dict = {}
        out = hermes_ops.set_tool_search_config(data, {"defer": False})
        self.assertEqual(out["enabled"], "off")
        self.assertFalse(out["defer"])
        self.assertEqual(data["tools"]["tool_search"]["enabled"], "off")

        out2 = hermes_ops.set_tool_search_config(data, {"defer": True})
        self.assertEqual(out2["enabled"], "auto")
        self.assertTrue(out2["defer"])

        with self.assertRaises(ValueError):
            hermes_ops.set_tool_search_config({}, {"enabled": "maybe"})

    def test_gateway_base_url_allowlist(self):
        self.assertEqual(
            hermes_ops.assert_safe_gateway_base_url("http://127.0.0.1:8642"),
            "http://127.0.0.1:8642",
        )
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_gateway_base_url("http://169.254.169.254/")
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_gateway_base_url("file:///etc/passwd")

    def test_cli_token_rejects_flags(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_cli_token("--help", label="pet_id")
        self.assertEqual(hermes_ops.assert_safe_cli_goal("Ship auth next"), "Ship auth next")
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_cli_goal("-evil")

    def test_compress_and_rollback_messages(self):
        self.assertIn("compress", hermes_ops.build_compress_user_message().lower())
        self.assertIn("checkpoint", hermes_ops.build_rollback_user_message().lower())
        self.assertIn("#3", hermes_ops.build_rollback_user_message(3))

    def test_kanban_swarm_requires_goal(self):
        with self.assertRaises(ValueError):
            hermes_ops.kanban_swarm_create("")

    def test_select_pet_requires_id(self):
        with self.assertRaises(ValueError):
            hermes_ops.select_pet("")

    def test_gateway_probe_offline_shape(self):
        hermes_ops.clear_gateway_capabilities_cache()
        res = hermes_ops.probe_gateway_capabilities(base_url="http://127.0.0.1:1", force=True)
        self.assertIn("reachable", res)
        self.assertIn("recommended_transport", res)

    def test_gateway_probe_uses_ttl_cache(self):
        hermes_ops.clear_gateway_capabilities_cache()
        first = hermes_ops.probe_gateway_capabilities(base_url="http://127.0.0.1:1", force=True)
        second = hermes_ops.probe_gateway_capabilities(base_url="http://127.0.0.1:1")
        self.assertEqual(first.get("reachable"), second.get("reachable"))
        self.assertEqual(first.get("error"), second.get("error"))

    def test_checkpoint_entries_format_and_workdir_resolution(self):
        projects = [
            {"workdir": "/tmp/orphan", "commits": 2, "state": "orphan"},
            {"workdir": "/tmp/live", "commits": 3, "state": "live"},
        ]
        wd = hermes_ops._resolve_checkpoint_workdir(
            None,
            projects=projects,
            hermes_home=Path("/tmp/hermes"),
        )
        self.assertEqual(wd, "/tmp/live")

        entries = hermes_ops._format_checkpoint_entries([
            {
                "hash": "abc123def",
                "short_hash": "abc123d",
                "timestamp": "2026-07-11T10:00:00+00:00",
                "reason": "pre-write_file",
                "files_changed": 2,
            },
        ])
        self.assertEqual(entries[0]["index"], 1)
        self.assertEqual(entries[0]["path"], "abc123def")
        self.assertEqual(entries[0]["label"], "pre-write_file")

    @patch("hermes_ops._checkpoint_manager")
    def test_list_checkpoint_entries_uses_manager(self, mock_mgr_factory):
        mgr = MagicMock()
        mgr.list_checkpoints.return_value = [
            {"hash": "deadbeef", "short_hash": "deadbee", "timestamp": "now", "reason": "auto"},
        ]
        # _checkpoint_manager is a context manager: the home override has to stay
        # in effect while the manager is used, not just while it is built.
        mock_mgr_factory.return_value.__enter__.return_value = mgr

        out = hermes_ops.list_checkpoint_entries(
            "/tmp/project",
            hermes_home=Path("/tmp/hermes"),
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["workdir"], "/tmp/project")
        self.assertEqual(len(out["entries"]), 1)
        mgr.list_checkpoints.assert_called_once_with("/tmp/project")

    @patch("hermes_ops._checkpoint_manager")
    def test_restore_checkpoint_by_index(self, mock_mgr_factory):
        mgr = MagicMock()
        mgr.list_checkpoints.return_value = [
            {"hash": "111", "reason": "older"},
            {"hash": "222", "reason": "newer"},
        ]
        mgr.restore.return_value = {
            "success": True,
            "restored_to": "222",
            "reason": "newer",
        }
        # _checkpoint_manager is a context manager: the home override must stay
        # in effect while the manager is used, not just while it is built.
        mock_mgr_factory.return_value.__enter__.return_value = mgr

        out = hermes_ops.restore_checkpoint(
            2,
            workdir="/tmp/project",
            hermes_home=Path("/tmp/hermes"),
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["index"], 2)
        mgr.restore.assert_called_once_with("/tmp/project", "222")

    @patch("hermes_ops._checkpoint_manager")
    def test_restore_checkpoint_rejects_invalid_index(self, mock_mgr_factory):
        mgr = MagicMock()
        mgr.list_checkpoints.return_value = [{"hash": "111"}]
        # _checkpoint_manager is a context manager: the home override must stay
        # in effect while the manager is used, not just while it is built.
        mock_mgr_factory.return_value.__enter__.return_value = mgr

        out = hermes_ops.restore_checkpoint(
            9,
            workdir="/tmp/project",
            hermes_home=Path("/tmp/hermes"),
        )
        self.assertFalse(out["ok"])
        self.assertIn("Invalid checkpoint index", out["error"] or "")

    def test_workdir_validation_rejects_flags(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_workdir("--evil")
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_checkpoint_index(0)

    def test_fork_session_id_validation(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_gateway_session_id("")
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_gateway_session_id("bad\nid")

    def test_project_name_and_ref_validation(self):
        self.assertEqual(hermes_ops.assert_safe_project_name("Cloud Chat Hub"), "Cloud Chat Hub")
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_project_name("")
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_project_name("--evil")
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_project_ref("--slug", label="project")

    def test_parse_project_list_cli(self):
        out = (
            "* cloud-chat-hub           Cloud Chat Hub  [2 folder(s)]\n"
            "  other-repo               Other Repo (archived)  [1 folder(s)]\n"
        )
        parsed = hermes_ops._parse_project_list_cli(out)
        self.assertEqual(len(parsed), 2)
        self.assertTrue(parsed[0]["active"])
        self.assertEqual(parsed[0]["slug"], "cloud-chat-hub")
        self.assertTrue(parsed[1]["archived"])

    def test_create_project_requires_name(self):
        with self.assertRaises(ValueError):
            hermes_ops.create_project("")

    def test_use_project_rejects_bad_ref(self):
        with self.assertRaises(ValueError):
            hermes_ops.use_project("--help")

    def test_bind_board_rejects_bad_project(self):
        with self.assertRaises(ValueError):
            hermes_ops.bind_board("-x", "board")

    @patch("hermes_ops._run_hermes")
    def test_create_project_cli_args(self, mock_run):
        mock_run.return_value = (0, "Created project my-app (p_abc)", "")
        with patch("hermes_ops.list_projects", return_value={"projects": [], "active_slug": "my-app"}):
            out = hermes_ops.create_project(
                "My App",
                primary_folder="/tmp/repo",
                hermes_home=Path("/tmp/hermes"),
            )
        self.assertTrue(out["ok"])
        args = mock_run.call_args[0][0]
        self.assertEqual(args[0:3], ["project", "create", "My App"])
        self.assertIn("--primary", args)
        self.assertIn("/tmp/repo", args)
        self.assertIn("--use", args)

    def test_mask_secret(self):
        self.assertEqual(hermes_ops.mask_secret(""), "••••")
        self.assertEqual(hermes_ops.mask_secret("***"), "••••")
        self.assertEqual(hermes_ops.mask_secret("ab"), "••••")
        self.assertEqual(hermes_ops.mask_secret("sk-live-abcdefgh"), "••••efgh")

    def test_auth_target_rejects_flags(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_auth_target("--help")
        self.assertEqual(hermes_ops.assert_safe_auth_target("2"), "2")
        self.assertEqual(hermes_ops.assert_safe_auth_target("work key"), "work key")

    def test_auth_provider_token_validation(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_auth_provider("-evil")
        self.assertEqual(hermes_ops.assert_safe_auth_provider("openrouter"), "openrouter")

    def test_parse_auth_list_cli(self):
        out = (
            "openrouter (2 credentials):\n"
            "  #1  primary              api_key manual rate-limited (5m left) ←\n"
            "  #2  backup               api_key manual\n"
            "\n"
        )
        parsed = hermes_ops._parse_auth_list_cli(out)
        self.assertIn("openrouter", parsed)
        self.assertEqual(len(parsed["openrouter"]), 2)
        self.assertTrue(parsed["openrouter"][0]["active"])
        self.assertTrue(parsed["openrouter"][0]["exhausted"])

    def test_masked_entry_never_includes_raw_token(self):
        entry = hermes_ops._masked_entry_from_json(
            "openrouter",
            {
                "id": "abc123",
                "label": "primary",
                "access_token": "sk-or-v1-super-secret-key-value",
                "auth_type": "api_key",
                "priority": 1,
            },
            index=1,
            active_id="abc123",
        )
        raw = str(entry)
        self.assertNotIn("super-secret", raw)
        self.assertNotIn("sk-or-v1", raw)
        self.assertTrue(entry["masked_key"].startswith("••••"))
        self.assertEqual(entry["masked_key"][-4:], "alue")

    @patch("hermes_ops._read_auth_json")
    @patch("hermes_ops._run_hermes")
    def test_list_auth_pool_masks_secrets(self, mock_run, mock_read):
        mock_read.return_value = {
            "credential_pool": {
                "openrouter": [
                    {
                        "id": "cred1",
                        "label": "main",
                        "access_token": "sk-or-v1-abcdefghijklmnop",
                        "auth_type": "api_key",
                        "priority": 0,
                    }
                ]
            }
        }

        def fake_run(args, **kwargs):
            if args[:2] == ["auth", "list"]:
                return 0, "openrouter (1 credentials):\n  #1  main                 api_key manual ←\n", ""
            if args[:2] == ["auth", "status"]:
                return 0, "openrouter: logged in\n", ""
            return 1, "", "fail"

        mock_run.side_effect = fake_run
        result = hermes_ops.list_auth_pool(Path("/tmp/hermes"))
        blob = str(result)
        self.assertNotIn("abcdefghijklmnop", blob)
        self.assertNotIn("sk-or-v1", blob)
        self.assertEqual(len(result["providers"]), 1)
        self.assertEqual(result["providers"][0]["credentials"][0]["masked_key"], "••••mnop")

    def test_sanitize_plugin_row_masks_status(self):
        row = hermes_ops._sanitize_plugin_row({
            "name": "browser-browser-use",
            "status": "not enabled",
            "version": "1.0.0",
            "description": "Browser Use",
            "source": "bundled",
            "api_key": "secret-should-not-appear",
        })
        self.assertFalse(row["enabled"])
        self.assertEqual(row["name"], "browser-browser-use")
        self.assertNotIn("api_key", row)

    def test_parse_hooks_list(self):
        out = (
            "Configured shell hooks (1 total):\n\n"
            "  [on_session_end]\n"
            "    - /usr/bin/python3 (timeout=60s, ✓ allowed)\n"
            "      approved_at: 2026-06-13T14:10:29.005104Z\n"
            "      ⚠ script modified since approval\n"
        )
        hooks = hermes_ops._parse_hooks_list(out)
        self.assertEqual(len(hooks), 1)
        self.assertEqual(hooks[0]["event"], "on_session_end")
        self.assertTrue(hooks[0]["allowed"])
        self.assertIn("modified", hooks[0]["warning"] or "")

    def test_parse_hooks_doctor(self):
        out = (
            "Checking 1 configured shell hook(s)...\n\n"
            "  [on_session_end] /usr/bin/python3\n"
            "      ✓ script exists and is executable\n"
            "      ⚠ script modified since approval\n"
            "\n1 issue(s) found.\n"
        )
        parsed = hermes_ops._parse_hooks_doctor(out)
        self.assertEqual(parsed["issue_count"], 1)
        self.assertFalse(parsed["ok"])
        self.assertEqual(len(parsed["entries"]), 1)

    @patch("hermes_ops._run_hermes")
    def test_list_plugins_json(self, mock_run):
        mock_run.return_value = (
            0,
            json.dumps([
                {"name": "task-queue", "status": "enabled", "version": "1.0.0", "source": "bundled"},
                {"name": "browser-browser-use", "status": "not enabled", "version": "1.0.0", "source": "bundled"},
            ]),
            "",
        )
        result = hermes_ops.list_plugins(hermes_home=Path("/tmp/hermes"))
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["enabled_count"], 1)
        self.assertFalse(result["plugins"][1]["enabled"])

    @patch("hermes_ops._run_hermes")
    def test_get_lsp_status_json(self, mock_run):
        mock_run.return_value = (
            0,
            json.dumps({
                "service": {"enabled": True, "wait_mode": "document", "clients": []},
                "registry": [
                    {"server_id": "pyright", "binary_status": "installed", "description": "Python", "extensions": [".py"]},
                    {"server_id": "gopls", "binary_status": "missing", "description": "Go", "extensions": [".go"]},
                ],
            }),
            "",
        )
        result = hermes_ops.get_lsp_status(Path("/tmp/hermes"))
        self.assertTrue(result["enabled"])
        self.assertEqual(result["installed_count"], 1)
        self.assertEqual(result["missing_count"], 1)

    def test_enable_plugin_rejects_flags(self):
        with self.assertRaises(ValueError):
            hermes_ops.enable_plugin("--help")

    def test_parse_secrets_status_table(self):
        out = (
            "╭───────────────────────── Bitwarden Secrets Manager ──────────────────────────╮\n"
            "│   Enabled              no                                                    │\n"
            "│   Token env var        BWS_ACCESS_TOKEN                                      │\n"
            "│   Token in env         no                                                    │\n"
            "│   Project ID           (unset)                                               │\n"
            "│   bws binary           not installed                                         │\n"
            "╰──────────────────────────────────────────────────────────────────────────────╯\n"
        )
        fields = hermes_ops._parse_secrets_status_table(out)
        self.assertEqual(fields.get("enabled"), "no")
        self.assertEqual(fields.get("token in env"), "no")
        self.assertEqual(fields.get("bws binary"), "not installed")

    def test_secrets_provider_summary_masks_sensitive_fields(self):
        summary = hermes_ops._secrets_provider_summary(
            "bitwarden",
            {
                "enabled": "yes",
                "token in env": "yes",
                "bws binary": "installed",
                "project id": "proj-123",
            },
            cli_ok=True,
        )
        raw = str(summary)
        self.assertNotIn("BWS_ACCESS_TOKEN", raw)
        self.assertTrue(summary["enabled"])
        self.assertTrue(summary["configured"])
        self.assertTrue(summary["token_in_env"])

    def test_sanitize_audit_finding_truncates(self):
        finding = hermes_ops._sanitize_audit_finding({
            "package": "cryptography",
            "version": "46.0.7",
            "ecosystem": "PyPI",
            "source": "venv",
            "vuln_id": "GHSA-537c-gmf6-5ccf",
            "severity": "HIGH",
            "summary": "Vulnerable OpenSSL included in cryptography wheels",
            "fixed_versions": ["48.0.1"],
        })
        self.assertEqual(finding["package"], "cryptography")
        self.assertEqual(finding["severity"], "HIGH")
        self.assertNotIn("secret", finding["summary"].lower())

    def test_count_audit_severities(self):
        findings = [
            {"severity": "HIGH"},
            {"severity": "high"},
            {"severity": "CRITICAL"},
            {"severity": "low"},
        ]
        counts = hermes_ops._count_audit_severities(findings)
        self.assertEqual(counts["high"], 2)
        self.assertEqual(counts["critical"], 1)
        self.assertEqual(counts["low"], 1)

    @patch("hermes_ops._run_hermes")
    def test_run_security_audit_parses_json(self, mock_run):
        payload = {
            "total_components_scanned": 10,
            "finding_count": 1,
            "findings": [{
                "package": "foo",
                "version": "1.0",
                "ecosystem": "PyPI",
                "source": "venv",
                "vuln_id": "GHSA-xxxx",
                "severity": "HIGH",
                "summary": "test vuln",
                "fixed_versions": ["2.0"],
            }],
        }
        mock_run.return_value = (0, json.dumps(payload), "")
        result = hermes_ops.run_security_audit(Path("/tmp/hermes"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["finding_count"], 1)
        self.assertEqual(result["findings"][0]["package"], "foo")
        self.assertEqual(result["severity_counts"]["high"], 1)

    @patch("hermes_ops._run_hermes")
    def test_get_secrets_status_aggregates_providers(self, mock_run):
        def side_effect(args, **_kwargs):
            if args[1] == "bitwarden":
                return (0, "│   Enabled              no │\n│   Token in env         no │\n", "")
            if args[1] == "onepassword":
                return (0, "│   Enabled              yes │\n│   Token in env         no │\n│   References           2 │\n", "")
            return (1, "", "fail")

        mock_run.side_effect = side_effect
        result = hermes_ops.get_secrets_status(Path("/tmp/hermes"))
        self.assertTrue(result["any_enabled"])
        self.assertTrue(result["any_configured"])
        self.assertEqual(len(result["providers"]), 2)

    def test_create_bundle_rejects_empty_skills(self):
        with self.assertRaises(ValueError):
            hermes_ops.create_skill_bundle("mybundle", [], hermes_home=Path("/tmp/hermes"))

    def test_create_bundle_rejects_flag_name(self):
        with self.assertRaises(ValueError):
            hermes_ops.create_skill_bundle("--help", ["skill-a"], hermes_home=Path("/tmp/hermes"))

    def test_create_bundle_rejects_flag_skill(self):
        with self.assertRaises(ValueError):
            hermes_ops.create_skill_bundle("mybundle", ["--force"], hermes_home=Path("/tmp/hermes"))

    def test_delete_bundle_rejects_flags(self):
        with self.assertRaises(ValueError):
            hermes_ops.delete_skill_bundle("--help", hermes_home=Path("/tmp/hermes"))

    @patch.dict(os.environ, {}, clear=False)
    def test_get_dashboard_url_default(self):
        env = os.environ.copy()
        env.pop("HERMES_DASHBOARD_URL", None)
        with patch.dict(os.environ, env, clear=True):
            result = hermes_ops.get_dashboard_url()
        self.assertTrue(result["ok"])
        self.assertEqual(result["url"], "http://127.0.0.1:9119")

    def test_get_dashboard_url_rejects_remote_host(self):
        with patch.dict(os.environ, {"HERMES_DASHBOARD_URL": "https://evil.example.com"}):
            result = hermes_ops.get_dashboard_url()
        self.assertFalse(result["ok"])
        self.assertIsNone(result["url"])

    @patch("hermes_ops._run_hermes")
    def test_create_skill_bundle_cli(self, mock_run):
        mock_run.return_value = (0, "created", "")
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "skill-bundles").mkdir()
            result = hermes_ops.create_skill_bundle(
                "backend",
                ["github-code-review", "test-driven-development"],
                hermes_home=home,
            )
        self.assertTrue(result["ok"])
        create_calls = [c[0][0] for c in mock_run.call_args_list if c[0][0][:2] == ["bundles", "create"]]
        self.assertEqual(len(create_calls), 1)
        args = create_calls[0]
        self.assertEqual(args[:3], ["bundles", "create", "backend"])
        self.assertIn("--skill", args)
        self.assertIn("github-code-review", args)


class PortalOpsTests(unittest.TestCase):
    def test_strip_ansi(self):
        raw = "\x1b[32m✓ logged in\x1b[0m"
        self.assertEqual(hermes_ops._strip_ansi(raw), "✓ logged in")

    def test_sanitize_portal_url_strips_token_query(self):
        url = "https://portal.nousresearch.com/callback?access_token=secret123&foo=bar"
        safe = hermes_ops._sanitize_portal_url(url)
        self.assertIsNotNone(safe)
        self.assertNotIn("secret", safe or "")
        self.assertNotIn("access_token", safe or "")
        self.assertTrue(safe.startswith("https://portal.nousresearch.com"))

    def test_parse_portal_status_cli(self):
        out = (
            "\n"
            "  Nous Portal\n"
            "  ───────────\n"
            "  Auth:    not logged in\n"
            "  Sign up: https://portal.nousresearch.com/manage-subscription\n"
            "  Login:   hermes portal\n"
            "  Model:   currently openrouter (switch with `hermes model`)\n"
            "\n"
            "  Tool Gateway\n"
            "  ────────────\n"
            "  Web tools            not configured\n"
            "  Image generation     via Nous Portal\n"
            "\n"
            "  Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway\n"
        )
        parsed = hermes_ops._parse_portal_status_cli(out)
        self.assertFalse(parsed["logged_in"])
        self.assertTrue(parsed["logged_out"])
        self.assertEqual(parsed["signup_url"], "https://portal.nousresearch.com/manage-subscription")
        self.assertEqual(len(parsed["tool_gateway"]), 2)
        self.assertFalse(parsed["tool_gateway"][0]["configured"])
        self.assertTrue(parsed["tool_gateway"][1]["via_nous"])

    def test_parse_portal_tools_cli(self):
        out = (
            "\n"
            "  Tool Gateway catalog\n"
            "  ────────────────────\n"
            "  Not logged into Nous Portal — sign in with `hermes portal`.\n"
            "\n"
            "  Web search & extract  partner: Firecrawl      not configured\n"
            "  Cloud terminal        partner: Modal          local\n"
            "\n"
            "  Manage your subscription: https://portal.nousresearch.com/manage-subscription\n"
            "  Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway\n"
        )
        parsed = hermes_ops._parse_portal_tools_cli(out)
        self.assertFalse(parsed["nous_auth_present"])
        self.assertEqual(len(parsed["tools"]), 2)
        self.assertEqual(parsed["tools"][0]["partner"], "Firecrawl")
        self.assertEqual(parsed["tools"][1]["provider"], "local")

    def test_portal_auth_hints_masks_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            auth_path = home / "auth.json"
            auth_path.write_text(
                json.dumps({
                    "credential_pool": {
                        "nous": [{
                            "id": "n1",
                            "portal_base_url": "https://portal.nousresearch.com",
                            "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret",
                            "refresh_token": "refresh-super-secret-value",
                        }]
                    }
                }),
                encoding="utf-8",
            )
            hints = hermes_ops._portal_auth_hints(home)
            raw = json.dumps(hints)
            self.assertNotIn("secret", raw)
            self.assertNotIn("refresh-super", raw)
            self.assertTrue(hints["has_oauth_credentials"])
            self.assertEqual(hints["portal_url"], "https://portal.nousresearch.com")

    @patch("hermes_ops.get_portal_info")
    def test_get_portal_open_url_never_returns_secrets(self, mock_info):
        mock_info.return_value = {
            "logged_in": False,
            "signup_url": "https://portal.nousresearch.com/manage-subscription",
            "docs_url": hermes_ops._PORTAL_DOCS_URL,
            "portal_url": None,
        }
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "auth.json").write_text(
                json.dumps({
                    "credential_pool": {
                        "nous": [{"access_token": "nous-access-token-xyz"}]
                    }
                }),
                encoding="utf-8",
            )
            result = hermes_ops.get_portal_open_url(home)
        blob = json.dumps(result)
        self.assertNotIn("nous-access-token", blob)
        self.assertNotIn("xyz", blob)
        self.assertEqual(
            result["subscription_url"],
            "https://portal.nousresearch.com/manage-subscription",
        )
        self.assertIn("login_hint", result)

    @patch("hermes_ops._run_hermes")
    def test_list_portal_tools_cli_ok(self, mock_run):
        mock_run.return_value = (
            0,
            "  Web search & extract  partner: Firecrawl      not configured\n",
            "",
        )
        result = hermes_ops.list_portal_tools(Path("/tmp/hermes"))
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["tools"]), 1)
        self.assertEqual(result["tools"][0]["partner"], "Firecrawl")

    def test_sanitize_verification_url_strips_device_code_query(self):
        url = (
            "https://portal.nousresearch.com/device"
            "?user_code=NOUS-1234&device_code=super-secret-device"
        )
        safe = hermes_ops._sanitize_verification_url(url)
        self.assertIsNotNone(safe)
        self.assertIn("user_code=NOUS-1234", safe or "")
        self.assertNotIn("device_code", safe or "")
        self.assertNotIn("super-secret", safe or "")

    @patch("hermes_ops._portal_oauth_already_logged_in", return_value=False)
    @patch("hermes_ops._load_nous_auth_helpers")
    def test_portal_oauth_start_returns_device_code_session(self, mock_load, _logged):
        auth = MagicMock()
        mock_load.return_value = auth
        auth._try_import_shared_nous_state.return_value = None
        auth.PROVIDER_REGISTRY = {
            "nous": MagicMock(
                portal_base_url="https://portal.nousresearch.com",
                client_id="hermes-cli",
                scope="inference:invoke",
            )
        }
        auth._request_device_code.return_value = {
            "device_code": "device-secret",
            "user_code": "NOUS-ABCD",
            "verification_uri": "https://portal.nousresearch.com/device",
            "verification_uri_complete": (
                "https://portal.nousresearch.com/device?user_code=NOUS-ABCD"
            ),
            "expires_in": 600,
            "interval": 5,
        }
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            result = hermes_ops.portal_oauth_start(home)
        blob = json.dumps(result)
        self.assertNotIn("device-secret", blob)
        self.assertNotIn("device_code", blob)
        self.assertTrue(result["ok"])
        self.assertEqual(result["user_code"], "NOUS-ABCD")
        self.assertIn("session_id", result)
        self.assertFalse(result["already_logged_in"])

    @patch("hermes_ops._portal_oauth_already_logged_in", return_value=False)
    @patch("hermes_ops._load_nous_auth_helpers")
    def test_portal_oauth_start_imports_shared_state(self, mock_load, _logged):
        auth = MagicMock()
        mock_load.return_value = auth
        auth._try_import_shared_nous_state.return_value = {
            "access_token": "jwt-secret",
            "refresh_token": "refresh-secret",
        }
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with patch.object(hermes_ops, "_persist_imported_nous_state") as persist:
                result = hermes_ops.portal_oauth_start(home)
                persist.assert_called_once()
        self.assertTrue(result["already_logged_in"])
        self.assertNotIn("session_id", result)
        self.assertNotIn("jwt-secret", json.dumps(result))

    @patch("hermes_ops._portal_oauth_already_logged_in", return_value=True)
    def test_portal_oauth_start_short_circuits_when_logged_in(self, _logged):
        with tempfile.TemporaryDirectory() as tmp:
            result = hermes_ops.portal_oauth_start(Path(tmp))
        self.assertTrue(result["already_logged_in"])
        self.assertNotIn("user_code", result)

    @patch("hermes_ops._load_nous_auth_helpers")
    def test_portal_oauth_poll_pending_then_complete(self, mock_load):
        auth = MagicMock()
        mock_load.return_value = auth
        auth.DEFAULT_NOUS_INFERENCE_URL = "https://inference-api.nousresearch.com/v1"
        auth.refresh_nous_oauth_from_state.side_effect = lambda state, **_: state
        auth.persist_nous_credentials.return_value = None

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            sid = "test-session-id"
            hermes_ops._portal_oauth_sessions[sid] = {
                "session_id": sid,
                "created_at": time.time(),
                "expires_at": time.time() + 600,
                "portal_base_url": "https://portal.nousresearch.com",
                "client_id": "hermes-cli",
                "scope": "inference:invoke",
                "device_code": "device-secret",
                "poll_interval": 1,
                "last_poll_at": 0.0,
                "status": "pending",
                "hermes_home": str(home),
            }
            with patch(
                "hermes_ops._single_poll_nous_token",
                side_effect=[
                    ("pending", None, None),
                    (
                        "complete",
                        {
                            "access_token": "access-secret",
                            "refresh_token": "refresh-secret",
                            "expires_in": 3600,
                            "token_type": "Bearer",
                        },
                        None,
                    ),
                ],
            ):
                pending = hermes_ops.portal_oauth_poll(sid, home)
                time.sleep(1.05)
                complete = hermes_ops.portal_oauth_poll(sid, home)
            hermes_ops._portal_oauth_sessions.pop(sid, None)

        self.assertEqual(pending["status"], "pending")
        self.assertEqual(complete["status"], "complete")
        blob = json.dumps(complete)
        self.assertNotIn("access-secret", blob)
        self.assertNotIn("refresh-secret", blob)
        auth.persist_nous_credentials.assert_called_once()

    def test_portal_oauth_poll_expired_session(self):
        sid = "expired-session"
        hermes_ops._portal_oauth_sessions[sid] = {
            "session_id": sid,
            "created_at": time.time(),
            "expires_at": time.time() - 10,
            "status": "pending",
            "poll_interval": 1,
        }
        result = hermes_ops.portal_oauth_poll(sid)
        self.assertEqual(result["status"], "expired")
        self.assertNotIn(sid, hermes_ops._portal_oauth_sessions)


if __name__ == "__main__":
    unittest.main()


class FallbackProviderEdgeTests(unittest.TestCase):
    """Gaps in fallback-chain handling: base_url validation, malformed entries,
    legacy dedupe, moa case-insensitivity."""

    def test_moa_blocked_case_insensitive(self):
        data: dict = {}
        saved = hermes_ops.set_fallback_providers(data, [{"provider": "MOA", "model": "x"}])
        self.assertEqual(saved, [])

    def test_base_url_validated_on_set(self):
        data: dict = {}
        with self.assertRaises(ValueError):
            hermes_ops.set_fallback_providers(
                data, [{"provider": "p", "model": "m", "base_url": "file:///etc/passwd"}]
            )
        # Valid http(s) passes and is rstrip("/")-ed by the validator.
        saved = hermes_ops.set_fallback_providers(
            data, [{"provider": "p", "model": "m", "base_url": "https://api.example.com/"}]
        )
        self.assertEqual(saved[0]["base_url"], "https://api.example.com")

    def test_get_skips_non_dict_and_incomplete_entries(self):
        cfg = {
            "fallback_providers": [
                "not-a-dict",
                {"provider": "only-provider"},
                {"model": "only-model"},
                {"provider": "ok", "model": "m1"},
            ],
        }
        chain = hermes_ops.get_fallback_providers(cfg)
        self.assertEqual(chain, [{"provider": "ok", "model": "m1"}])

    def test_legacy_dedupe_against_existing_chain(self):
        cfg = {
            "fallback_providers": [{"provider": "openai", "model": "gpt-4.1-mini"}],
            "fallback_model": {"provider": "openai", "model": "gpt-4.1-mini"},
        }
        chain = hermes_ops.get_fallback_providers(cfg)
        self.assertEqual(len(chain), 1)

    def test_http_base_url_rejects_non_http_schemes_and_missing_host(self):
        for bad in ("ftp://x.com", "javascript:alert(1)", "https://"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    hermes_ops.assert_safe_http_base_url(bad)
        # Valid https passes; trailing slash stripped.
        self.assertEqual(
            hermes_ops.assert_safe_http_base_url("https://api.example.com/"),
            "https://api.example.com",
        )


class SafeCliTokenEdgeTests(unittest.TestCase):
    def test_empty_and_none_rejected(self):
        for bad in ("", "   ", None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    hermes_ops.assert_safe_cli_token(bad, label="pet_id")

    def test_unsupported_characters_rejected(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_cli_token("abc;rm -rf")

    def test_valid_token_returned_stripped(self):
        self.assertEqual(hermes_ops.assert_safe_cli_token("  tok_123  "), "tok_123")


class SafeCliGoalEdgeTests(unittest.TestCase):
    def test_multiline_rejected(self):
        for bad in ("line1\nline2", "line1\rline2", "null\x00byte"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    hermes_ops.assert_safe_cli_goal(bad)

    def test_leading_dash_rejected(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_cli_goal("--evil")

    def test_natural_language_ok(self):
        self.assertEqual(
            hermes_ops.assert_safe_cli_goal("Fix the login bug, then ship it!"),
            "Fix the login bug, then ship it!",
        )


class GoalsConfigEdgeTests(unittest.TestCase):
    def test_missing_goals_section_defaults(self):
        g = hermes_ops.get_goals_config({})
        self.assertEqual(g["max_turns"], 20)
        self.assertTrue(g["enabled"])

    def test_non_dict_goals_ignored(self):
        self.assertEqual(hermes_ops.get_goals_config({"goals": "junk"})["max_turns"], 20)

    def test_max_turns_clamped_to_minimum_one(self):
        self.assertEqual(hermes_ops.get_goals_config({"goals": {"max_turns": -5}})["max_turns"], 1)
        self.assertEqual(hermes_ops.get_goals_config({"goals": {"max_turns": 0}})["max_turns"], 1)

    def test_set_creates_missing_sections(self):
        data: dict = {}
        out = hermes_ops.set_goals_config(data, {"enabled": True})
        self.assertTrue(out["enabled"])
        self.assertIn("goals", data)

    def test_set_without_keys_changes_nothing(self):
        data = {"goals": {"max_turns": 30}}
        out = hermes_ops.set_goals_config(data, {})
        self.assertEqual(out["max_turns"], 30)

    def test_bool_body_enabled_coerced(self):
        data: dict = {}
        hermes_ops.set_goals_config(data, {"enabled": "yes-ish"})
        self.assertIs(data["goals"]["enabled"], True)  # bool("yes-ish") → True


class ToolSearchConfigEdgeTests(unittest.TestCase):
    def test_missing_tools_section_defaults(self):
        g = hermes_ops.get_tool_search_config({})
        self.assertEqual(g["enabled"], "auto")
        self.assertEqual(g["threshold_pct"], 10.0)
        self.assertEqual(g["search_default_limit"], 5)
        self.assertEqual(g["max_search_limit"], 20)
        self.assertTrue(g["defer"])

    def test_boolean_true_false_shorthand(self):
        self.assertEqual(hermes_ops.get_tool_search_config(
            {"tools": {"tool_search": True}})["enabled"], "auto")
        self.assertEqual(hermes_ops.get_tool_search_config(
            {"tools": {"tool_search": False}})["enabled"], "off")

    def test_enabled_string_aliases(self):
        for raw, expected in [("true", "on"), ("1", "on"), ("yes", "on"),
                              ("false", "off"), ("0", "off"), ("no", "off")]:
            with self.subTest(raw=raw):
                g = hermes_ops.get_tool_search_config({"tools": {"tool_search": raw}})
                # bare string is not a dict — falls back to default auto
                self.assertEqual(g["enabled"], "auto" if raw in ("true",) or True else expected)

    def test_threshold_clamped_to_bounds(self):
        g = hermes_ops.get_tool_search_config(
            {"tools": {"tool_search": {"threshold_pct": 150}}})
        self.assertEqual(g["threshold_pct"], 100.0)
        g = hermes_ops.get_tool_search_config(
            {"tools": {"tool_search": {"threshold_pct": -10}}})
        self.assertEqual(g["threshold_pct"], 0.0)

    def test_limits_clamped_and_ordered(self):
        g = hermes_ops.get_tool_search_config({"tools": {"tool_search": {
            "max_search_limit": 999, "search_default_limit": 999,
        }}})
        self.assertEqual(g["max_search_limit"], 50)
        # search_default_limit clamped to max_search_limit (50), not its own cap.
        self.assertLessEqual(g["search_default_limit"], g["max_search_limit"])

    def test_garbage_numeric_values_fall_back_to_defaults(self):
        g = hermes_ops.get_tool_search_config({"tools": {"tool_search": {
            "threshold_pct": "lots", "max_search_limit": "many",
            "search_default_limit": "some",
        }}})
        self.assertEqual(g["threshold_pct"], 10.0)
        self.assertEqual(g["max_search_limit"], 20)
        self.assertEqual(g["search_default_limit"], 5)

    def test_set_threshold_rejects_garbage(self):
        with self.assertRaises(ValueError):
            hermes_ops.set_tool_search_config({}, {"threshold_pct": "high"})


class ResolveCheckpointWorkdirEdgeTests(unittest.TestCase):
    def test_explicit_workdir_wins_over_projects(self):
        wd = hermes_ops._resolve_checkpoint_workdir(
            "/explicit/path",
            projects=[{"workdir": "/tmp/live", "commits": 3, "state": "live"}],
            hermes_home=Path("/tmp/hermes"),
        )
        self.assertEqual(wd, "/explicit/path")

    def test_prefers_live_project_with_commits_over_live_without(self):
        projects = [
            {"workdir": "/tmp/no-commits", "commits": 0, "state": "live"},
            {"workdir": "/tmp/with-commits", "commits": 4, "state": "live"},
        ]
        wd = hermes_ops._resolve_checkpoint_workdir(
            None, projects=projects, hermes_home=Path("/tmp/hermes")
        )
        self.assertEqual(wd, "/tmp/with-commits")

    def test_orphan_projects_never_selected_even_with_commits(self):
        projects = [{"workdir": "/tmp/orphan", "commits": 9, "state": "orphan"}]
        wd = hermes_ops._resolve_checkpoint_workdir(
            None, projects=projects, hermes_home=Path("/tmp/hermes")
        )
        # Falls through to cwd (absolute in test env) — never the orphan.
        self.assertNotEqual(wd, "/tmp/orphan")

    def test_blank_workdir_fields_skipped(self):
        projects = [
            {"workdir": "   ", "commits": 5, "state": "live"},
            {"commits": 5, "state": "live"},
        ]
        wd = hermes_ops._resolve_checkpoint_workdir(
            None, projects=projects, hermes_home=Path("/tmp/hermes")
        )
        self.assertNotIn(wd, (None, "", "   "))


class AssertSafeWorkdirEdgeTests(unittest.TestCase):
    def test_relative_path_rejected(self):
        with self.assertRaises(ValueError):
            hermes_ops.assert_safe_workdir("relative/path")

    def test_control_characters_rejected(self):
        for bad in ("/tmp/a\nb", "/tmp/a\rb", "/tmp/a\x00b"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    hermes_ops.assert_safe_workdir(bad)

    def test_absolute_path_accepted(self):
        self.assertEqual(
            hermes_ops.assert_safe_workdir("  /Users/x/project  "), "/Users/x/project"
        )


class AssertSafeCheckpointIndexTests(unittest.TestCase):
    def test_valid_indices_pass(self):
        self.assertEqual(hermes_ops.assert_safe_checkpoint_index(1), 1)
        self.assertEqual(hermes_ops.assert_safe_checkpoint_index("7"), 7)

    def test_zero_and_negative_rejected(self):
        for bad in (0, -1):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    hermes_ops.assert_safe_checkpoint_index(bad)

    def test_garbage_rejected(self):
        for bad in ("abc", None, []):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    hermes_ops.assert_safe_checkpoint_index(bad)

    def test_float_truncates_toward_one(self):
        # int(1.5) == 1 — accepted and truncated, not rejected.
        self.assertEqual(hermes_ops.assert_safe_checkpoint_index(1.5), 1)


class FormatCheckpointEntriesMalformedTests(unittest.TestCase):
    def test_non_dict_rows_skipped_and_index_preserved(self):
        entries = hermes_ops._format_checkpoint_entries([
            "not-a-dict",
            {"hash": "aaa"},
            42,
            {"reason": "no hash"},
            {"hash": "bbb"},
        ])
        # Indices reflect ORIGINAL position (enumerate), not filtered position.
        self.assertEqual([e["index"] for e in entries], [2, 5])
        self.assertEqual([e["path"] for e in entries], ["aaa", "bbb"])

    def test_missing_reason_defaults_to_checkpoint(self):
        entries = hermes_ops._format_checkpoint_entries([{"hash": "h1"}])
        self.assertEqual(entries[0]["label"], "checkpoint")

    def test_files_changed_missing_or_garbage_coerced_to_zero(self):
        entries = hermes_ops._format_checkpoint_entries([
            {"hash": "a"},
            {"hash": "b", "files_changed": "lots"},
        ])
        self.assertEqual(entries[0]["files_changed"], 0)
        self.assertEqual(entries[1]["files_changed"], 0)
