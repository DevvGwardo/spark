"""Pin the bridge's route table across the main.py -> routes/ split (spec 4.1).

FastAPI matches routes in registration order, so moving routes into APIRouter
modules must keep every (methods, path, endpoint name) and their order exactly
as they were when everything lived in main.py. ``EXPECTED_ROUTES`` was captured
from the pre-split main.py (``app.routes`` on origin/main at cfa095c).

The table is read in a fresh interpreter: the rest of this suite runs with
fastapi stubbed out (test_main.py installs the stubs), and the stub app keeps no
routes.
"""

import ast
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent

# (methods, path, endpoint name), in registration order.
EXPECTED_ROUTES = [
    ('GET,HEAD', '/openapi.json', 'openapi'),
    ('GET,HEAD', '/docs', 'swagger_ui_html'),
    ('GET,HEAD', '/docs/oauth2-redirect', 'swagger_ui_redirect'),
    ('GET,HEAD', '/redoc', 'redoc_html'),
    ('GET', '/diag', 'diag'),
    ('GET', '/health', 'health'),
    ('GET', '/v1/models', 'list_models'),
    ('GET', '/v1/providers', 'list_providers'),
    ('GET', '/moa', 'get_moa_config'),
    ('PUT', '/moa', 'put_moa_config'),
    ('GET', '/fallback', 'get_fallback'),
    ('PUT', '/fallback', 'put_fallback'),
    ('GET', '/delegation/live/latest', 'get_delegation_live_latest'),
    ('GET', '/delegation/live/{delegation_id}', 'get_delegation_live_manifest'),
    ('GET', '/delegation/live/{delegation_id}/task/{task_index}', 'get_delegation_live_task_log'),
    ('GET', '/checkpoints', 'get_checkpoints'),
    ('POST', '/checkpoints/prune', 'post_checkpoints_prune'),
    ('POST', '/checkpoints/restore', 'post_checkpoints_restore'),
    ('GET', '/memory/status', 'get_memory_status'),
    ('GET', '/curator/status', 'get_curator_status'),
    ('POST', '/curator/run', 'post_curator_run'),
    ('GET', '/computer-use/status', 'get_computer_use_status'),
    ('GET', '/bundles', 'get_bundles'),
    ('GET', '/bundles/{name}', 'get_bundle_detail'),
    ('POST', '/bundles/create', 'post_bundles_create'),
    ('POST', '/bundles/delete', 'post_bundles_delete'),
    ('POST', '/bundles/reload', 'post_bundles_reload'),
    ('GET', '/dashboard/url', 'get_dashboard_url'),
    ('GET', '/goals', 'get_goals'),
    ('PUT', '/goals', 'put_goals'),
    ('GET', '/tool-search', 'get_tool_search'),
    ('PUT', '/tool-search', 'put_tool_search'),
    ('GET', '/insights', 'get_insights'),
    ('GET', '/journey', 'get_journey'),
    ('POST', '/computer-use/install', 'post_computer_use_install'),
    ('GET', '/computer-use/doctor', 'get_computer_use_doctor'),
    ('GET', '/pets', 'get_pets'),
    ('GET', '/pets/gallery', 'get_pets_gallery'),
    ('POST', '/pets/select', 'post_pets_select'),
    ('POST', '/claw/migrate', 'post_claw_migrate'),
    ('GET', '/auth/pool', 'get_auth_pool'),
    ('GET', '/auth/pool/{provider}/status', 'get_auth_pool_provider_status'),
    ('POST', '/auth/pool/reset', 'post_auth_pool_reset'),
    ('POST', '/auth/pool/remove', 'post_auth_pool_remove'),
    ('POST', '/auth/pool/add', 'post_auth_pool_add'),
    ('GET', '/portal/info', 'get_portal_info_route'),
    ('GET', '/portal/status', 'get_portal_status_route'),
    ('GET', '/portal/tools', 'get_portal_tools_route'),
    ('GET', '/portal/open-url', 'get_portal_open_url_route'),
    ('GET', '/portal/open', 'get_portal_open_route'),
    ('POST', '/portal/oauth/start', 'portal_oauth_start_route'),
    ('GET', '/portal/oauth/poll/{session_id}', 'portal_oauth_poll_route'),
    ('GET', '/gateway/capabilities', 'get_gateway_capabilities'),
    # Spec 4.4: runs-only cancel became the any-transport cancel; the original
    # path stays registered first, /v1/chat/cancel is the new canonical name.
    ('POST', '/v1/runs/cancel', 'cancel_chat_turn'),
    ('POST', '/v1/chat/cancel', 'cancel_chat_turn'),
    ('POST', '/v1/runs/approve', 'approve_gateway_run'),
    ('POST', '/kanban/swarm', 'post_kanban_swarm'),
    ('GET', '/projects', 'get_projects'),
    ('POST', '/projects', 'post_projects_create'),
    ('POST', '/projects/use', 'post_projects_use'),
    ('POST', '/projects/bind-board', 'post_projects_bind_board'),
    ('GET', '/security/audit', 'get_security_audit'),
    ('GET', '/secrets/status', 'get_secrets_status'),
    ('POST', '/v1/chat/completions', 'chat_completions'),
    ('POST', '/v1/approvals/{approval_id}', 'acp_approval_route'),
    ('POST', '/v1/swarm', 'swarm_endpoint'),
    ('GET', '/cron', 'list_cron_jobs'),
    ('POST', '/cron', 'create_cron_job'),
    ('DELETE', '/cron/{job_id}', 'delete_cron_job'),
    ('POST', '/cron/{job_id}/pause', 'pause_cron_job'),
    ('POST', '/cron/{job_id}/resume', 'resume_cron_job'),
    ('POST', '/cron/{job_id}/run', 'run_cron_job'),
    ('GET', '/cron/{job_id}/history', 'get_cron_history'),
    ('GET', '/sessions', 'list_sessions'),
    ('GET', '/sessions/{session_id}', 'get_session'),
    ('DELETE', '/sessions/{session_id}', 'delete_session'),
    ('POST', '/sessions/{session_id}/fork', 'fork_session'),
    ('GET', '/workspace/commands', 'workspace_commands'),
    ('GET', '/workspace/auth-providers', 'workspace_auth_providers'),
    ('GET', '/bridges/cursor-composer', 'cursor_composer_bridge_status'),
    ('GET', '/workspace/overview', 'workspace_overview'),
    ('GET', '/workspace/usage', 'workspace_usage'),
    ('GET', '/workspace/files', 'workspace_files'),
    ('GET', '/workspace/files/{file_key}', 'workspace_file_detail'),
    ('PUT', '/workspace/files/{file_key}', 'workspace_file_update'),
    ('GET', '/workspace/mcp-servers', 'workspace_mcp_servers'),
    ('GET', '/workspace/mcp-catalog', 'workspace_mcp_catalog'),
    ('POST', '/workspace/mcp-servers/install', 'workspace_mcp_install'),
    ('DELETE', '/workspace/mcp-servers/{name}', 'workspace_mcp_uninstall'),
    ('GET', '/workspace/mcp-telemetry', 'workspace_mcp_telemetry'),
    ('GET', '/workspace/mcp-tool-index', 'workspace_mcp_tool_index'),
    ('GET', '/workspace/mcp-servers/{name}/logs', 'workspace_mcp_server_logs'),
    ('POST', '/workspace/nub-mcp', 'workspace_nub_mcp_register'),
    ('DELETE', '/workspace/nub-mcp', 'workspace_nub_mcp_unregister'),
    ('GET', '/workspace/skills', 'workspace_skills'),
    ('GET', '/workspace/skills/content', 'workspace_skill_detail'),
    ('GET', '/workspace/skills/hub', 'workspace_skills_hub'),
    ('POST', '/workspace/skills/hub/install', 'workspace_skill_install'),
    ('DELETE', '/workspace/skills', 'workspace_skill_uninstall'),
    ('GET', '/messaging/platforms', 'messaging_list_platforms'),
    ('GET', '/messaging/platforms/{platform_id}', 'messaging_get_platform'),
    ('PUT', '/messaging/platforms/{platform_id}/env', 'messaging_update_env'),
    ('PUT', '/messaging/platforms/{platform_id}/config', 'messaging_update_config'),
    ('DELETE', '/messaging/platforms/{platform_id}', 'messaging_disconnect_platform'),
    ('POST', '/messaging/platforms/{platform_id}/test', 'messaging_test_platform'),
    ('POST', '/messaging/platforms/{platform_id}/restart-gateway', 'messaging_restart_gateway'),
    ('GET', '/messaging/platforms/{platform_id}/oauth', 'messaging_oauth_status'),
    ('POST', '/messaging/platforms/{platform_id}/oauth/complete', 'messaging_oauth_complete'),
    ('GET', '/discord/callback', 'discord_oauth_callback'),
    ('GET', '/slack/callback', 'slack_oauth_callback'),
]

