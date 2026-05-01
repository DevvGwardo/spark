# Warp Reverse-Engineering: Parent Bridge Protocol
# ================================================

## What We Extracted

Warp's parent bridge is a file-based 3-stage state machine for passing
messages from a lead agent to a child CLI agent (Claude Code, Gemini, etc.)

### Protocol

```
~/.oz-bridge/<session-uuid>/
├── staged/                              # New messages from lead agent
│   └── 00000000000000000001-msg-id.json
├── surfaced/                            # Hydrated, exposed to child
│   └── 00000000000000000001-msg-id.json
├── pending-hook-output.json             # Context block ready for child
├── pending-hook-output.ack              # Child writes this to ack
└── sequence                             # Atomic counter
```

### Flow

1. LEAD writes to `staged/` via `bridge_stage()`
2. LEAD calls `bridge_flush()`
   - moves staged → surfaced
   - writes `pending-hook-output.json` with hydrated context
3. CHILD calls `bridge_poll()` between turns
   - reads `pending-hook-output.json`
   - writes `pending-hook-output.ack`
4. LEAD calls `bridge_process_acks()`
   - clears surfaced/ records
   - ready for next round

## Files Created

```
~/cloud-chat-hub/warp-bridge/
├── parent-bridge.sh        # Bash version — source in any script
├── bridge.py               # Python version — cleaner API
├── pi-harness.sh           # pi-coding-agent harness (ThirdPartyHarness pattern)
└── README.md               # This file
```

## How to Use in Warroom

### One-shot pi agent with Zen API:

```bash
source ~/cloud-chat-hub/warp-bridge/pi-harness.sh
pi_run "refactor this function" "$PWD" "" "pi-worker"
```

### Manual bridge (lead agent):

```bash
source ~/cloud-chat-hub/warp-bridge/parent-bridge.sh
bridge_init "$(uuidgen)"
bridge_stage "msg-1" "Todo List" "Add error handling to src/api/routes.rs"
bridge_flush
bridge_process_acks
```

### Manual bridge (child agent):

```bash
source ~/cloud-chat-hub/warp-bridge/parent-bridge.sh
export OZ_PARENT_STATE_ROOT="$HOME/.oz-bridge"
context=$(bridge_poll)
echo "$context"  # This is the lead agent's message
```

### Python (child):

```python
from bridge import ParentBridge
bridge = ParentBridge(os.environ["OZ_BRIDGE_SESSION_ID"])
context = bridge.poll()
if context:
    print(context)
```

## Zen API Configuration

The free-llm-router at `localhost:8686/v1` serves as our OpenAI-compatible
endpoint. The pi-harness configures pi to use:

- Provider: `zen` (custom entry in `~/.config/pi/providers.yaml`)
- Models: `minimax-m2.5-free`, `nemotron-3-super-free`
- Auth: none (OpenCode Zen API is free, no key needed)

## Warp Code References

| File | What It Does |
|------|-------------|
| `app/src/ai/agent_sdk/driver.rs` | AgentDriver — orchestrates harness lifecycle |
| `app/src/ai/agent_sdk/driver/harness/mod.rs` | ThirdPartyHarness trait definition |
| `app/src/ai/agent_sdk/driver/harness/claude_code.rs` | Claude Code harness impl |
| `app/src/ai/agent_sdk/driver/harness/claude_code/parent_bridge.rs` | Parent bridge protocol |
| `app/src/ai/agent_sdk/driver/harness/gemini.rs` | Gemini CLI harness (reference for adding new CLIs) |
| `app/src/ai/llms.rs` | LLMInfo, LLMProvider, model management |
| `crates/ai/src/api_keys.rs` | BYO API keys (OpenAI, Anthropic, Google, OpenRouter) |
| `.agents/skills/` | 20+ pre-built agent skills |
| `.mcp.json` | MCP server config |
