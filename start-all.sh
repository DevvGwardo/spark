#!/bin/bash
# Start all CloudChat services
# Usage: ./start-all.sh       (start everything)
#        ./start-all.sh stop  (kill everything)

PROJECT_DIR="$HOME/cloud-chat-hub"
BRIDGE_DIR="$PROJECT_DIR/hermes-bridge"

if [ "$1" = "stop" ]; then
  echo "Stopping services..."
  kill $(lsof -ti:8080) 2>/dev/null && echo "  Stopped frontend (8080)" || echo "  Frontend not running"
  kill $(lsof -ti:3001) 2>/dev/null && echo "  Stopped API server (3001)" || echo "  API server not running"
  kill $(lsof -ti:3002) 2>/dev/null && echo "  Stopped Hermes bridge (3002)" || echo "  Hermes bridge not running"
  exit 0
fi

echo "Starting CloudChat services..."

# 1. Hermes bridge
if curl -s --max-time 1 http://localhost:3002/health > /dev/null 2>&1; then
  echo "  [OK] Hermes bridge already running on :3002"
else
  echo "  Starting Hermes bridge on :3002..."
  cd "$BRIDGE_DIR"
  export HERMES_MINIMAX_KEY="${MINIMAX_API_KEY:-$HERMES_MINIMAX_KEY}"
  # Prefer the hermes-agent venv (has all deps for real agent + bridge).
  # Fall back to the bridge's own venv if hermes-agent isn't installed.
  HERMES_VENV="$HOME/.hermes/hermes-agent/venv"
  # Check if hermes-agent venv has fastapi (the bridge depends on it).
  if [ -x "$HERMES_VENV/bin/python3" ] && $HERMES_VENV/bin/python3 -c "import fastapi" 2>/dev/null; then
    echo "  Using real Hermes agent venv"
    BRIDGE_PYTHON="$HERMES_VENV/bin/python3"
  else
    echo "  Hermes agent not found or missing fastapi — using local venv"
    source venv/bin/activate
    BRIDGE_PYTHON="python"
  fi
  nohup $BRIDGE_PYTHON main.py > /tmp/hermes-bridge.log 2>&1 &
  sleep 2
  if curl -s --max-time 2 http://localhost:3002/health > /dev/null 2>&1; then
    echo "  [OK] Hermes bridge started"
  else
    echo "  [!!] Hermes bridge failed — check /tmp/hermes-bridge.log"
  fi
fi

# 2. API server
if curl -s --max-time 1 http://localhost:3001/functions/v1/health > /dev/null 2>&1; then
  echo "  [OK] API server already running on :3001"
else
  echo "  Starting API server on :3001..."
  cd "$PROJECT_DIR"
  nohup npm run server > /tmp/cloudchat-server.log 2>&1 &
  sleep 3
  if curl -s --max-time 2 http://localhost:3001/functions/v1/health > /dev/null 2>&1; then
    echo "  [OK] API server started"
  else
    echo "  [!!] API server failed — check /tmp/cloudchat-server.log"
  fi
fi

# 3. Vite dev server
if curl -s --max-time 1 http://localhost:8080 > /dev/null 2>&1; then
  echo "  [OK] Frontend already running on :8080"
else
  echo "  Starting frontend on :8080..."
  cd "$PROJECT_DIR"
  nohup npm run dev > /tmp/cloudchat-dev.log 2>&1 &
  sleep 3
  if curl -s --max-time 2 http://localhost:8080 > /dev/null 2>&1; then
    echo "  [OK] Frontend started"
  else
    echo "  [!!] Frontend failed — check /tmp/cloudchat-dev.log"
  fi
fi

echo ""
echo "All services:"
echo "  Frontend:      http://localhost:8080"
echo "  API server:    http://localhost:3001"
echo "  Hermes bridge: http://localhost:3002"
