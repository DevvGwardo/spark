"""Routes: /workspace/mcp-* (installed servers, catalog, install/uninstall, telemetry).

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import bridge_workspace
import mcp_telemetry

router = APIRouter()


# ------------------------------------------------------------------
# MCP servers — surface the agent's installed MCP servers (read from
# ~/.hermes/config.yaml `mcp_servers`) and one-click install/uninstall
# from a small curated catalog. Writes are additive and backed up; the
# agent's MCP layer is reloaded in-process when possible.
# ------------------------------------------------------------------

# Curated, intentionally-small set of one-click installable MCP servers.
# Server-side is the source of truth so the install endpoint never writes a
# client-supplied command. None of these require secrets.
_MCP_CATALOG: list[dict] = [
    {
        "id": "filesystem",
        "name": "filesystem",
        "description": "Read and write files within a directory you choose.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "{param}"],
        "requires_param": {"key": "root", "label": "Root directory", "placeholder": "~/", "default": "~"},
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    },
    {
        "id": "fetch",
        "name": "fetch",
        "description": "Fetch a URL and return clean, readable markdown.",
        "transport": "stdio",
        "runtime": "python",
        "command": "uvx",
        "args": ["mcp-server-fetch"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    },
    {
        "id": "git",
        "name": "git",
        "description": "Inspect and operate on a local git repository.",
        "transport": "stdio",
        "runtime": "python",
        "command": "uvx",
        "args": ["mcp-server-git", "--repository", "{param}"],
        "requires_param": {"key": "repo", "label": "Repository path", "placeholder": "~/code/my-repo", "default": "."},
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    },
    {
        "id": "memory",
        "name": "memory",
        "description": "A persistent knowledge-graph memory the agent can read and write.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    },
    {
        "id": "sequential-thinking",
        "name": "sequential-thinking",
        "description": "A structured step-by-step reasoning scratchpad for hard problems.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    },
    {
        "id": "playwright",
        "name": "playwright",
        "description": "Drive a real browser — navigate, click, read, and screenshot pages.",
        "transport": "stdio",
        "runtime": "node",
        "command": "npx",
        "args": ["-y", "@playwright/mcp@latest"],
        "docs_url": "https://github.com/microsoft/playwright-mcp",
    },
]

_MCP_CATALOG_BY_ID = {entry["id"]: entry for entry in _MCP_CATALOG}


def _hermes_config_path(hermes_home: Path) -> Path:
    return Path(hermes_home) / "config.yaml"


def _read_hermes_config(hermes_home: Path) -> dict:
    """Load the full config.yaml as a plain dict (empty on any error)."""
    try:
        import yaml
        path = _hermes_config_path(hermes_home)
        if not path.is_file():
            return {}
        with open(path) as f:
            cfg = yaml.safe_load(f)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _normalize_mcp_server_entry(name: str, cfg: dict) -> dict:
    """Map a raw mcp_servers entry to a safe, display-friendly dict.

    Secrets are never returned: env *values* are dropped (names only) and
    HTTP `headers` (which often carry auth tokens) are omitted entirely.
    """
    cfg = cfg if isinstance(cfg, dict) else {}
    url = cfg.get("url")
    transport = "http" if url else "stdio"
    args = cfg.get("args")
    env = cfg.get("env")
    tools = cfg.get("tools")
    return {
        "name": name,
        "transport": transport,
        "command": str(cfg.get("command") or ""),
        "args": [str(a) for a in args] if isinstance(args, list) else [],
        "url": str(url) if isinstance(url, str) else "",
        "enabled": cfg.get("enabled", True) is not False,
        "env_keys": sorted(env.keys()) if isinstance(env, dict) else [],
        "tool_count": len(tools) if isinstance(tools, dict) else 0,
        "catalog_id": name if name in _MCP_CATALOG_BY_ID else None,
    }


def _load_hermes_mcp_servers(hermes_home: Path) -> list[dict]:
    """List the agent's installed MCP servers from config.yaml (secrets redacted)."""
    servers = _read_hermes_config(hermes_home).get("mcp_servers")
    if not isinstance(servers, dict):
        return []
    return [_normalize_mcp_server_entry(name, entry) for name, entry in sorted(servers.items())]


def _mcp_catalog_payload() -> list[dict]:
    """Display-only view of the curated catalog (no internal arg templating)."""
    return [
        {
            "id": e["id"],
            "name": e["name"],
            "description": e["description"],
            "transport": e["transport"],
            "runtime": e.get("runtime", ""),
            "requires_param": e.get("requires_param"),
            "docs_url": e.get("docs_url", ""),
        }
        for e in _MCP_CATALOG
    ]


def _build_mcp_entry_from_catalog(entry: dict, param: Optional[str]) -> dict:
    """Build a config.yaml mcp_servers entry from a catalog template + param."""
    req = entry.get("requires_param") or {}
    resolved: list[str] = []
    for arg in entry.get("args", []):
        if arg == "{param}":
            value = (param or "").strip() or req.get("default", "")
            resolved.append(os.path.expanduser(value))
        else:
            resolved.append(arg)
    built: dict = {"command": entry["command"], "enabled": True}
    if resolved:
        built["args"] = resolved
    return built


