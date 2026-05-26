# Kanban → Agent Task Orchestrator — Implementation Plan

## Overview

Build an **automated task execution pipeline** where kanban cards in the `ready` lane are automatically picked up by isolated agent sessions, worked autonomously, and the results are reported back. Multiple agents can process cards in parallel, each in their own Hermes session profile.

## Architecture Diagram

```
KANBAN CARDS         TASK ORCHESTRATOR            HERMES SESSION
┌──────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│ backlog  │    │  poll "ready" cards  │    │  panel + profile    │
│ ready ───┼───►│  spawn agent session │───►│  auto-send prompt   │
│ running  │    │  track card↔session  │    │  agent works card   │
│ review   │    │  report completion   │◄────│  kanban tools        │
│ done     │    └─────────────────────┘    │  update_status()     │
└──────────┘                               │  mark_done()         │
                                            └─────────────────────┘
                                              ↕ parallel (N agents)
```

## Phase 1 — Server-Side Task Orchestrator

### File: `server/task-orchestrator.ts` (NEW)

A lightweight daemon/service that polls the kanban store and orchestrates agent sessions.

**State Machine:**
```
ready → running → review/done
```

**Config (env vars or settings):**
- `KANBAN_MAX_CONCURRENT_TASKS` (default: 3) — max parallel agent sessions
- `KANBAN_POLL_INTERVAL_MS` (default: 5000) — how often to poll `ready` cards
- `KANBAN_AUTO_PICKUP_LANES` (default: `["ready"]`) — which lanes to auto-dispatch

**Core Logic:**

```typescript
interface OrchestratorState {
  activeTasks: Map<string, ActiveTask>;  // cardId → task
  enabled: boolean;
  maxConcurrent: number;
  pollInterval: number;
}

interface ActiveTask {
  cardId: string;
  panelId: string;        // the chat panel this card is running in
  profile: string;        // the Hermes session profile
  conversationId: string; // the conversation (auto-created)
  startedAt: number;
}
```

**Methods:**

1. `start()` — Begin polling loop. On each tick:
   - Fetch all cards in eligible lanes (e.g. `ready`)
   - Filter out cards already tracked in `activeTasks`
   - If `activeTasks.size < maxConcurrent`, spawn new sessions for available cards
   - For each spawned card:
     a. Generate a fresh `panelId` and Hermes session profile
     b. Create a conversation (via `chat-store.ts` server-side)
     c. Call Hermes bridge to start an agent session with the card spec as system prompt
     d. Track card → session mapping
     e. Update card status → `running`
   
2. `stop()` — Gracefully shut down the polling loop

3. `handleCardCompletion(cardId, result)` — Called when an agent reports back:
   - Move card to `review` or `done` lane
   - Write `reportPath` with session summary
   - Clean up tracking
   - Free a slot for the next `ready` card

**Backend Route:**

- `GET /api/hermes/orchestrator/status` — Returns orchestrator state (enabled, active tasks, queued cards)
- `POST /api/hermes/orchestrator/start` — Enable auto-dispatch
- `POST /api/hermes/orchestrator/stop` — Disable auto-dispatch
- `POST /api/hermes/orchestrator/dispatch-now` — Force a dispatch cycle (manual trigger)

### File: `server/routes/orchestrator.ts` (NEW)

Register the status/control routes above.

### File: `server/index.ts` (MODIFY)

Add:
```typescript
import { registerOrchestratorRoutes } from './routes/orchestrator';
import { taskOrchestrator } from './task-orchestrator';

// After other routes:
registerOrchestratorRoutes(app);

// Start orchestrator on server boot (configurable):
if (process.env.KANBAN_AUTO_START !== 'false') {
  taskOrchestrator.start();
}
```

## Phase 2 — Kanban Agent Tools

### File: `hermes-bridge/kanban_tools.py` (NEW)

Tool definitions the agent can call to interact with the kanban board:

```python
# Tool: kanban_read_card
# Given a card ID, returns the full card spec, acceptance criteria, context

# Tool: kanban_update_card
# Update card status (running → review → done) and/or write a report

# Tool: kanban_list_cards
# List cards by status lane for context
```

### File: `hermes-bridge/run_agent.py` (MODIFY)

- Import and register kanban tools when the agent is spawned for a kanban task
- Tool routing: `kanban_*` tools route to HTTP calls to the Express kanban API

**Tool definitions (OpenAI function-calling format):**

