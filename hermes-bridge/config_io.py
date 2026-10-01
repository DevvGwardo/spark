"""Safe writes for the hermes config files the bridge edits (spec 5.4, G12).

Every write of ``config.yaml`` / ``.env`` goes through here so that:

* a crash or a full disk mid-write never leaves a truncated file — content is
  written to a temp file in the same directory, fsynced, then ``os.replace``d;
* two writers (two requests, or the bridge and the ``hermes`` CLI when it uses
  the same convention) never interleave — writes hold an exclusive ``fcntl``
  lock on a ``<name>.lock`` sidecar. Where ``fcntl`` does not exist (Windows)
  the inter-process lock is a no-op and only the in-process lock applies;
* backups are bounded — at most :data:`BACKUP_KEEP` ``<name>.bak-<ts>`` files
  are kept per config file instead of one per write forever;
* comments survive — YAML edits use ruamel round-trip, and a missing ruamel
  is an error instead of a silent fall back to PyYAML (which drops every
  comment in the user's config).
"""
from __future__ import annotations

import contextlib
import os
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional

try:  # POSIX only
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - Windows
    _fcntl = None

BACKUP_KEEP = 5

_thread_locks: dict[str, threading.RLock] = {}
_thread_locks_guard = threading.Lock()


class ConfigWriteError(RuntimeError):
    """A config file could not be edited safely; nothing was written."""


class ConfigConflictError(ConfigWriteError):
    """The file changed on disk between load and write; the write was refused."""


def _thread_lock(path: Path) -> threading.RLock:
    key = str(path.resolve()) if path.exists() else str(path.absolute())
    with _thread_locks_guard:
        lock = _thread_locks.get(key)
        if lock is None:
            lock = _thread_locks[key] = threading.RLock()
        return lock


@contextlib.contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Hold an exclusive lock for ``path`` (in-process and, on POSIX, inter-process)."""
    path = Path(path)
    with _thread_lock(path):
        if _fcntl is None:
            yield
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = path.with_name(path.name + ".lock")
        fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            _fcntl.flock(fd, _fcntl.LOCK_EX)
            try:
                yield
            finally:
                _fcntl.flock(fd, _fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _backup(path: Path, keep: int) -> None:
    """Copy ``path`` to ``<name>.bak-<ts>`` and prune to the newest ``keep``."""
    if not path.is_file():
        return
    ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = path.with_name(f"{path.name}.bak-{ts}")
    backup.write_bytes(path.read_bytes())
    try:
        os.chmod(backup, path.stat().st_mode & 0o777)
    except OSError:
        pass  # best effort: the copy keeps the default mode
    prune_backups(path, keep)


def prune_backups(path: Path, keep: int = BACKUP_KEEP) -> list[Path]:
    """Delete all but the newest ``keep`` ``<name>.bak-*`` files. Returns the removed paths."""
    backups = sorted(
        path.parent.glob(f"{path.name}.bak-*"),
        # The timestamp suffix sorts chronologically; mtime breaks ties.
        key=lambda p: (p.name, p.stat().st_mtime),
    )
    removed = backups[: max(0, len(backups) - keep)]
    for old in removed:
        with contextlib.suppress(FileNotFoundError):
            old.unlink()
    return removed


def atomic_write_text(
    path: Path,
    text: str,
    *,
    backup: bool = True,
    keep: int = BACKUP_KEEP,
    mode: Optional[int] = None,
    _locked: bool = False,
) -> None:
    """Replace ``path`` with ``text`` atomically, optionally keeping a bounded backup.

    The file keeps its existing permission bits; a new file gets ``mode`` (or the
    process umask default). Pass ``_locked=True`` only when the caller already
    holds :func:`file_lock` for ``path``.
    """
    path = Path(path)
    if not _locked:
        with file_lock(path):
            atomic_write_text(path, text, backup=backup, keep=keep, mode=mode, _locked=True)
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        target_mode = path.stat().st_mode & 0o777
    elif mode is not None:
        target_mode = mode
    else:
        umask = os.umask(0)
        os.umask(umask)
        target_mode = 0o666 & ~umask
    if backup:
        _backup(path, keep)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, target_mode)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def require_ruamel():
    """Return a configured round-trip ``YAML`` instance, or raise if ruamel is missing."""
    try:
        from ruamel.yaml import YAML
    except ImportError as exc:
        raise ConfigWriteError(
            "ruamel.yaml is required to edit config.yaml without discarding its "
            "comments; install the bridge requirements (pip install ruamel.yaml)."
        ) from exc
    yaml_rt = YAML()
    yaml_rt.preserve_quotes = True
    # Don't fold long scalars (e.g. absolute command paths) across lines.
    yaml_rt.width = 4096
    return yaml_rt


def load_yaml_roundtrip(text: str):
    """Parse ``text`` with ruamel round-trip; an empty document is an empty map."""
    yaml_rt = require_ruamel()
    from ruamel.yaml.comments import CommentedMap

    data = yaml_rt.load(text) if text.strip() else None
    return yaml_rt, (data if data is not None else CommentedMap())


def dump_yaml_roundtrip(yaml_rt, data) -> str:
    import io

    buf = io.StringIO()
    yaml_rt.dump(data, buf)
    return buf.getvalue()


@contextlib.contextmanager
def edit_yaml(path: Path, *, backup: bool = True) -> Iterator[dict]:
    """Lock ``path``, yield its round-trip data, and write it back atomically on success.

    The lock spans the whole read-modify-write, so concurrent edits serialize
    instead of one silently overwriting the other. An exception inside the
    block writes nothing.
    """
    path = Path(path)
    with file_lock(path):
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        yaml_rt, data = load_yaml_roundtrip(text)
        yield data
        atomic_write_text(path, dump_yaml_roundtrip(yaml_rt, data), backup=backup, _locked=True)
