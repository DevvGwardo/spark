# cloud-chat-hub: The AI Orchestration Engine

## Overview
A unified hub for LLM bridging and multi-agent coordination, integrating structured expertise and decentralized task management.

## Learning Objectives
The viewer will understand:
1. The 5 core components of the cloud-chat-hub ecosystem.
2. The three-layer architecture of the LLM bridge.
3. The multi-agent orchestration commands and protocol.

---

## Section 1: The Core Ecosystem

**Key Concept**: Five specialized tools working in harmony to provide an agent-first development environment.

**Content**:
- hermes-bridge: High-performance proxy/adapter for LLMs.
- brain-mcp: Multi-agent orchestration layer.
- Mulch: Structured expertise management.
- Seeds: Git-native issue tracking.
- Canopy: Git-native prompt management.

**Visual Element**:
- Type: bento grid
- Subject: Icons for each component
- Treatment: Individual modules with clear labels and brief descriptions.

**Text Labels**:
- Headline: "The Core Ecosystem"
- Labels: "Bridge", "Orchestrator", "Expertise", "Issues", "Prompts"

---

## Section 2: Bridge Architecture

**Key Concept**: A three-layer flow ensuring robust model passthrough and real-time agent feedback.

**Content**:
- HTTP Request Ingress: Handles chat completions and passthrough.
- Agent Execution: `_run_agent_sync()` manages the `AIAgent` loop.
- SSE Streaming: Real-time updates and heartbeats.

**Visual Element**:
- Type: linear flow / layers
- Subject: Data flow through the three layers
- Treatment: Vertically stacked layers with arrows indicating data flow.

**Text Labels**:
- Headline: "Bridge Architecture"
- Labels: "Ingress", "Execution", "Streaming"

---

## Section 3: Orchestration Protocol

**Key Concept**: The brain-mcp protocol for managing swarms of autonomous agents.

**Content**:
- brain_register: Join the session room.
- brain_wake: Spawn agent panes (tiled/split).
- brain_claim/release: Atomic resource locking.
- brain_pulse: Heartbeat and status telemetry.

**Visual Element**:
- Type: hub-spoke / commands
- Subject: Protocol commands
- Treatment: Central "Brain" icon with commands as spokes.

**Text Labels**:
- Headline: "Orchestration Protocol"
- Labels: "Register", "Wake", "Claim", "Pulse"

---

## Data Points (Verbatim)

All statistics and key terms exactly as they appear in source:

### Key Terms
- **hermes-bridge**: A high-performance proxy and adapter for LLMs.
- **brain-mcp**: Multi-agent orchestration layer.
- **Mulch**: Structured expertise management.
- **Seeds**: Git-native issue tracking.
- **Canopy**: Git-native prompt management.
- **_run_agent_sync()**: Function that manages the AIAgent loop.
- **brain_wake**: Spawn agents with specific layouts.

---

## Design Instructions

### Style Preferences
- Technical, modern, and high-precision.
- Use a color palette that distinguishes components (e.g., cool blues for Bridge, greens for Seeds).

### Layout Preferences
- Clean grid or modular structure.
