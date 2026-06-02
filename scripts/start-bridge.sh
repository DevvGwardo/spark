#!/usr/bin/env bash
#
# start-bridge.sh — one-command Hermes bridge startup.
#
# Creates the bridge's virtualenv if needed, installs its (lightweight)
# dependencies, then runs it. Safe to re-run: the venv and deps are only
# set up once, subsequent runs just launch the bridge.
#
# Usage:
#   ./scripts/start-bridge.sh           # start on the default port (3002)
#   HERMES_PORT=4002 ./scripts/start-bridge.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR/../hermes-bridge"

if [ ! -f "$BRIDGE_DIR/main.py" ]; then
  echo "error: bridge source not found at $BRIDGE_DIR" >&2
  exit 1
fi

cd "$BRIDGE_DIR"

# Pick a Python: prefer python3, fall back to python.
PYTHON_BIN="$(command -v python3 || command -v python || true)"
if [ -z "$PYTHON_BIN" ]; then
  echo "error: Python 3 is required but was not found on PATH." >&2
  echo "       Install it from https://www.python.org/downloads/ and re-run." >&2
  exit 1
fi

# Create the venv on first run.
if [ ! -x ".venv/bin/python" ]; then
  echo "→ Creating virtualenv (.venv)…"
  "$PYTHON_BIN" -m venv .venv
fi

# Install/upgrade the bridge's dependencies (idempotent, fast — 4 packages).
echo "→ Installing bridge dependencies…"
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
.venv/bin/python -m pip install --quiet --upgrade -r requirements.txt

echo "→ Starting Hermes bridge on port ${HERMES_PORT:-3002}…"
exec .venv/bin/python main.py
