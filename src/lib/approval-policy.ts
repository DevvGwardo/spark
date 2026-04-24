import type { PendingProposal } from '@/lib/proposed-changes';

export type ApprovalScope = 'session' | 'always';
export type ApprovalKey = string; // `${toolName}:${targetHash}`

export interface ApprovalPolicy {
  key: ApprovalKey;
  scope: ApprovalScope;
  createdAt: number;
}

/** Small stable string hash (djb2). Not cryptographic. */
export function djb2Hash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  // unsigned hex
  return (hash >>> 0).toString(16);
}

/**
 * Approval key for a repo proposal. We hash the sorted set of plan file paths
 * so the same set of files requested by the same tool reuses its approval.
 */
export function getProposalApprovalKey(proposal: PendingProposal): ApprovalKey {
  const paths = proposal.plan
    .map((item) => item.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .sort()
    .join('|');
  return `propose_changes:${djb2Hash(paths)}`;
}

export function matchApprovalPolicy(
  key: ApprovalKey,
  sessionPolicies: ApprovalPolicy[],
  alwaysPolicies: ApprovalPolicy[],
): ApprovalPolicy | null {
  const match =
    sessionPolicies.find((p) => p.key === key) ??
    alwaysPolicies.find((p) => p.key === key);
  return match ?? null;
}
