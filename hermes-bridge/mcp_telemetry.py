"""In-memory MCP telemetry for the CloudChat MCP dashboard.

Records per-server tool-call activity (counts, latency, errors, recent calls,
minute-bucketed history) from the bridge's on_tool_start/on_tool_end hooks,
exposes a live-status snapshot via the in-process hermes-agent MCP layer
(``tools.mcp_tool``), and tails the shared ``~/.hermes/logs/mcp-stderr.log``
per server.

State is held in memory for fast reads and write-through-persisted to a small
SQLite database (see :func:`init_persistence`) so per-server metrics, minute
buckets, and the recent-activity feed survive a bridge restart. If persistence
is never initialized (e.g. in tests), the module degrades to in-memory only.
"""

from __future__ import annotations

import re
import sqlite3
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional

_lock = threading.Lock()

# How many recent calls to keep (per server and globally).
_RECENT_MAX = 100
# Minute buckets retained for activity charts (2 hours).
_BUCKET_MINUTES = 120
# How much of the tail of mcp-stderr.log to scan when serving logs.
_LOG_TAIL_BYTES = 512 * 1024

_LOG_HEADER_RE = re.compile(r"^===== \[(.+?)\] starting MCP server '(.+)' =====$")


class _ServerStats:
    __slots__ = ("calls", "errors", "total_latency_ms", "last_call_at", "last_tool",
                 "last_error", "recent", "buckets")

    def __init__(self) -> None:
        self.calls = 0
        self.errors = 0
        self.total_latency_ms = 0.0
        self.last_call_at: Optional[float] = None
        self.last_tool: Optional[str] = None
        self.last_error: Optional[str] = None
        # deque of {tool, ts, latency_ms, ok, input, output}
        self.recent: deque = deque(maxlen=_RECENT_MAX)
        # deque of [epoch_minute, calls, errors]
        self.buckets: deque = deque(maxlen=_BUCKET_MINUTES)


_stats: Dict[str, _ServerStats] = {}
_global_recent: deque = deque(maxlen=_RECENT_MAX)
# tool_name -> (start monotonic, start epoch, input snippet). Last-start wins;
# parallel calls of the same tool yield approximate latency, which is fine.
_inflight: Dict[str, tuple] = {}
_started_at = time.time()

# sanitized server name -> raw config name (e.g. agent_chat_room -> agent-chat-room).
# Accumulated from live status so disconnected/uninstalled servers that still
# have recorded stats keep their display name and don't render a duplicate card.
_name_map: Dict[str, str] = {}

# Optional SQLite persistence. ``_db`` is None until init_persistence() runs.
_db: Optional[sqlite3.Connection] = None
_db_lock = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS server_stats(
  server TEXT PRIMARY KEY,
  calls INTEGER, errors INTEGER, total_latency_ms REAL,
  last_call_at REAL, last_tool TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS server_buckets(
  server TEXT, minute INTEGER, calls INTEGER, errors INTEGER,
  PRIMARY KEY(server, minute)
);
CREATE TABLE IF NOT EXISTS recent_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server TEXT, tool TEXT, ts REAL, latency_ms REAL, ok INTEGER,
  input TEXT, output TEXT
);
CREATE TABLE IF NOT EXISTS server_names(
  sanitized TEXT PRIMARY KEY, raw TEXT
);
"""


def _sanitize(name: str) -> str:
    """Mirror hermes-agent's sanitize_mcp_name_component closely enough for
    prefix matching: any character outside [A-Za-z0-9_] (hyphens included)
    becomes an underscore, matching the agent's behavior exactly."""
    return re.sub(r"[^A-Za-z0-9_]", "_", str(name or ""))


