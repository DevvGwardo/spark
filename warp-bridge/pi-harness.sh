#!/usr/bin/env bash
# warp-bridge/pi-harness.sh
# pi-coding-agent harness following Warp's ThirdPartyHarness pattern
#
# Warp's trait:
#   fn validate()                         -> check CLI installed
#   fn prepare_environment_config(dir, sp, secrets)   -> write config files
#   fn build_runner(prompt, sp, resume, dir, ...)     -> return command + runner
#
# Our bash version:
#   pi_validate         -> check `pi` is on PATH
#   pi_prepare_env $dir -> creates CLAUDE.md / .warp/ config + zen api env
#   pi_build_cmd $prompt $session_id -> returns launch command
#   pi_run $prompt      -> one-shot: validate → prepare → build → execute

source "$(dirname "${BASH_SOURCE[0]}")/parent-bridge.sh"

# Models available on the OpenCode Zen API (no auth, free)
ZEN_BASE_URL="http://localhost:8686/v1"  # our free-llm-router
ZEN_API_KEY="not-needed"
ZEN_MODELS=("minimax-m2.5-free" "nemotron-3-super-free")

# ---- validate ----
pi_validate() {
    if ! command -v pi &>/dev/null; then
        echo "ERROR: pi-coding-agent not found on PATH" >&2
        echo "Install: pip install pi-coding-agent" >&2
        return 1
    fi
    echo "[pi-harness] pi found at $(which pi)" >&2
    return 0
}

# ---- prepare_environment_config ----
# Creates the config files Warp would normally manage, plus injects
# the zen API endpoint for free model access.
pi_prepare_env() {
    local working_dir="${1:-$PWD}"
    local system_prompt="${2:-}"
    local api_key="${3:-}"

    # Create .warp directory following Warp's convention
    mkdir -p "$working_dir/.warp"

    # Write a CLAUDE.md that primes pi to use the zen API
    cat > "$working_dir/CLAUDE.md" <<-EOF
# pi-coding-agent harness config

## Model
Use MiniMax-M2.7 via the OpenCode Zen API endpoint.
The provider is at $ZEN_BASE_URL.
No API key is needed — these are free models.

## Available free models
- minimax-m2.5-free (default, good general purpose)
- nemotron-3-super-free (alternative)

## Bridge
Lead-agent messages arrive via the parent bridge at:
\$OZ_PARENT_STATE_ROOT
Check pending-hook-output.json between turns for new instructions.
EOF

    # Write provider config for pi's openrouter-compatible endpoint
    mkdir -p "$HOME/.config/pi"
    cat > "$HOME/.config/pi/providers.yaml" <<-EOF
providers:
  zen:
    base_url: "$ZEN_BASE_URL"
    api_key: "${api_key:-$ZEN_API_KEY}"
    models:
      - minimax-m2.5-free
      - nemotron-3-super-free
EOF

    # Write system prompt if provided
    if [ -n "$system_prompt" ]; then
        echo "$system_prompt" > "$working_dir/.warp/system-prompt.md"
    fi

    echo "[pi-harness] env prepared at $working_dir" >&2
    echo "  ZEN_BASE_URL=$ZEN_BASE_URL" >&2
    echo "  MODEL=minimax-m2.5-free" >&2
}

# ---- build_runner command ----
# Follows Warp's pattern: claude --session-id UUID --dangerously-skip-permissions < prompt.txt
pi_build_cmd() {
    local prompt="${1:?usage: pi_build_cmd <prompt> [session-id] [working-dir]}"
    local session_id="${2:-$(uuidgen 2>/dev/null || echo "pi-$$-$(date +%s)")}"
    local working_dir="${3:-$PWD}"

    # Write prompt to a temp file (matching Warp's write_temp_file pattern)
    local prompt_file
    prompt_file=$(mktemp /tmp/oz_prompt_XXXXXX.txt)
    echo "$prompt" > "$prompt_file"

    # Source the minimax env and build the command
    # Following the proven pi pattern from memory
    local cmd
    cmd="source /tmp/minimax_env.sh 2>/dev/null; "
    cmd+="cd '$working_dir' && "
    cmd+="pi --provider minimax --model MiniMax-M2.7 "
    cmd+="--session-id '$session_id' "
    cmd+="< '$prompt_file'"

    echo "$cmd"
    echo "[pi-harness] built runner for session $session_id" >&2
}

# ---- one-shot run (validate → prepare → build → execute via tmux) ----
pi_run() {
    local prompt="${1:?usage: pi_run <prompt> [working-dir] [system-prompt] [tmux-pane-name]}"
    local working_dir="${2:-$PWD}"
    local system_prompt="${3:-}"
    local pane_name="${4:-pi-agent}"
    local session_id
    session_id=$(uuidgen 2>/dev/null || echo "pi-$$-$(date +%s)")

    pi_validate || return 1
    pi_prepare_env "$working_dir" "$system_prompt"
    init_bridge "$session_id"

    local cmd
    cmd=$(pi_build_cmd "$prompt" "$session_id" "$working_dir")

    # Launch in a tmux pane (matching our existing warroom pattern)
    tmux new-window -n "$pane_name" 2>/dev/null || tmux split-window -v -l "50%"
    tmux send-keys "$cmd" Enter

    # Export bridge env vars for child
    export OZ_PARENT_STATE_ROOT="$BRIDGE_ROOT"
    export OZ_PARENT_MAX_CONTEXT_CHARS="$MAX_CONTEXT_CHARS"

    echo "[pi-harness] launched pi in tmux pane '$pane_name'" >&2
    echo "  session: $session_id" >&2
    echo "  bridge: \$OZ_PARENT_STATE_ROOT/$session_id" >&2
    echo "  model: minimax-m2.5-free (zen api)" >&2
}

# ---- helper: inject parent bridge into child's env ----
pi_inject_bridge() {
    local session_id="${1:?usage: pi_inject_bridge <session-id>}"
    echo "export OZ_PARENT_STATE_ROOT=\"$BRIDGE_ROOT\""
    echo "export OZ_PARENT_MAX_CONTEXT_CHARS=\"$MAX_CONTEXT_CHARS\""
    echo "export BRIDGE_SESSION_DIR=\"$BRIDGE_ROOT/$session_id\""
    echo "# child: source warp-bridge/parent-bridge.sh && bridge_poll"
}

export -f pi_validate pi_prepare_env pi_build_cmd pi_run pi_inject_bridge