# Included routers may be kept as lazy wrappers (newer FastAPI) or flattened
# into app.routes (older FastAPI); walk both shapes.
_DUMP_ROUTES = r"""
import json, sys
sys.path.insert(0, ".")
import main

def flat(routes):
    for r in routes:
        if hasattr(r, "effective_candidates"):
            yield from flat(r.effective_candidates())
        elif hasattr(r, "original_router") and not hasattr(r, "path"):
            yield from flat(r.original_router.routes)
        else:
            yield r

print(json.dumps([
    [",".join(sorted(getattr(r, "methods", None) or [])), r.path, getattr(r, "name", None)]
    for r in flat(main.app.routes)
]))
"""

_HAS_REAL_FASTAPI = r"""
import fastapi, sys
sys.exit(0 if hasattr(fastapi, "APIRouter") and hasattr(fastapi, "__version__") else 1)
"""


def _run(code: str, timeout: float = 120) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    # Keep the import side-effect free: no brain, no real profile writes.
    env.setdefault("HERMES_BRIDGE_TOKEN", "")
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(BRIDGE_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class RouteTableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if _run(_HAS_REAL_FASTAPI, timeout=60).returncode != 0:
            raise unittest.SkipTest("real fastapi is not importable")
        proc = _run(_DUMP_ROUTES)
        if proc.returncode != 0:
            raise AssertionError(f"importing main failed:\n{proc.stderr[-4000:]}")
        cls.routes = [tuple(row) for row in json.loads(proc.stdout.strip().splitlines()[-1])]

    def test_route_table_matches_pre_split_snapshot(self):
        self.assertEqual(self.routes, [tuple(row) for row in EXPECTED_ROUTES])

    def test_specific_session_route_precedes_parameterised_siblings(self):
        # Registration order is what decides shadowing; spot-check the family
        # most likely to regress if a router is included out of order.
        paths = [path for _, path, _ in self.routes]
        self.assertLess(paths.index("/sessions"), paths.index("/sessions/{session_id}"))


class NoImportMainTests(unittest.TestCase):
    """Modules split out of main.py must not import main (the B2 double-module bug).

    The bridge runs as `python main.py`; a module-level `import main` from any of
    these would execute main.py a second time with its own, disconnected state.
    """

    SPLIT_MODULES = [
        "bridge_config.py",
        "bridge_state.py",
        "bridge_workspace.py",
        "bridge_providers.py",
        "chat_common.py",
        "chat_impl.py",
        "acp_chat.py",
    ] + sorted(
        str(p.relative_to(BRIDGE_DIR))
        for sub in ("routes", "chat_transports")
        for p in (BRIDGE_DIR / sub).glob("*.py")
    )

    def test_split_modules_do_not_import_main(self):
        offenders = []
        for rel in self.SPLIT_MODULES:
            tree = ast.parse((BRIDGE_DIR / rel).read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import) and any(a.name == "main" for a in node.names):
                    offenders.append(f"{rel}:{node.lineno}")
                if isinstance(node, ast.ImportFrom) and node.module == "main":
                    offenders.append(f"{rel}:{node.lineno}")
        self.assertEqual(offenders, [], f"split modules must not import main: {offenders}")


if __name__ == "__main__":
    unittest.main()
