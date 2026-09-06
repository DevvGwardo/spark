"""Local .mcpb extension tools for the Hermes bridge (Python side only).

Installed extensions are owned by Node (it spawns worker processes and
serves the JSON-RPC proxy). This module only *discovers* them via the
Node API and shapes them into the custom-tool dicts consumed by
``hermes_adapter.CustomMCPServerProvider``. All failures are fail-soft
(return ``[]``) so chat never breaks when Node is down. Pure except fetch.
"""

import os

DEFAULT_NODE_BASE_URL = "http://127.0.0.1:3001"


def node_base_url() -> str:
    """Node API base URL.

    Precedence: ``CLOUDCHAT_API_BASE`` (full URL, repo precedent — see
    kanban_tools/team_tools) → ``ELECTRON_API_PORT`` (set by Electron's
    main process before the bridge spawns; inherited via ``...process.env``
    in electron/bridge.ts) → ``PORT`` → loopback default.
    """
    base = (os.environ.get("CLOUDCHAT_API_BASE") or "").strip()
    if base:
        return base.rstrip("/")
    for var in ("ELECTRON_API_PORT", "PORT"):
        port = (os.environ.get(var) or "").strip()
        if port.isdigit():
            return f"http://127.0.0.1:{port}"
    return DEFAULT_NODE_BASE_URL


def fetch_local_extensions(timeout: float = 5.0) -> list[dict]:
    """GET {node}/api/mcp-extensions. ANY failure -> [] fail-soft."""
    import httpx

    url = f"{node_base_url()}/api/mcp-extensions"
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        print(
            f"[hermes-bridge] local extensions unavailable ({exc}); "
            "continuing without them",
            flush=True,
        )
        return []
    if isinstance(data, dict):
        for key in ("extensions", "items", "data"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        print(
            "[hermes-bridge] local extensions response was not a list; "
            "continuing without them",
            flush=True,
        )
        return []
    return [e for e in data if isinstance(e, dict)]


def to_custom_tools(extensions: list[dict], node_base: str) -> list[dict]:
    """Shape each installed {id/serverId/name} into a provider ct-dict.

    ``serverId`` arrives already in ``ext:<id>`` form per the registry
    (``toRef``/``enableExtension`` in
    server/lib/mcp-extension-installer.ts spawn the worker under
    ``record.serverId``), so it feeds the RPC URL verbatim.
    """
    tools: list[dict] = []
    base = (node_base or "").rstrip("/") or DEFAULT_NODE_BASE_URL
    for ext in extensions:
        if not isinstance(ext, dict):
            continue
        server_id = str(ext.get("serverId") or "").strip()
        if not server_id:
            ext_id = str(ext.get("id") or "").strip()
            if ext_id:
                server_id = f"ext:{ext_id}"
        if not server_id:
            continue
        tool_name = str(ext.get("id") or server_id).strip()
        label = str(ext.get("name") or tool_name).strip() or tool_name
        version = str(ext.get("version") or "").strip()
        description = f"Local extension '{label}'" + (
            f" (v{version})" if version else ""
        )
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": True,
                    },
                },
                "mcp_server_id": server_id,
                "mcp_server_url": f"{base}/api/mcp-workers/{server_id}/rpc",
                "mcp_server_api_key": None,
            }
        )
    return tools


def local_extension_tools() -> list[dict]:
    """Compose fetch + shape. Fail-soft: [] when Node is unreachable."""
    base = node_base_url()
    return to_custom_tools(fetch_local_extensions(), base)