```json
[
  {
    "type": "function",
    "function": {
      "name": "kanban_read_current_card",
      "description": "Read the full details of the kanban card this session is working on.",
      "parameters": {"type": "object", "properties": {}}
    }
  },
  {
    "type": "function",
    "function": {
      "name": "kanban_update_status",
      "description": "Update the status of the current kanban card (e.g. 'review', 'blocked', 'done').",
      "parameters": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "enum": ["review", "blocked", "done"],
            "description": "New status lane"
          },
          "report_summary": {
            "type": "string",
            "description": "Summary of what was done (optional)"
          }
        },
        "required": ["status"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "kanban_append_report",
      "description": "Append notes/report to the current kanban card without changing status.",
      "parameters": {
        "type": "object",
        "properties": {
          "notes": {
            "type": "string",
            "description": "Notes or progress update"
          }
        },
        "required": ["notes"]
      }
    }
  }
]
```

### Implementation Detail — How Tools Reach the Express API

The agent runs in the Hermes bridge Python process. To update kanban state, it needs to call back to the Express server. Options:

**Option A: Direct HTTP** (simplest)
- The Python bridge knows the Express server URL (passed as env var `CLOUDCHAT_API_BASE` or `http://localhost:3001`)
- Kanban tool executions make `fetch()` calls to `{API_BASE}/api/hermes/kanban/{cardId}`
- The card ID is stored in the session context (injected into the system prompt)

**Option B: MCP-style** (if the bridge already has MCP tool routing)
- Register kanban as an MCP tool source
- Use existing `_execute_mcp_tool` infrastructure

Go with **Option A** — simpler, fewer moving parts.

## Phase 3 — Orchestrator → Agent Session Integration

### How the Orchestrator Spawns an Agent Session

When the orchestrator picks a `ready` card:

1. **Generate IDs:**
   - `panelId = "kanban-task-" + card.id.slice(0,8)`
   - `profile = "task-" + card.id.slice(0,8)` (or use the existing `generateSessionProfile()` pattern)
   - Create a new conversation (call Hermes bridge `/api/hermes/chat` or use the chat-store)

2. **Create conversation** — The orchestrator needs to create a conversation record server-side:
   ```typescript
   const conversation = await createConversation({
     title: `[Task] ${card.title}`,
     model: defaultModel,
     provider: 'hermes',
   });
   ```

3. **Build system prompt** — Includes card spec, acceptance criteria, and kanban tools:
   ```typescript
   const systemPrompt = buildKanbanTaskPrompt(card);
   // Calls buildKanbanExecutionPrompt(card) and appends tool instructions
   ```

4. **Dispatch to Hermes bridge** — Start an agent session via the bridge's chat endpoint with:
   - System prompt containing the card task
   - Kanban tools registered
   - `card_id` in session metadata so tools can reference it

5. **Update tracking:**
   ```typescript
   activeTasks.set(card.id, {
     cardId: card.id,
     panelId,
     profile,
     conversationId: conversation.id,
     startedAt: Date.now(),
   });
   ```

**Edge Cases:**
- **No `ready` cards available** → skip the tick, log debug
- **Max concurrent reached** → skip spawning, log debug
- **Agent session fails to start** → move card back to `ready`, log error
- **Agent reports `blocked`** → move card to `blocked` lane, free slot
- **Agent reports `done` or `review`** → see Phase 4

## Phase 4 — Completion Flow

When the agent calls `kanban_update_status({status: "done"})`:

1. **Python tool handler** → HTTP PATCH to `{API_BASE}/api/hermes/kanban/{cardId}` with `{status: "done", reportPath: "..."}` 
2. Also writes the report summary to a file or the card's `reportPath` field
3. **Orchestrator** (polling or webhook) notices card is no longer `running`
4. Cleans up `activeTasks` entry → frees a slot
5. Next poll cycle picks up another `ready` card

Alternatively, the orchestrator can **listen for PATCH events** via the server's tool event system or via a callback endpoint:
- `POST /api/hermes/orchestrator/card-complete` — webhook for the kanban PATCH handler to call

## Phase 5 — Sidebar UI: Task Queue Panel

### File: `src/components/sidebar/TaskQueuePanel.tsx` (NEW)

A new sidebar sub-tab (add to `HERMES_SUB_TABS` in `ChatSidebar.tsx`) that shows:

**Header:**
- Orchestrator status toggle (Start/Stop auto-dispatch)
- Active task count / max concurrent
- "Dispatch now" button

**Active Tasks Section:**
- For each card being processed:
  - Card title (linked to expandable detail)
  - Agent session/profile name
  - Elapsed time (live timer)
  - Current status lane indicator
  - "Cancel" button → move card back to `ready`, kill session
  - "Open session" → opens the chat panel for that conversation

**Queued Cards Section:**
- Cards in `ready` lane that haven't been picked up yet
- Ordered by priority (createdAt ascending)
- "Pick up now" button to manually dispatch

