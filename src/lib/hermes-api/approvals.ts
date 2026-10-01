import { hermesFetch } from './core';

export interface AcpApprovalRequest {
  approval_id: string;
  session_id: string;
  tool: string;
  kind?: string;
  summary?: string;
  excerpt?: string;
  options?: Array<{ option_id: string; name: string }>;
  /** Extended contract (bridge + server): shell command under approval. */
  command?: string;
  /** Working directory for the command. */
  cwd?: string;
  /** Human-readable reason for the approval request. */
  reason?: string;
  /** Fixed decision set the backend accepts for this request (server
   *  approval-engine and the enriched bridge payloads both emit it). */
  available_decisions?: string[];
}

/** The user's decision on an ACP permission request (once/session/always/deny). */
export type AcpApprovalDecision = 'allow_once' | 'allow_session' | 'allow_always' | 'deny';

/**
 * POST an ACP approval decision to the bridge. The bridge resolves the
 * hermes-agent's parked permission request and the agent resumes.
 */
export async function postAcpApproval(
  approvalId: string,
  optionId: AcpApprovalDecision,
): Promise<{ ok: boolean }> {
  return hermesFetch<{ ok: boolean }>(`/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    body: JSON.stringify({ option_id: optionId }),
  });
}

// ─── Server-side tool approvals (approval-engine) ───────────────────────────

/** Decision on a server-side tool approval (POST /api/hermes/approvals/:id). */
export type ServerApprovalDecision = 'approved' | 'approved_for_session' | 'denied';

/**
 * POST a server-side tool approval decision. The Express server resolves
 * parked approvals from its approval-engine; the contract mirrors the
 * bridge's ACP /v1/approvals/{id} flow so the client uses one endpoint for
 * both paths.
 */
export async function postServerApproval(
  approvalId: string,
  decision: ServerApprovalDecision,
  reason?: string,
): Promise<{ ok: boolean; approval_id: string; decision: string }> {
  return hermesFetch<{ ok: boolean; approval_id: string; decision: string }>(
    `/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
    },
  );
}
