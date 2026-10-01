/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source of truth: the Pydantic models in hermes-bridge/bridge_events.py,
 * via shared/hermes-events.schema.json.
 * Regenerate with: npm run gen:hermes-contract
 * CI fails if this file is stale.
 *
 * Generated from the hermes-bridge Pydantic contract.
 */

import { z } from 'zod'

/** Contract for the `agent_notice` delta key. */

export const agentNoticeSchema = z.object({ "key": z.union([z.string(), z.null()]).default(null), "level": z.union([z.string(), z.null()]).default(null), "message": z.union([z.string(), z.null()]).default(null), "metadata": z.union([z.record(z.any()), z.null()]).default(null) }).catchall(z.any()).describe("Structured notice from the real agent (credits, run budget).\n\nPayload is open: hermes-agent owns the notice shape and adds notice kinds\nwithout a bridge release.")

/** Contract for the `agent_notice_clear` delta key. */

export const agentNoticeClearSchema = z.object({ "key": z.string() }).describe("Clears a previously emitted agent_notice by key.")

/** Contract for the `agent_status` delta key. */

export const agentStatusSchema = z.object({ "elapsed_ms": z.number().int().default(0), "iteration": z.union([z.number().int(), z.null()]).default(null), "label": z.string().default(""), "phase": z.string(), "source": z.string().default("hermes-bridge") }).describe("Progress heartbeat for the active turn (phase, elapsed time, iteration).")

/** Contract for the `approval_request` delta key. */

export const approvalRequestSchema = z.record(z.any()).describe("Legacy structured event 'approval_request' (constructor predates the custom contract).")

/** Contract for the `computer_use_frame` delta key. */

export const computerUseFrameSchema = z.object({ "data": z.union([z.string(), z.null()]).default(null), "metadata": z.union([z.record(z.any()), z.null()]).default(null), "type": z.string().default("computer_use_frame") }).catchall(z.any()).describe("One computer-use screenshot frame. Payload owned by hermes-agent.")

/** Contract for the `fallback_switch` delta key. */

export const fallbackSwitchSchema = z.object({ "model": z.string(), "provider": z.string(), "reason": z.union([z.string(), z.null()]).default(null) }).describe("The agent fell back to a different provider/model mid-turn.")

/** Contract for the `plan_update` delta key. */

export const planUpdateSchema = z.record(z.any()).describe("Legacy structured event 'plan_update' (constructor predates the custom contract).")

/** Contract for the `server_tool_event` delta key. */

export const serverToolEventSchema = z.object({ "conversation_id": z.union([z.string(), z.null()]).default(null), "elapsed_ms": z.union([z.number().int(), z.null()]).default(null), "plan": z.union([z.any(), z.null()]).default(null), "review_notes": z.union([z.string(), z.null()]).default(null), "run_id": z.union([z.string(), z.null()]).default(null), "staged_files": z.union([z.array(z.any()), z.null()]).default(null), "success": z.union([z.boolean(), z.null()]).default(null), "type": z.string(), "verdict": z.union([z.string(), z.null()]).default(null) }).catchall(z.any()).describe("Bridge-originated event surfaced on the same channel as agent events.\n\n`type` is a discriminant: hermes_run, swarm_result, and others are emitted\nfrom different transports, so the payload is open by design.")

/** Contract for the `stream_retry` delta key. */

export const streamRetrySchema = z.object({ "attempt": z.any() }).catchall(z.any()).describe("Legacy structured event 'stream_retry' (constructor predates the custom contract).")

/** Contract for the `tool_activity` delta key. */

export const toolActivitySchema = z.object({ "input": z.any().default(null), "output": z.any().default(null), "status": z.string().default("running"), "tool": z.string() }).describe("A tool invocation becoming active or finishing. Legacy shape, still live.\n\nSuperseded in practice by tool_call_begin/delta/end, but the agent-loop\ntransport still emits it, so the contract keeps it.")

/** Contract for the `tool_call_begin` delta key. */

export const toolCallBeginSchema = z.object({ "call_id": z.any(), "name": z.any() }).catchall(z.any()).describe("Legacy structured event 'tool_call_begin' (constructor predates the custom contract).")

