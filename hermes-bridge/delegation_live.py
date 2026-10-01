"""Read Hermes 0.19 live subagent transcripts under cache/delegation/live/."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

_DELEG_ID_RE = re.compile(r"^deleg_[0-9a-fA-F]+$")
_PATH_DELEG_RE = re.compile(r"/live/(deleg_[0-9a-fA-F]+)/task-(\d+)\.log$")


def live_root(hermes_home: Path) -> Path:
    return Path(hermes_home).expanduser().resolve() / "cache" / "delegation" / "live"


def parse_delegation_id_from_path(path: str) -> Optional[str]:
    match = _PATH_DELEG_RE.search(str(path or ""))
    return match.group(1) if match else None


def parse_task_index_from_path(path: str) -> Optional[int]:
    match = _PATH_DELEG_RE.search(str(path or ""))
    if not match:
        return None
    try:
        return int(match.group(2))
    except ValueError:
        return None


def _safe_delegation_dir(hermes_home: Path, delegation_id: str) -> Path:
    raw = str(delegation_id or "").strip()
    if not _DELEG_ID_RE.match(raw):
        raise ValueError("invalid delegation_id")
    root = live_root(hermes_home)
    target = (root / raw).resolve()
    target.relative_to(root)
    return target


def read_manifest(hermes_home: Path, delegation_id: str) -> Dict[str, Any]:
    directory = _safe_delegation_dir(hermes_home, delegation_id)
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"manifest not found for {delegation_id}")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("manifest is not an object")
    data.setdefault("delegation_id", delegation_id)
    return data


def list_recent_manifests(hermes_home: Path, *, limit: int = 8) -> List[Dict[str, Any]]:
    root = live_root(hermes_home)
    if not root.is_dir():
        return []
    entries: List[tuple[float, Dict[str, Any]]] = []
    for child in root.iterdir():
        if not child.is_dir() or not _DELEG_ID_RE.match(child.name):
            continue
        manifest_path = child / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                continue
            data.setdefault("delegation_id", child.name)
            mtime = manifest_path.stat().st_mtime
            entries.append((mtime, data))
        except Exception:  # noqa: BLE001 - one unreadable manifest must not hide the others
            continue
    entries.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in entries[: max(1, min(limit, 20))]]


def latest_manifest(hermes_home: Path) -> Optional[Dict[str, Any]]:
    recent = list_recent_manifests(hermes_home, limit=1)
    return recent[0] if recent else None


def tail_task_log(
    hermes_home: Path,
    delegation_id: str,
    task_index: int,
    *,
    offset: int = 0,
    max_bytes: int = 64_000,
) -> Dict[str, Any]:
    if task_index < 0 or task_index > 64:
        raise ValueError("invalid task_index")
    directory = _safe_delegation_dir(hermes_home, delegation_id)
    log_path = (directory / f"task-{task_index}.log").resolve()
    log_path.relative_to(directory)

    if not log_path.is_file():
        return {
            "delegation_id": delegation_id,
            "task_index": task_index,
            "offset": 0,
            "next_offset": 0,
            "done": False,
            "text": "",
            "lines": [],
        }

    size = log_path.stat().st_size
    start = max(0, int(offset or 0))
    if start > size:
        start = size
    read_len = min(max(1, int(max_bytes or 64_000)), max(0, size - start))
    with open(log_path, "rb") as handle:
        handle.seek(start)
        chunk = handle.read(read_len)
    text = chunk.decode("utf-8", errors="replace")
    next_offset = start + len(chunk)
    lines = [line for line in text.splitlines() if line.strip()]
    return {
        "delegation_id": delegation_id,
        "task_index": task_index,
        "offset": start,
        "next_offset": next_offset,
        "done": next_offset >= size,
        "text": text,
        "lines": lines,
        "size": size,
    }
