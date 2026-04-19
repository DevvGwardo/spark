# cloud-chat-hub Project Overview

## Core Components
- **hermes-bridge**: A high-performance proxy and adapter for LLMs, supporting passthrough and agent mode.
- **brain-mcp**: Multi-agent orchestration layer enabling agents to register, pulse, claim resources, and coordinate.
- **Mulch**: Structured expertise management for injecting project-specific conventions.
- **Seeds**: Git-native issue tracking for decentralized task management.
- **Canopy**: Git-native prompt management with versioning and inheritance.

## Architecture (Bridge Loop)
1. **HTTP Request Ingress**: Handles chat completions and passthrough.
2. **Agent Execution**: `_run_agent_sync()` manages the `AIAgent` loop.
3. **SSE Streaming**: `event_stream()` provides real-time updates and heartbeats.

## Multi-Agent Protocol (Brain-mcp)
- `brain_register`: Join the session.
- `brain_wake`: Spawn agents with specific layouts (tiled/split).
- `brain_claim/release`: Managed resource locking.
- `brain_pulse`: Heartbeat and status reporting.
