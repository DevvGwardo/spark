#!/usr/bin/env bash
# warp-bridge/parent-bridge.sh
# Port of Warp's parent bridge protocol
#
# Three-stage file-based message passing between a lead agent and
# a child subprocess agent (pi, opencode, codex, claude, whatever).
#
# Protocol:
#   staged/   <- lead agent drops new messages here
#   surfaced/ <- hydrated messages exposed to child
#   pending-hook-output.json  <- context block ready for child to read
#   pending-hook-output.ack   <- child writes this to ack consumption
#
# Usage:
#   PARENT:   source parent-bridge.sh && bridge_init "session-uuid"
#             bridge_stage "msg-id" "subject" "body"
#             bridge_flush
#   CHILD:    bridge_poll   # reads pending context, writes ack
#   CLEANUP:  bridge_cleanup

BRIDGE_ROOT="${OZ_PARENT_STATE_ROOT:-$HOME/.oz-bridge}"
MAX_CONTEXT_CHARS="${OZ_PARENT_MAX_CONTEXT_CHARS:-6000}"
BRIDGE_PREAMBLE="Lead-agent update arrived. Treat as authoritative."
BRIDGE_REMAINING_NOTE="\n\nMore messages are still staged."

bridge_init() {
    local session_id="${1:?usage: bridge_init <session-uuid>}"
    BRIDGE_SESSION_DIR="$BRIDGE_ROOT/$session_id"
    BRIDGE_STAGED="$BRIDGE_SESSION_DIR/staged"
    BRIDGE_SURFACED="$BRIDGE_SESSION_DIR/surfaced"
    BRIDGE_HOOK_OUTPUT="$BRIDGE_SESSION_DIR/pending-hook-output.json"
    BRIDGE_HOOK_ACK="$BRIDGE_SESSION_DIR/pending-hook-output.ack"

    mkdir -p "$BRIDGE_STAGED" "$BRIDGE_SURFACED"
    echo "[bridge] initialized at $BRIDGE_SESSION_DIR" >&2
}

bridge_stage() {
    local message_id="${1:?usage: bridge_stage <message-id> <subject> <body>}"
    local subject="${2:-}"
    local body="${3:-}"
    local seq_file

    # atomic increment for sequence number
    local seq
    seq=$(cat "$BRIDGE_SESSION_DIR/sequence" 2>/dev/null || echo 0)
    seq=$((seq + 1))
    echo "$seq" > "$BRIDGE_SESSION_DIR/sequence"

    seq_file=$(printf "%020d-%s.json" "$seq" "$message_id")

    cat > "$BRIDGE_STAGED/$seq_file" <<-JSON
{
  "sequence": $seq,
  "message_id": "$message_id",
  "subject": $(echo "$subject" | jq -Rs '.'),
  "body": $(echo "$body" | jq -Rs '.'),
  "occurred_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
    echo "[bridge] staged message #$seq: $message_id" >&2
}

# Move staged -> surfaced, write hook output, clear old acks
bridge_flush() {
    local hook_output="$BRIDGE_HOOK_OUTPUT"
    local ack_file="$BRIDGE_HOOK_ACK"

    # if hook output already exists, child hasn't consumed it yet
    if [ -f "$hook_output" ]; then
        return
    fi

    # remove stale ack (child writes new one when it reads)
    rm -f "$ack_file"

    # read all surfaced + staged records sorted
    local records=""
    local tmpfile
    tmpfile=$(mktemp)

    for dir in "$BRIDGE_SURFACED" "$BRIDGE_STAGED"; do
        for f in "$dir"/*.json; do
            [ -f "$f" ] && cat "$f" >> "$tmpfile" && echo "," >> "$tmpfile"
        done
    done

    if [ ! -s "$tmpfile" ]; then
        rm -f "$tmpfile"
        return
    fi

    # build context block from records
    local context="$BRIDGE_PREAMBLE"
    local record_count=0
    local total_count=0

    while IFS= read -r record_json; do
        [ -z "$record_json" ] && continue
        total_count=$((total_count + 1))

        local subj body seq
        seq=$(echo "$record_json" | jq -r '.sequence // 0')
        subj=$(echo "$record_json" | jq -r '.subject // "(no subject)"')
        body=$(echo "$record_json" | jq -r '.body // ""')

        local block="---\nLead-agent message #$seq\nSubject: $subj\n\n$body"
        local block_len=${#block}

        # check if we'd exceed the char limit
        local new_len=$(( ${#context} + 2 + block_len ))
        if [ $new_len -gt $MAX_CONTEXT_CHARS ] && [ $record_count -gt 0 ]; then
            break
        fi

        if [ $record_count -gt 0 ]; then
            context="$context\n\n"
        fi
        context="$context$block"
        record_count=$((record_count + 1))
    done < <(jq -c '.' "$tmpfile" 2>/dev/null)
    rm -f "$tmpfile"

    if [ $record_count -eq 0 ]; then
        return
    fi

    # add remaining note
    local remaining=$((total_count - record_count))
    if [ $remaining -gt 0 ] && [ $(( ${#context} + ${#BRIDGE_REMAINING_NOTE} )) -le $MAX_CONTEXT_CHARS ]; then
        context="$context$BRIDGE_REMAINING_NOTE ($remaining more)"
    fi

    # write hook output
    cat > "$hook_output" <<-JSON
{
  "additional_context": $(echo "$context" | jq -Rs '.'),
  "surfaced_count": $record_count,
  "remaining_staged_count": $remaining
}
JSON
    echo "[bridge] flushed $record_count message(s) to hook output ($remaining remaining)" >&2

    # move staged -> surfaced for records we picked
    for f in "$BRIDGE_STAGED"/*.json; do
        [ -f "$f" ] && mv "$f" "$BRIDGE_SURFACED/"
    done
}

# Child: read pending context, write ack
bridge_poll() {
    local hook_output="$BRIDGE_HOOK_OUTPUT"
    local ack_file="$BRIDGE_HOOK_ACK"

    if [ ! -f "$hook_output" ]; then
        echo "[bridge] no pending messages" >&2
        return 1
    fi

    # read the context
    local context
    context=$(jq -r '.additional_context // ""' "$hook_output" 2>/dev/null)
    if [ -z "$context" ]; then
        return 1
    fi

    echo "$context"

    # write ack
    echo "{\"acknowledged_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$ack_file"
    rm -f "$hook_output"
    echo "[bridge] polled and acknowledged" >&2
    return 0
}

# Parent: process acks (move surfaced out, mark delivered)
bridge_process_acks() {
    local ack_file="$BRIDGE_HOOK_ACK"

    if [ ! -f "$ack_file" ]; then
        return
    fi

    # remove hook output if it somehow still exists
    rm -f "$BRIDGE_HOOK_OUTPUT"

    # remove all surfaced records (they've been consumed)
    rm -f "$BRIDGE_SURFACED"/*.json

    # remove ack
    rm -f "$ack_file"
    echo "[bridge] processed acks, cleared surfaced messages" >&2
}

bridge_cleanup() {
    if [ -n "${BRIDGE_SESSION_DIR:-}" ] && [ -d "$BRIDGE_SESSION_DIR" ]; then
        rm -rf "$BRIDGE_SESSION_DIR"
        echo "[bridge] cleaned up $BRIDGE_SESSION_DIR" >&2
    fi
}

# Export functions for subprocess use
export -f bridge_init bridge_stage bridge_flush bridge_poll bridge_process_acks bridge_cleanup
