"""Structured logging for hermes-bridge.

Replaces scattered print() calls with a JSON-structured logger that emits
machine-readable log lines with timestamp, level, module, and optional
request_id for cross-tier tracing.

Usage:
    from bridge_logger import log
    log.info("chat_completions", "request started", model=body.model, provider=provider)
    log.error("acp_transport", "spawn failed", error=str(e), attempt=2)
"""

import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any, Optional


_LOG_LEVEL_MAP = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3}
_MIN_LEVEL = _LOG_LEVEL_MAP.get(
    os.environ.get("HERMES_BRIDGE_LOG_LEVEL", "INFO").upper(), 1
)


class BridgeLogger:
    """Structured JSON logger for hermes-bridge.

    Each log line is a single JSON object with:
    - ts: ISO 8601 timestamp
    - level: DEBUG/INFO/WARNING/ERROR
    - module: logical module name (e.g. "chat", "acp", "cron")
    - msg: human-readable message
    - **extra: any additional key-value pairs
    """

    def __init__(self, stream=None):
        self._stream = stream or sys.stderr

    def _emit(self, level: str, module: str, msg: str, **extra: Any) -> None:
        level_num = _LOG_LEVEL_MAP.get(level, 1)
        if level_num < _MIN_LEVEL:
            return
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "module": module,
            "msg": msg,
        }
        if extra:
            record.update(extra)
        try:
            line = json.dumps(record, default=str, ensure_ascii=False)
            print(line, file=self._stream, flush=True)
        except Exception:
            # Fallback: never let logging break the app
            print(
                f"[hermes-bridge] [{level}] {module}: {msg}",
                file=self._stream,
                flush=True,
            )

    def debug(self, module: str, msg: str, **extra: Any) -> None:
        self._emit("DEBUG", module, msg, **extra)

    def info(self, module: str, msg: str, **extra: Any) -> None:
        self._emit("INFO", module, msg, **extra)

    def warning(self, module: str, msg: str, **extra: Any) -> None:
        self._emit("WARNING", module, msg, **extra)

    def error(self, module: str, msg: str, **extra: Any) -> None:
        self._emit("ERROR", module, msg, **extra)


log = BridgeLogger()
