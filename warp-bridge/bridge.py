#!/usr/bin/env python3
# warp-bridge/bridge.py
# Python port of Warp's parent bridge protocol
#
# Uses the same on-disk protocol as the bash version but exposes a
# cleaner API for programmatic use from Python tools.
#
# Protocol match:
#   staged/<seq>-<msg_id>.json   <- messages from parent
#   surfaced/<seq>-<msg_id>.json  <- hydrated, exposed to child
#   pending-hook-output.json      <- context block
#   pending-hook-output.ack       <- child's ack

import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

BRIDGE_ROOT = Path(os.environ.get("OZ_PARENT_STATE_ROOT", Path.home() / ".oz-bridge"))
MAX_CONTEXT_CHARS = int(os.environ.get("OZ_PARENT_MAX_CONTEXT_CHARS", "6000"))
BRIDGE_PREAMBLE = "Lead-agent update arrived. Treat as authoritative."
BRIDGE_REMAINING_NOTE = "\n\nMore messages are still staged."


class ParentBridge:
    """File-based message bridge between lead agent and child subprocess."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.root = BRIDGE_ROOT / session_id
        self.staged_dir = self.root / "staged"
        self.surfaced_dir = self.root / "surfaced"
        self.hook_output = self.root / "pending-hook-output.json"
        self.hook_ack = self.root / "pending-hook-output.ack"
        self.seq_file = self.root / "sequence"
        self._init_dirs()

    def _init_dirs(self):
        self.root.mkdir(parents=True, exist_ok=True)
        self.staged_dir.mkdir(exist_ok=True)
        self.surfaced_dir.mkdir(exist_ok=True)

    def _next_sequence(self) -> int:
        seq = 0
        if self.seq_file.exists():
            try:
                seq = int(self.seq_file.read_text().strip())
            except ValueError:
                pass
        seq += 1
        self.seq_file.write_text(str(seq))
        return seq

    def _seq_path(self, seq: int, msg_id: str, dir: Path) -> Path:
        return dir / f"{seq:020d}-{msg_id}.json"

    def stage(self, message_id: str, subject: str = "", body: str = ""):
        """Drop a new message into the staged dir (parent side)."""
        seq = self._next_sequence()
        record = {
            "sequence": seq,
            "message_id": message_id,
            "subject": subject,
            "body": body,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
        path = self._seq_path(seq, message_id, self.staged_dir)
        with open(path, "w") as f:
            json.dump(record, f, indent=2)
        return seq

    def _read_records(self, dir: Path) -> list[dict]:
        records = []
        if not dir.exists():
            return records
        for f in sorted(dir.iterdir()):
            if f.suffix == ".json":
                try:
                    records.append(json.loads(f.read_text()))
                except (json.JSONDecodeError, OSError):
                    pass
        return records

    def flush(self) -> Optional[str]:
        """Move staged → surfaced, write hook output. Returns context or None."""
        if self.hook_output.exists():
            return None  # child hasn't consumed yet

        # Remove stale ack
        self.hook_ack.unlink(missing_ok=True)

        # Gather all records (surfaced first, then staged)
        surfaced = self._read_records(self.surfaced_dir)
        staged = self._read_records(self.staged_dir)
        all_records = surfaced + staged

        if not all_records:
            return None

        # Build context block within char limit
        context = BRIDGE_PREAMBLE
        record_count = 0
        total_count = len(all_records)

        for record in all_records:
            seq = record.get("sequence", 0)
            subj = record.get("subject", "") or "(no subject)"
            body = record.get("body", "")

            block = f"---\nLead-agent message #{seq}\nSubject: {subj}\n\n{body}"
            block_len = len(block)

            if record_count > 0:
                block = "\n\n" + block
                block_len += 2

            new_len = len(context) + block_len
            if new_len > MAX_CONTEXT_CHARS and record_count > 0:
                break

            context += block if record_count > 0 else f"\n\n{block}" if record_count == 0 and len(context) > len(BRIDGE_PREAMBLE) else block
            record_count += 1

        # Remaining note
        remaining = total_count - record_count
        if remaining > 0 and len(context) + len(BRIDGE_REMAINING_NOTE) <= MAX_CONTEXT_CHARS:
            context += f"{BRIDGE_REMAINING_NOTE} ({remaining} more)"

        if record_count == 0:
            return None

        # Write hook output
        output = {
            "additional_context": context,
            "surfaced_count": record_count,
            "remaining_staged_count": remaining,
        }
        with open(self.hook_output, "w") as f:
            json.dump(output, f, indent=2)

        # Move staged → surfaced
        for f in self.staged_dir.iterdir():
            if f.suffix == ".json":
                shutil.move(str(f), str(self.surfaced_dir / f.name))

        return context

    def poll(self) -> Optional[str]:
        """Child reads pending context. Returns context or None."""
        if not self.hook_output.exists():
            return None

        try:
            data = json.loads(self.hook_output.read_text())
            context = data.get("additional_context", "")
        except (json.JSONDecodeError, OSError):
            return None

        # Write ack
        ack = {"acknowledged_at": datetime.now(timezone.utc).isoformat()}
        with open(self.hook_ack, "w") as f:
            json.dump(ack, f, indent=2)

        self.hook_output.unlink(missing_ok=True)
        return context

    def process_acks(self):
        """Parent processes ack — clears surfaced records."""
        if not self.hook_ack.exists():
            return

        self.hook_output.unlink(missing_ok=True)

        for f in self.surfaced_dir.iterdir():
            if f.suffix == ".json":
                f.unlink()

        self.hook_ack.unlink(missing_ok=True)

    def cleanup(self):
        """Remove entire session state."""
        if self.root.exists():
            shutil.rmtree(self.root)

    def inject_env(self) -> dict[str, str]:
        """Returns env vars the child needs."""
        return {
            "OZ_PARENT_STATE_ROOT": str(BRIDGE_ROOT),
            "OZ_PARENT_MAX_CONTEXT_CHARS": str(MAX_CONTEXT_CHARS),
            "OZ_BRIDGE_SESSION_ID": self.session_id,
        }
