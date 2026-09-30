import threading
import re
from datetime import datetime, timezone

# --- Session tracking for Hermes Chats view ---
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()
_MAX_SESSION_CHAT_MESSAGES = 200
_MAX_SESSION_MESSAGE_CHARS = 12000

def _iso_to_unix(iso_str: str) -> float:
    """Convert ISO timestamp string to unix seconds."""
    try:
        return datetime.fromisoformat(iso_str).timestamp()
    except Exception:
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
