"""Extract computer-use screenshot frames from Hermes multimodal tool results."""

from __future__ import annotations

import logging
import json
import os
import re
import threading
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

_COMPUTER_USE_TOOL_NAMES = frozenset({"computer_use", "computer"})

# Injected into ephemeral system prompt when computer_use is enabled.
COMPUTER_USE_CAPTURE_HINT = (
    "For computer_use: set capture_after: true on mutating actions (click, type, "
    "scroll, key) and run capture every few steps so the UI can show screenshots."
)

# Mid-action poller defaults (daemon thread during computer_use tool calls).
CU_POLL_INTERVAL_SEC = 1.5
CU_POLL_MAX_ATTEMPTS = 8
CU_CAPTURE_TIMEOUT_SEC = 5.0

# Monkeypatch state for aux-vision routing bypass (Spark dock screenshots).
_CU_AUX_PATCH_ORIGINAL: Optional[Callable[[], bool]] = None


def is_computer_use_tool(tool_name: str | None) -> bool:
    return str(tool_name or "").strip().lower() in _COMPUTER_USE_TOOL_NAMES


def spark_keep_cu_screenshots_enabled() -> bool:
    """True when Spark asked to preserve multimodal CU screenshots."""
    return os.environ.get("SPARK_KEEP_CU_SCREENSHOTS", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def install_spark_keep_cu_screenshots_patch() -> bool:
    """Bypass aux-vision stripping when ``SPARK_KEEP_CU_SCREENSHOTS=1``.

    Hermes ``_should_route_through_aux_vision()`` normally converts captures to
    text-only for non-vision main models. Spark sets the env var and installs
    this wrapper so the dock still receives ``_multimodal`` PNG payloads;
    vision-capable models continue to get images in tool results.
    """
    global _CU_AUX_PATCH_ORIGINAL
    try:
        import tools.computer_use.tool as cu_tool
    except ImportError:
        return False

    if _CU_AUX_PATCH_ORIGINAL is not None:
        return True

    original = cu_tool._should_route_through_aux_vision

    def _wrapped() -> bool:
        if spark_keep_cu_screenshots_enabled():
            return False
        return original()

    cu_tool._should_route_through_aux_vision = _wrapped
    _CU_AUX_PATCH_ORIGINAL = original
    return True


def restore_spark_keep_cu_screenshots_patch() -> None:
    """Restore the original aux-vision routing function after a Spark session."""
    global _CU_AUX_PATCH_ORIGINAL
    if _CU_AUX_PATCH_ORIGINAL is None:
        return
    try:
        import tools.computer_use.tool as cu_tool

        cu_tool._should_route_through_aux_vision = _CU_AUX_PATCH_ORIGINAL
    except ImportError:
        pass
    _CU_AUX_PATCH_ORIGINAL = None


def _image_url_from_part(part: Any) -> Optional[str]:
    if not isinstance(part, dict):
        return None
    if part.get("type") != "image_url":
        return None
    image_url = part.get("image_url")
    if isinstance(image_url, dict):
        url = image_url.get("url")
        return str(url) if isinstance(url, str) and url.strip() else None
    if isinstance(image_url, str) and image_url.strip():
        return image_url
    return None


def _data_url_from_capture_b64(png_b64: str, mime: Optional[str] = None) -> str:
    resolved_mime = (mime or "image/png").strip() or "image/png"
    if not resolved_mime.startswith("image/"):
        resolved_mime = f"image/{resolved_mime}"
    return f"data:{resolved_mime};base64,{png_b64}"


def extract_image_data_url(result: Any) -> Optional[str]:
    """Return a data: image URL from a Hermes tool result, if present."""
    if result is None:
        return None

    if isinstance(result, str):
        text = result.strip()
        if not text:
            return None
        if text.startswith("data:image/"):
            return text
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            match = re.search(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", text)
            return match.group(0) if match else None
        return extract_image_data_url(parsed)

    if isinstance(result, dict):
        if result.get("_multimodal"):
            content = result.get("content")
            if isinstance(content, list):
                for part in content:
                    url = _image_url_from_part(part)
                    if url:
                        return url
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            nested = extract_image_data_url(structured)
            if nested:
                return nested
        for key in ("image", "image_url", "screenshot", "screenshot_png_b64", "png_b64"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                if value.startswith("data:image/"):
                    return value
                if key.endswith("b64") or (len(value) > 64 and "/" not in value[:32]):
                    return f"data:image/png;base64,{value}"
        nested = result.get("result")
        if nested is not None and nested is not result:
            return extract_image_data_url(nested)

    if isinstance(result, list):
        for item in result:
            url = _image_url_from_part(item)
            if url:
                return url
            nested = extract_image_data_url(item)
            if nested:
                return nested

    return None


def is_cua_capture_available() -> bool:
    """Return True when cua-driver backend can be used for lightweight captures."""
    try:
        from tools.computer_use.tool import _get_backend
    except ImportError:
        return False
    try:
        backend = _get_backend()
        return bool(backend.is_available())
    except Exception:  # noqa: BLE001 - availability probe; any backend failure means unavailable
        return False


def try_supplemental_capture(timeout: float = CU_CAPTURE_TIMEOUT_SEC) -> Optional[str]:
    """Best-effort vision-mode screenshot for Spark dock frames.

    Uses cua-driver via the Hermes computer_use backend (get_window_state /
    screenshot under the hood). Never raises; returns None when unavailable or
    timed out.
    """
    if not is_cua_capture_available():
        return None

    holder: list[Optional[str]] = [None]

    def _run() -> None:
        try:
            from tools.computer_use.tool import _get_backend

            backend = _get_backend()
            if not backend.is_available():
                return
            cap = backend.capture(mode="vision")
            if cap and cap.png_b64:
                holder[0] = _data_url_from_capture_b64(cap.png_b64, cap.image_mime_type)
        except Exception:  # noqa: BLE001 - supplemental capture is best-effort; thread exits quietly
            return

    thread = threading.Thread(target=_run, name="cu-supplemental-capture", daemon=True)
    thread.start()
    thread.join(timeout)
    return holder[0]


class ComputerUseFramePoller:
    """Daemon poller that emits running CU frames with mid-action screenshots."""

    def __init__(
        self,
        *,
        tool_name: str,
        args: Any,
        on_frame: Callable[[dict[str, Any]], None],
        interval_sec: float = CU_POLL_INTERVAL_SEC,
        max_polls: int = CU_POLL_MAX_ATTEMPTS,
        capture_timeout: float = CU_CAPTURE_TIMEOUT_SEC,
    ):
        self.tool_name = tool_name
        self.args = args
        self.on_frame = on_frame
        self.interval_sec = interval_sec
        self.max_polls = max_polls
        self.capture_timeout = capture_timeout
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if not is_cua_capture_available():
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="cu-frame-poller", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        polls = 0
        while not self._stop.is_set() and polls < self.max_polls:
            if self._stop.wait(self.interval_sec):
                break
            image = try_supplemental_capture(timeout=self.capture_timeout)
            polls += 1
            if self._stop.is_set() or not image:
                continue
            payload = build_computer_use_frame_payload(
                tool_name=self.tool_name,
                args=self.args,
                status="running",
                image=image,
            )
            if not payload:
                continue
            try:
                self.on_frame(payload)
            except Exception:  # noqa: BLE001 - on_frame callback raised; ignored so frame loop continues; logged at debug
                logger.debug("on_frame callback raised; ignored so frame loop continues", exc_info=True)


def format_computer_use_action_label(args: Any) -> str:
    """Human-readable action label from computer_use tool args."""
    parsed: dict[str, Any]
    if isinstance(args, dict):
        parsed = args
    elif isinstance(args, str) and args.strip():
        try:
            raw = json.loads(args)
            parsed = raw if isinstance(raw, dict) else {}
        except (json.JSONDecodeError, TypeError):
            parsed = {}
    else:
        parsed = {}

    action = str(parsed.get("action") or "action").strip() or "action"
    parts = [action.replace("_", " ")]

    mode = parsed.get("mode")
    if isinstance(mode, str) and mode.strip():
        parts.append(mode)

    app = parsed.get("app")
    if isinstance(app, str) and app.strip():
        parts.append(app)

    element = parsed.get("element")
    if element is not None:
        parts.append(f"#{element}")

    coordinate = parsed.get("coordinate")
    if isinstance(coordinate, list) and len(coordinate) >= 2:
        parts.append(f"({coordinate[0]}, {coordinate[1]})")

    text = parsed.get("text")
    if isinstance(text, str) and text.strip():
        snippet = text.strip()
        if len(snippet) > 24:
            snippet = snippet[:24] + "…"
        parts.append(f'"{snippet}"')

    key = parsed.get("key")
    if isinstance(key, str) and key.strip():
        parts.append(key)

    return " · ".join(parts)


def build_computer_use_frame_payload(
    *,
    tool_name: str,
    args: Any,
    result: Any = None,
    status: str = "completed",
    image: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Build a compact SSE payload for a computer-use frame.

    Running frames include an action label and may carry a supplemental image
    from the mid-action poller. Completed frames include an image from the tool
    result (multimodal / capture_after) or an explicit supplemental capture.
    """
    if not is_computer_use_tool(tool_name):
        return None
    action = format_computer_use_action_label(args)
    if status == "running":
        payload: dict[str, Any] = {
            "tool": tool_name,
            "status": "running",
            "action": action,
        }
        if image:
            payload["image"] = image
        return payload

    resolved_image = image or extract_image_data_url(result)
    if not resolved_image:
        return None
    return {
        "tool": tool_name,
        "status": "completed",
        "action": action,
        "image": resolved_image,
    }


def computer_use_text_summary(result: Any) -> str:
    """Text-only summary for chat persistence (never includes base64)."""
    if result is None:
        return ""
    if isinstance(result, str):
        text = result.strip()
        if not text:
            return ""
        if text.startswith("data:image/"):
            return "computer_use capture"
        if "base64," in text and len(text) > 200:
            return "computer_use capture"
        return text[:500]
    if isinstance(result, dict):
        if result.get("text_summary"):
            return str(result["text_summary"])[:500]
        if result.get("summary"):
            return str(result["summary"])[:500]
        if result.get("_multimodal"):
            content = result.get("content")
            if isinstance(content, list):
                texts = [
                    str(part.get("text", "")).strip()
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                ]
                joined = "\n".join(t for t in texts if t)
                if joined:
                    return joined[:500]
            return "computer_use capture"
        try:
            return json.dumps(result, ensure_ascii=False)[:500]
        except (TypeError, ValueError):
            return "computer_use"
    return str(result)[:500]