def _backup_hermes_config(path: Path) -> None:
    if path.is_file():
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        path.with_name(f"config.yaml.bak-{ts}").write_text(
            path.read_text(encoding="utf-8"), encoding="utf-8"
        )


def _load_hermes_config_editable(hermes_home: Path):
    """Load config.yaml for editing. Returns ``(dump, data)`` where ``dump()``
    backs up the file and writes ``data`` back. Uses ruamel round-trip when
    available (preserves comments/format), else PyYAML (comments lost)."""
    path = _hermes_config_path(hermes_home)
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    try:
        from ruamel.yaml import YAML
        from ruamel.yaml.comments import CommentedMap

        yaml_rt = YAML()
        yaml_rt.preserve_quotes = True
        # Don't fold long scalars (e.g. absolute command paths) across lines.
        yaml_rt.width = 4096
        data = yaml_rt.load(text) if text.strip() else CommentedMap()
        if data is None:
            data = CommentedMap()

        def _dump():
            _backup_hermes_config(path)
            with open(path, "w") as f:
                yaml_rt.dump(data, f)

        return _dump, data
    except Exception:
        import yaml

        data = (yaml.safe_load(text) if text.strip() else {}) or {}

        def _dump():
            _backup_hermes_config(path)
            with open(path, "w") as f:
                yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

        return _dump, data


def _reload_agent_mcp() -> bool:
    """Best-effort in-process reload of the installed agent's MCP layer so a
    freshly-installed server connects without a full bridge restart."""
    try:
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        from tools.mcp_tool_discovery import discover_mcp_tools

        shutdown_mcp_servers()
        discover_mcp_tools()
        return True
    except Exception as exc:
        print(f"[hermes-bridge] MCP reload skipped: {exc}", flush=True)
        return False


def _build_mcp_tool_index(hermes_home: Path) -> list[dict]:
    """Flatten registered MCP tools for the Spark searchable tool index."""
    servers_cfg = _read_hermes_config(hermes_home).get("mcp_servers")
    if not isinstance(servers_cfg, dict):
        servers_cfg = {}

    server_enabled = {
        name: (cfg.get("enabled", True) is not False if isinstance(cfg, dict) else True)
        for name, cfg in servers_cfg.items()
    }

    try:
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.mcp_tool import _mcp_tool_server_names, _lock as _agent_lock
        from tools.registry import registry

        discover_mcp_tools()
        with _agent_lock:
            pairs = list(_mcp_tool_server_names.items())
    except Exception:
        pairs = []
        registry = None  # type: ignore[assignment]

    out: list[dict] = []
    for tool_name, server in pairs:
        if not server_enabled.get(server, True):
            continue
        description = ""
        if registry is not None:
            schema = registry.get_schema(tool_name) or {}
            description = str(schema.get("description") or "")
        out.append({
            "server": server,
            "name": tool_name,
            "description": description,
        })
    out.sort(key=lambda e: (e["server"].lower(), e["name"].lower()))
    return out


class McpInstallRequest(BaseModel):
    id: str
    param: Optional[str] = None


@router.get("/workspace/mcp-servers")
async def workspace_mcp_servers(request: Request):
    """List the MCP servers installed in the hermes-agent's config.yaml."""
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    return JSONResponse(content={"servers": _load_hermes_mcp_servers(hermes_home)})


@router.get("/workspace/mcp-catalog")
async def workspace_mcp_catalog(request: Request):
    """The curated set of one-click installable MCP servers."""
    return JSONResponse(content={"catalog": _mcp_catalog_payload()})


@router.post("/workspace/mcp-servers/install")
async def workspace_mcp_install(request: Request, body: McpInstallRequest):
    """Install a curated MCP server into config.yaml and reload the agent."""
    entry = _MCP_CATALOG_BY_ID.get(body.id)
    if not entry:
        return JSONResponse(status_code=400, content={"error": f"Unknown MCP id: {body.id}"})
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    dump, data = _load_hermes_config_editable(hermes_home)
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict):
        servers = {}
        data["mcp_servers"] = servers
    name = entry["name"]
    if name in servers:
        return JSONResponse(status_code=409, content={"error": f"'{name}' is already installed"})
    servers[name] = _build_mcp_entry_from_catalog(entry, body.param)
    try:
        dump()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write config: {e}"})
    reloaded = _reload_agent_mcp()
    print(f"[hermes-bridge] Installed MCP server '{name}' (reloaded={reloaded})", flush=True)
    return JSONResponse(content={"ok": True, "installed": name, "reloaded": reloaded})


