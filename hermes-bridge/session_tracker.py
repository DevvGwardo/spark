import os
import threading
import re
import time
from datetime import datetime, timezone


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return value if value > 0 else default


class _BoundedSessions(dict):
    """In-memory chat-session tracker bounded by count and age (spec 5.5, G16).

    Every chat turn inserts an entry and nothing ever removed one, so a
    long-running bridge grew without bound. Pruning runs on insert (callers
    hold ``_sessions_lock``):

    * finished entries (``status != "active"``) expire ``ttl`` seconds after
      their last update; ``active`` ones get ``active_ttl`` (a turn whose
      finalize never ran must not pin memory forever);
    * past ``max_entries`` the least recently updated entries go first,
      finished before active.

    The entries are a live view only — the durable record is state.db.
    """

    def __init__(self, *, max_entries: int, ttl: float, active_ttl: float):
        super().__init__()
        self.max_entries = max_entries
        self.ttl = ttl
        self.active_ttl = active_ttl

    @staticmethod
    def _updated(entry) -> float:
        if not isinstance(entry, dict):
            return 0.0
        stamp = entry.get("updated_at") or entry.get("created_at")
        if not stamp:
            return time.time()
        try:
            return datetime.fromisoformat(str(stamp)).timestamp()
        except ValueError:
            return 0.0

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self.prune(keep=key)

    def prune(self, keep=None) -> int:
        now = time.time()
        removed = 0
        for sid, entry in list(self.items()):
            if sid == keep:
                continue
            active = isinstance(entry, dict) and entry.get("status") == "active"
            limit = self.active_ttl if active else self.ttl
            if now - self._updated(entry) > limit:
                super().pop(sid, None)
                removed += 1
        overflow = len(self) - self.max_entries
        if overflow > 0:
            candidates = sorted(
                (sid for sid in self if sid != keep),
                key=lambda sid: (
                    isinstance(self[sid], dict) and self[sid].get("status") == "active",
                    self._updated(self[sid]),
                ),
            )
            for sid in candidates[:overflow]:
                super().pop(sid, None)
                removed += 1
        return removed


# --- Session tracking for Hermes Chats view ---
_sessions: _BoundedSessions = _BoundedSessions(
    max_entries=_env_int("HERMES_BRIDGE_MAX_TRACKED_SESSIONS", 500),
    ttl=_env_int("HERMES_BRIDGE_SESSION_TTL_SECONDS", 6 * 3600),
    active_ttl=_env_int("HERMES_BRIDGE_ACTIVE_SESSION_TTL_SECONDS", 24 * 3600),
)
_sessions_lock = threading.Lock()
_MAX_SESSION_CHAT_MESSAGES = 200
_MAX_SESSION_MESSAGE_CHARS = 12000

def _iso_to_unix(iso_str: str) -> float:
    """Convert ISO timestamp string to unix seconds."""
    try:
        return datetime.fromisoformat(iso_str).timestamp()
    except (ValueError, TypeError):
        return datetime.now(timezone.utc).timestamp()

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _trim_session_message_content(content: str) -> str:
    if len(content) <= _MAX_SESSION_MESSAGE_CHARS:
        return content
    head = _MAX_SESSION_MESSAGE_CHARS // 2
    tail = _MAX_SESSION_MESSAGE_CHARS - head
    return (
        content[:head]
        + "\n\n...[session message truncated]...\n\n"
        + content[-tail:]
    )

def _message_field(message, field: str):
    if isinstance(message, dict):
        return message.get(field)
    return getattr(message, field, None)

def _normalize_message_role(message) -> str:
    role = str(_message_field(message, "role") or "").strip().lower()
    if role in {"system", "user", "assistant", "tool"}:
        return role
    return "assistant"

def _normalize_message_content(message, strip_images: bool = False) -> str:
    content = _message_field(message, "content")
    if content is None:
        return ""
    if isinstance(content, list):
        text_parts = []
        for part in content:
            if isinstance(part, dict):
                part_type = part.get("type", "")
                if part_type == "text":
                    text_parts.append(str(part.get("text", "")))
                elif strip_images and part_type in ("image", "image_url"):
                    pass
        return " ".join(text_parts)
    if strip_images and isinstance(content, str):
        content = re.sub(r"!\[.*?\]\(.*?\)", "", content)
        content = re.sub(r"data:image/[^;]+;base64,", "[image]", content)
    return str(content)

def _normalize_chat_messages(messages, model: str = None, strip_images: bool = False) -> list[dict]:
    from main import _model_supports_vision
    if strip_images and model and not _model_supports_vision(model):
        strip_images = True
    else:
        strip_images = False
    normalized: list[dict] = []
    for message in messages or []:
        normalized.append(
            {
                "role": _normalize_message_role(message),
                "content": _normalize_message_content(message, strip_images=strip_images),
            }
        )
    return normalized

def _append_session_chat_chunk(session_id: str, role: str, text: str):
    if not text:
        return

    with _sessions_lock:
        session = _sessions.get(session_id)
        if not session:
            return

        chat = session.setdefault("chat", [])
        if (
            role == "assistant"
            and chat
            and chat[-1].get("role") == "assistant"
        ):
            merged = f"{chat[-1].get('content', '')}{text}"
            chat[-1]["content"] = _trim_session_message_content(merged)
        else:
            chat.append(
                {
                    "role": role,
                    "content": _trim_session_message_content(text),
                }
            )

        if len(chat) > _MAX_SESSION_CHAT_MESSAGES:
            session["chat"] = chat[-_MAX_SESSION_CHAT_MESSAGES:]

        session["messages"] = len(session.get("chat", []))
        session["updated_at"] = _now_iso()

def _session_summary(session: dict) -> dict:
    summary = dict(session)
    summary.pop("chat", None)
    summary.pop("profile", None)
    return summary