**Completed Section (collapsible):**
- Recently completed cards (last 10)
- Shows report summary, link to session

### File: `src/stores/task-orchestrator-store.ts` (NEW)

Zustand store syncing with orchestrator state:

```typescript
interface TaskOrchestratorState {
  enabled: boolean;
  activeTasks: ActiveTask[];
  stats: { completed: number; failed: number; avgDuration: number };
  fetchStatus: () => Promise<void>;
  startOrchestrator: () => Promise<void>;
  stopOrchestrator: () => Promise<void>;
  dispatchNow: () => Promise<void>;
  cancelTask: (cardId: string) => Promise<void>;
}
```

### File: `src/components/sidebar/ChatSidebar.tsx` (MODIFY)

Add `TaskQueuePanel` to the hermes sub-tab navigation:

```typescript
const HERMES_SUB_TABS = [
  // ...existing tabs...
  { key: 'tasks', label: 'Tasks', icon: Kanban }, // or use ListChecks icon
];
```

And in the conditional render:

```tsx
) : activeSubTab === 'kanban' ? (
  <KanbanPanel />
) : activeSubTab === 'tasks' ? (
  <TaskQueuePanel />
) : (
```

## Phase 6 — UI Integration Details

### KanbanPanel "Auto-Dispatch" Toggle

In `KanbanPanel.tsx`, add a toggle/button in the header:

```
[⚡ Auto-dispatch: ON/OFF]
```

When ON, cards in `ready` are automatically picked up by the orchestrator.
When OFF, the "Run in chat" button works as before (manual).

### Auto-Dispatch Indicator

In card rows, show a subtle indicator when a card is being processed by an agent:
- `running` → show agent session ID or profile name
- Show elapsed time

## File Change Summary

### New Files:
| # | File | Purpose |
|---|------|---------|
| 1 | `server/task-orchestrator.ts` | Core orchestrator daemon |
| 2 | `server/routes/orchestrator.ts` | Orchestrator control/status API |
| 3 | `hermes-bridge/kanban_tools.py` | Kanban tool definitions for the agent |
| 4 | `src/stores/task-orchestrator-store.ts` | React state for orchestrator UI |
| 5 | `src/components/sidebar/TaskQueuePanel.tsx` | Sidebar task queue UI |

### Modified Files:
| # | File | Change |
|---|------|--------|
| 6 | `server/index.ts` | Register orchestrator routes, start daemon |
| 7 | `hermes-bridge/run_agent.py` | Register kanban tools, append card context |
| 8 | `src/components/sidebar/ChatSidebar.tsx` | Add "Tasks" sub-tab |
| 9 | `src/stores/ui-store.ts` | Add `tasks` to `SubTab` type |
| 10 | `src/lib/kanban-prompts.ts` | Add `buildKanbanSystemPrompt()` for agent sessions |

## Implementation Order (Recommended)

1. **Phase 1** — Server orchestrator + routes (the backbone). Without this, nothing works.
2. **Phase 2** — Kanban tools in the agent. Needed for the agent to report back.
3. **Phase 3** — Wire orchestrator to spawn agent sessions with card context.
4. **Phase 5 + 6** — Frontend UI (task queue panel, integration). Visual feedback.
5. **Phase 4** — Completion flow. Ties it all together.

## Technical Decisions

1. **Polling vs Webhooks**: Use polling (5s interval) for simplicity. The kanban store is file-backed, so there's no DB trigger. Polling is reliable and easy to debug. Can upgrade to fs.watch if needed later.

2. **Session Profiles**: Reuse the existing `generateSessionProfile()` pattern from `panel-store.ts` but prefix with `task-` for clarity.

3. **Max Concurrent**: Default 3. Configurable via `KANBAN_MAX_CONCURRENT_TASKS` env var. In the future, could be dynamic based on available resources.

4. **Error Recovery**: If an agent session crashes, the orchestrator should:
   - Detect via missing session after N polling cycles (heartbeat)
   - Move card back to `ready` with a note
   - Log the error for debugging

5. **Race Conditions**: The polling loop uses a simple lock (`isProcessing`) to prevent overlapping ticks. Status updates to kanban cards use the existing PATCH endpoint which handles concurrent updates gracefully.

## Open Questions / Future Considerations

- Should the user be able to assign specific models/providers per card?
- How should results be surfaced back to the user in the chat sidebar? (A mini report panel?)
- Should completed tasks auto-archive after X days?
- Should there be a "Review" step where a human must approve before `done`?
- Should the orchestrator support scheduling (e.g., "run this card at 2pm tomorrow")?