/** Contract for the `tool_call_delta` delta key. */

export const toolCallDeltaSchema = z.object({ "call_id": z.any(), "output": z.any() }).catchall(z.any()).describe("Legacy structured event 'tool_call_delta' (constructor predates the custom contract).")

/** Contract for the `tool_call_end` delta key. */

export const toolCallEndSchema = z.object({ "call_id": z.any(), "name": z.any(), "success": z.any() }).catchall(z.any()).describe("Legacy structured event 'tool_call_end' (constructor predates the custom contract).")

/** Contract for the `transport_status` delta key. */

export const transportStatusSchema = z.object({ "actual": z.string(), "capabilities": z.union([z.record(z.boolean()), z.null()]).default(null), "reason": z.union([z.string(), z.null()]).default(null), "requested": z.string() }).describe("The transport that will actually serve this request, and why it differs.\n\n``capabilities`` is the serving transport's row of the capability matrix\n(spec 4.8): approvals, cancel, stops_on_client_disconnect,\nusage_in_stream, session_resume. The UI hides or disables affordances\nthe transport cannot honor (Stop, approval prompts).")

/** Contract for the `usage` delta key. */

export const usageSchema = z.object({ "cached_input_tokens": z.union([z.number().int(), z.null()]).default(null), "completion_tokens": z.number().int().default(0), "cost_source": z.union([z.string(), z.null()]).default(null), "estimated_cost_usd": z.union([z.number(), z.null()]).default(null), "prompt_tokens": z.number().int().default(0), "reasoning_tokens": z.union([z.number().int(), z.null()]).default(null), "total_tokens": z.number().int().default(0) }).describe("Token usage and cost for a completed turn (spec 4.5).\n\nTravels as the ``usage`` of the final chunk (OpenAI-compatible position).\n``estimated_cost_usd`` is recomputed from the token counts by pricing.py\nwhen the model can be priced (``cost_source=\"pricing\"``), else taken from\nthe agent's own estimate when plausible (``\"agent\"``), else omitted.")

/** Every custom event key the bridge may emit, mapped to its validator. */
export const HERMES_EVENT_SCHEMAS = {
  "agent_notice": agentNoticeSchema,
  "agent_notice_clear": agentNoticeClearSchema,
  "agent_status": agentStatusSchema,
  "approval_request": approvalRequestSchema,
  "computer_use_frame": computerUseFrameSchema,
  "fallback_switch": fallbackSwitchSchema,
  "plan_update": planUpdateSchema,
  "server_tool_event": serverToolEventSchema,
  "stream_retry": streamRetrySchema,
  "tool_activity": toolActivitySchema,
  "tool_call_begin": toolCallBeginSchema,
  "tool_call_delta": toolCallDeltaSchema,
  "tool_call_end": toolCallEndSchema,
  "transport_status": transportStatusSchema,
  "usage": usageSchema,
} as const

export type HermesEventKey = keyof typeof HERMES_EVENT_SCHEMAS

/**
 * Validates a whole delta object. Custom keys are checked against the contract;
 * everything else is passed through, because a delta also carries standard
 * OpenAI fields (content, reasoning, role) that are not part of this contract.
 */
export const hermesCustomDeltaSchema = z
  .object({
    "agent_notice": agentNoticeSchema.optional(),
    "agent_notice_clear": agentNoticeClearSchema.optional(),
    "agent_status": agentStatusSchema.optional(),
    "approval_request": approvalRequestSchema.optional(),
    "computer_use_frame": computerUseFrameSchema.optional(),
    "fallback_switch": fallbackSwitchSchema.optional(),
    "plan_update": planUpdateSchema.optional(),
    "server_tool_event": serverToolEventSchema.optional(),
    "stream_retry": streamRetrySchema.optional(),
    "tool_activity": toolActivitySchema.optional(),
    "tool_call_begin": toolCallBeginSchema.optional(),
    "tool_call_delta": toolCallDeltaSchema.optional(),
    "tool_call_end": toolCallEndSchema.optional(),
    "transport_status": transportStatusSchema.optional(),
    "usage": usageSchema.optional(),
  })
  .passthrough()

export type HermesCustomDelta = z.infer<typeof hermesCustomDeltaSchema>