@router.delete("/workspace/mcp-servers/{name}")
async def workspace_mcp_uninstall(name: str, request: Request):
    """Remove a store-installed MCP server. Agent-managed servers stay read-only."""
    if name not in _MCP_CATALOG_BY_ID:
        return JSONResponse(status_code=403, content={"error": "Only store-installed servers can be removed here"})
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    dump, data = _load_hermes_config_editable(hermes_home)
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict) or name not in servers:
        return JSONResponse(status_code=404, content={"error": f"'{name}' is not installed"})
    del servers[name]
    try:
        dump()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write config: {e}"})
    reloaded = _reload_agent_mcp()
    print(f"[hermes-bridge] Removed MCP server '{name}' (reloaded={reloaded})", flush=True)
    return JSONResponse(content={"ok": True, "removed": name, "reloaded": reloaded})


@router.get("/workspace/mcp-telemetry")
async def workspace_mcp_telemetry(request: Request):
    """Live MCP dashboard snapshot: per-server connection status, tool-call
    metrics (counts, latency, errors), minute-bucketed activity, and a recent
    global activity feed. Metrics persist across bridge restarts via SQLite."""
    try:
        snap = mcp_telemetry.snapshot()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"telemetry unavailable: {e}"})
    return JSONResponse(content=snap)


@router.get("/workspace/mcp-tool-index")
async def workspace_mcp_tool_index(request: Request):
    """Searchable MCP tool index: flattened tool names + descriptions from the
    in-process agent registry (enabled servers only)."""
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    try:
        tools = _build_mcp_tool_index(hermes_home)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"tool index unavailable: {e}"})
    return JSONResponse(content={"tools": tools, "total": len(tools)})


@router.get("/workspace/mcp-servers/{name}/logs")
async def workspace_mcp_server_logs(name: str, request: Request):
    """Tail the shared MCP stderr log for a single server (most recent lines)."""
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    try:
        limit = int(request.query_params.get("limit", "200"))
    except (TypeError, ValueError):
        limit = 200
    try:
        lines = mcp_telemetry.read_server_logs(hermes_home, name, limit=limit)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"could not read logs: {e}"})
    return JSONResponse(content={"server": name, "lines": lines})


# ─── Spark's nub MCP server ─────────────────────────────────────────────────
# When the user signs in to Nub in Spark, Spark's server exposes the nub agent
# as an MCP endpoint on loopback and asks the bridge to point Hermes at it.
# config.yaml is the only place every transport reads MCP servers from (ACP
# ignores per-request custom tools), so the entry lives there.

NUB_MCP_NAME = "nub"
_NUB_MCP_PATH = "/api/nub/mcp"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class NubMcpRequest(BaseModel):
    url: str
    token: str


def _is_spark_nub_url(url: object) -> bool:
    """True for an http loopback URL ending in Spark's nub MCP path."""
    from urllib.parse import urlparse

    if not isinstance(url, str):
        return False
    parsed = urlparse(url)
    return (
        parsed.scheme == "http"
        and (parsed.hostname or "") in _LOOPBACK_HOSTS
        and parsed.path.rstrip("/") == _NUB_MCP_PATH
    )


@router.post("/workspace/nub-mcp")
async def workspace_nub_mcp_register(request: Request, body: NubMcpRequest):
    """Add or re-point the `nub` MCP server at Spark's loopback endpoint."""
    if not _is_spark_nub_url(body.url) or not body.token.strip():
        return JSONResponse(status_code=400, content={"error": "url must be Spark's loopback nub MCP endpoint"})
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    dump, data = _load_hermes_config_editable(hermes_home)
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict):
        servers = {}
        data["mcp_servers"] = servers
    existing = servers.get(NUB_MCP_NAME)
    if isinstance(existing, dict) and not _is_spark_nub_url(existing.get("url")):
        # Someone else's server already uses the name; leave it alone.
        return JSONResponse(status_code=409, content={"error": f"'{NUB_MCP_NAME}' is already configured"})
    entry = {
        "url": body.url,
        "headers": {"Authorization": f"Bearer {body.token.strip()}"},
        # One ask waits on a full nub agent turn.
        "timeout": 300,
    }
    if existing == entry:
        return JSONResponse(content={"ok": True, "changed": False, "reloaded": False})
    servers[NUB_MCP_NAME] = entry
    try:
        dump()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write config: {e}"})
    reloaded = _reload_agent_mcp()
    print(f"[hermes-bridge] Pointed MCP server '{NUB_MCP_NAME}' at Spark (reloaded={reloaded})", flush=True)
    return JSONResponse(content={"ok": True, "changed": True, "reloaded": reloaded})


@router.delete("/workspace/nub-mcp")
async def workspace_nub_mcp_unregister(request: Request):
    """Remove the `nub` MCP server, only if Spark added it."""
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    dump, data = _load_hermes_config_editable(hermes_home)
    servers = data.get("mcp_servers")
    existing = servers.get(NUB_MCP_NAME) if isinstance(servers, dict) else None
    if not isinstance(existing, dict) or not _is_spark_nub_url(existing.get("url")):
        return JSONResponse(content={"ok": True, "removed": False})
    del servers[NUB_MCP_NAME]
    try:
        dump()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write config: {e}"})
    reloaded = _reload_agent_mcp()
    return JSONResponse(content={"ok": True, "removed": True, "reloaded": reloaded})