def resolve_server(tool_name: str, known_servers: Optional[List[str]] = None) -> Optional[str]:
    """Map an agent tool name back to the MCP server that registered it."""
    if not tool_name.startswith("mcp_"):
        return None
    # Authoritative: the agent's provenance map captured at registration time.
    try:
        from tools.mcp_tool import _mcp_tool_server_names, _lock as _agent_lock
        with _agent_lock:
            server = _mcp_tool_server_names.get(tool_name)
        if server:
            return server
    except Exception:
        pass
    # Fallback: prefix-match against known server names (longest first so
    # underscore-containing names win over their prefixes).
    if known_servers:
        for name in sorted(known_servers, key=len, reverse=True):
            if tool_name.startswith(f"mcp_{_sanitize(name)}_"):
                return _sanitize(name)
    return None


def record_tool_start(tool_name: str, tool_input: str) -> None:
    if not tool_name.startswith("mcp_"):
        return
    with _lock:
        _inflight[tool_name] = (time.monotonic(), time.time(), (tool_input or "")[:400])


def record_tool_end(tool_name: str, tool_output: str, known_servers: Optional[List[str]] = None) -> None:
    if not tool_name.startswith("mcp_"):
        return
    server = resolve_server(tool_name, known_servers)
    now = time.time()
    output = tool_output or ""
    # Heuristic: hermes registry tool errors surface as "Error..." text.
    ok = not output.lstrip().lower().startswith(("error", "tool error", "{\"error\""))
    with _lock:
        # Always reap the inflight entry, even if we can't attribute the call
        # to a server — otherwise it leaks and poisons the next call's latency.
        started = _inflight.pop(tool_name, None)
        if not server:
            return
        latency_ms = round((time.monotonic() - started[0]) * 1000, 1) if started else None
        st = _stats.setdefault(server, _ServerStats())
        st.calls += 1
        if not ok:
            st.errors += 1
            st.last_error = output[:400]
        if latency_ms is not None:
            st.total_latency_ms += latency_ms
        st.last_call_at = now
        st.last_tool = tool_name
        entry = {
            "server": server,
            "tool": tool_name,
            "ts": now,
            "latency_ms": latency_ms,
            "ok": ok,
            "input": started[2] if started else "",
            "output": output[:400],
        }
        st.recent.append(entry)
        _global_recent.append(entry)
        minute = int(now // 60)
        if st.buckets and st.buckets[-1][0] == minute:
            st.buckets[-1][1] += 1
            if not ok:
                st.buckets[-1][2] += 1
        else:
            st.buckets.append([minute, 1, 0 if ok else 1])
        # Capture scalar snapshots for write-through persistence (done outside
        # the in-memory lock to avoid holding it during disk I/O).
        stats_snapshot = (st.calls, st.errors, st.total_latency_ms,
                          st.last_call_at, st.last_tool, st.last_error)
        bucket_snapshot = list(st.buckets[-1])

    _persist_call(server, stats_snapshot, bucket_snapshot, entry)


# ── persistence ──────────────────────────────────────────────────────────────


def init_persistence(db_path) -> bool:
    """Open (or create) the telemetry SQLite DB and restore prior state.

    Safe to call once at bridge startup. Returns True if persistence is active.
    On any failure the module silently continues in-memory-only.
    """
    global _db
    try:
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        conn.commit()
        with _db_lock:
            _db = conn
        _restore_from_db()
        return True
    except Exception as e:
        print(f"[mcp-telemetry] persistence disabled: {e}", flush=True)
        _db = None
        return False


def _restore_from_db() -> None:
    """Load persisted stats, buckets, and recent calls into memory."""
    global _started_at
    if _db is None:
        return
    with _db_lock:
        stats_rows = _db.execute(
            "SELECT server,calls,errors,total_latency_ms,last_call_at,last_tool,last_error FROM server_stats"
        ).fetchall()
        bucket_rows = _db.execute(
            "SELECT server,minute,calls,errors FROM server_buckets ORDER BY minute ASC"
        ).fetchall()
        recent_rows = _db.execute(
            "SELECT server,tool,ts,latency_ms,ok,input,output FROM recent_calls ORDER BY id ASC"
        ).fetchall()
        try:
            name_rows = _db.execute("SELECT sanitized,raw FROM server_names").fetchall()
        except Exception:
            name_rows = []
    for san, raw in name_rows:
        _name_map[san] = raw
    with _lock:
        for server, calls, errors, total_lat, last_call_at, last_tool, last_error in stats_rows:
            st = _stats.setdefault(server, _ServerStats())
            st.calls = calls or 0
            st.errors = errors or 0
            st.total_latency_ms = total_lat or 0.0
            st.last_call_at = last_call_at
            st.last_tool = last_tool
            st.last_error = last_error
        by_server: Dict[str, list] = {}
        for server, minute, calls, errors in bucket_rows:
            by_server.setdefault(server, []).append([minute, calls, errors])
        for server, blist in by_server.items():
            st = _stats.setdefault(server, _ServerStats())
            for b in blist[-_BUCKET_MINUTES:]:
                st.buckets.append(b)
        earliest: Optional[float] = None
        for server, tool, ts, latency_ms, ok, inp, out in recent_rows:
            entry = {
                "server": server, "tool": tool, "ts": ts,
                "latency_ms": latency_ms, "ok": bool(ok),
                "input": inp or "", "output": out or "",
            }
            _global_recent.append(entry)
            st = _stats.get(server)
            if st is not None:
                st.recent.append(entry)
            if ts and (earliest is None or ts < earliest):
                earliest = ts
        if earliest is not None:
            _started_at = min(_started_at, earliest)
    if stats_rows:
        print(f"[mcp-telemetry] restored {len(stats_rows)} server(s) from disk", flush=True)


def _persist_call(server: str, stats: tuple, bucket: list, entry: dict) -> None:
    """Write-through one recorded call: upsert cumulative stats + current bucket,
    append to the capped recent-calls log, and prune stale rows."""
    if _db is None:
        return
    calls, errors, total_lat, last_call_at, last_tool, last_error = stats
    minute, b_calls, b_errors = bucket
    with _db_lock:
        try:
            _db.execute(
                "INSERT INTO server_stats(server,calls,errors,total_latency_ms,last_call_at,last_tool,last_error) "
                "VALUES(?,?,?,?,?,?,?) ON CONFLICT(server) DO UPDATE SET "
                "calls=excluded.calls,errors=excluded.errors,total_latency_ms=excluded.total_latency_ms,"
                "last_call_at=excluded.last_call_at,last_tool=excluded.last_tool,last_error=excluded.last_error",
                (server, calls, errors, total_lat, last_call_at, last_tool, last_error),
            )
            _db.execute(
                "INSERT INTO server_buckets(server,minute,calls,errors) VALUES(?,?,?,?) "
                "ON CONFLICT(server,minute) DO UPDATE SET calls=excluded.calls,errors=excluded.errors",
                (server, minute, b_calls, b_errors),
            )
            _db.execute(
                "INSERT INTO recent_calls(server,tool,ts,latency_ms,ok,input,output) VALUES(?,?,?,?,?,?,?)",
                (entry["server"], entry["tool"], entry["ts"], entry["latency_ms"],
                 1 if entry["ok"] else 0, entry["input"], entry["output"]),
            )
            # Keep only the most recent calls and a bounded bucket window.
            _db.execute(
                "DELETE FROM recent_calls WHERE id NOT IN "
                "(SELECT id FROM recent_calls ORDER BY id DESC LIMIT ?)",
                (_RECENT_MAX,),
            )
            _db.execute("DELETE FROM server_buckets WHERE minute < ?", (minute - _BUCKET_MINUTES,))
            _db.commit()
        except Exception as e:
            print(f"[mcp-telemetry] persist failed: {e}", flush=True)


def _remember_names(status: List[dict]) -> None:
    """Learn sanitized->raw name mappings from live status and persist new ones."""
    new: List[tuple] = []
    for s in status:
        if not isinstance(s, dict) or not s.get("name"):
            continue
        raw = s["name"]
        san = _sanitize(raw)
        if _name_map.get(san) != raw:
            _name_map[san] = raw
            new.append((san, raw))
    if new and _db is not None:
        with _db_lock:
            try:
                _db.executemany(
                    "INSERT INTO server_names(sanitized,raw) VALUES(?,?) "
                    "ON CONFLICT(sanitized) DO UPDATE SET raw=excluded.raw",
                    new,
                )
                _db.commit()
            except Exception:
                pass


def _live_status() -> List[dict]:
    """Live connection status from the in-process agent MCP layer."""
    try:
        from tools.mcp_tool import get_mcp_status
        status = get_mcp_status()
        return status if isinstance(status, list) else []
    except Exception:
        return []


def _tools_by_server() -> Dict[str, List[str]]:
    """Reverse the agent's tool->server provenance map."""
    try:
        from tools.mcp_tool import _mcp_tool_server_names, _lock as _agent_lock
        with _agent_lock:
            items = list(_mcp_tool_server_names.items())
    except Exception:
        return {}
    out: Dict[str, List[str]] = {}
    for tool, server in items:
        out.setdefault(server, []).append(tool)
    for tools in out.values():
        tools.sort()
    return out


def snapshot() -> dict:
    """Full telemetry snapshot for the dashboard: live status, per-server
    stats + minute buckets, tool names, and a global recent-activity feed.

    Server identity is normalized to the *raw* config name used by
    ``get_mcp_status`` (e.g. ``agent-chat-room``). Internally, stats and the
    tool provenance map are keyed by the *sanitized* name (``agent_chat_room``),
    so we build a sanitized→raw map from the live status and remap on the way
    out — otherwise the dashboard would render duplicate, mismatched cards.
    """
    status = _live_status()
    # Learn names from the current live status, then resolve against the
    # accumulated map so servers that have dropped out of live status (but
    # still have recorded stats) keep their raw display name.
    _remember_names(status)

    def canon(key: str) -> str:
        return _name_map.get(key, key)

    with _lock:
        servers: Dict[str, Any] = {}
        for name, st in _stats.items():
            recent_out = [{**c, "server": canon(c.get("server", name))} for c in st.recent]
            servers[canon(name)] = {
                "calls": st.calls,
                "errors": st.errors,
                "avg_latency_ms": round(st.total_latency_ms / st.calls, 1) if st.calls else None,
                "last_call_at": st.last_call_at,
                "last_tool": st.last_tool,
                "last_error": st.last_error,
                "recent": recent_out,
                "buckets": [list(b) for b in st.buckets],
            }
        recent = [{**c, "server": canon(c.get("server", ""))} for c in _global_recent]

    tools = {canon(srv): tools for srv, tools in _tools_by_server().items()}

    return {
        "generated_at": time.time(),
        "tracking_since": _started_at,
        "status": status,
        "tools": tools,
        "servers": servers,
        "recent": recent,
    }


def read_server_logs(hermes_home: Path, server_name: str, limit: int = 200) -> List[dict]:
    """Tail ``logs/mcp-stderr.log``, returning the last *limit* lines belonging
    to *server_name*'s sections (delimited by per-server start headers)."""
    path = Path(hermes_home) / "logs" / "mcp-stderr.log"
    if not path.is_file():
        return []
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            if size > _LOG_TAIL_BYTES:
                f.seek(size - _LOG_TAIL_BYTES)
                f.readline()  # drop the partial first line
            text = f.read().decode("utf-8", errors="replace")
    except Exception:
        return []
    want = _sanitize(server_name)
    lines: deque = deque(maxlen=max(1, min(limit, 1000)))
    current: Optional[str] = None
    current_ts: Optional[str] = None
    for line in text.splitlines():
        m = _LOG_HEADER_RE.match(line)
        if m:
            current_ts, current = m.group(1), _sanitize(m.group(2))
            if current == want:
                lines.append({"ts": current_ts, "line": f"— session started {current_ts} —", "marker": True})
            continue
        if current == want and line.strip():
            lines.append({"ts": current_ts, "line": line, "marker": False})
    return list(lines)
