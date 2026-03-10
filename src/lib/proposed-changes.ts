export interface ProposalPlanItem {
  path: string;
  action: string;
  description: string;
}

export interface ProposalToolInvocationLike {
  toolName?: string;
  state?: string;
  args?: Record<string, unknown>;
}

export interface ProposalMessagePartLike {
  type?: string;
  toolInvocation?: ProposalToolInvocationLike;
}

export interface ProposalMessageLike {
  id: string;
  role: string;
  content?: string;
  parts?: ProposalMessagePartLike[];
  toolInvocations?: ProposalToolInvocationLike[];
}

export interface PendingProposal {
  messageId: string;
  summary: string | null;
  excerpt: string | null;
  plan: ProposalPlanItem[];
}

function parsePlanItem(value: unknown): ProposalPlanItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.path !== 'string' ||
    typeof item.action !== 'string' ||
    typeof item.description !== 'string'
  ) {
    return null;
  }
  return {
    path: item.path,
    action: item.action,
    description: item.description,
  };
}

function extractProposalExcerpt(content: string): string | null {
  const cleaned = content
    .replace(/^## Proposed Changes\s*/i, '')
    .replace(/Use the accept button below[\s\S]*$/i, '')
    .replace(/Please review and reply[\s\S]*$/i, '')
    .trim();

  if (!cleaned) return null;

  const blocks = cleaned
    .split(/\n{2,}/)
    .map((block) => block.replace(/[*`#]/g, '').trim())
    .filter(Boolean);

  return blocks[0] || null;
}

function extractToolProposal(message: ProposalMessageLike): PendingProposal | null {
  const partInvocations = (message.parts || [])
    .filter((part) => part.type === 'tool-invocation' && part.toolInvocation)
    .map((part) => part.toolInvocation!);
  const allInvocations = [...partInvocations, ...(message.toolInvocations || [])];

  for (const invocation of allInvocations) {
    if (invocation.toolName !== 'propose_changes') continue;
    const args = invocation.args || {};
    const summary = typeof args.summary === 'string' ? args.summary : null;
    const plan = Array.isArray(args.plan)
      ? args.plan.map(parsePlanItem).filter((item): item is ProposalPlanItem => item !== null)
      : [];

    if (summary || plan.length > 0) {
      return {
        messageId: message.id,
        summary,
        excerpt: extractProposalExcerpt(message.content || ''),
        plan,
      };
    }
  }

  return null;
}

function extractContentProposal(message: ProposalMessageLike): PendingProposal | null {
  const content = message.content || '';
  const looksLikeProposal =
    content.includes('## Proposed Changes') ||
    /accept button below/i.test(content) ||
    /reply\s+\*\*"?go ahead"?\*\*/i.test(content);

  if (!looksLikeProposal) return null;

  return {
    messageId: message.id,
    summary: null,
    excerpt: extractProposalExcerpt(content),
    plan: [],
  };
}

function extractProposalFromMessage(message: ProposalMessageLike): PendingProposal | null {
  return extractToolProposal(message) || extractContentProposal(message);
}

export function findPendingProposal(messages: ProposalMessageLike[]): PendingProposal | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') return null;
    if (message.role !== 'assistant') continue;

    const proposal = extractProposalFromMessage(message);
    if (proposal) return proposal;
  }

  return null;
}
