import { extractPseudoToolInvocations, stripPseudoToolInvocations } from './pseudo-tool-calls';

export interface ProposalPlanItem {
  path: string;
  action: string;
  description: string;
}

export interface ProposalToolInvocationLike {
  toolName?: string;
  state?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export interface ProposalMessagePartLike {
  type?: string;
  text?: string;
  reasoning?: string;
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

function getInvocationDigest(invocation?: ProposalToolInvocationLike): string {
  if (!invocation) return '';
  return `${invocation.toolName ?? ''}:${invocation.state ?? ''}:${JSON.stringify(invocation.args ?? {})}`;
}

function getMessageProposalText(message: ProposalMessageLike): string {
  const content = typeof message.content === 'string' ? message.content : '';
  const partText = (message.parts || [])
    .map((part) => {
      if (part.type === 'text') return part.text ?? '';
      if (part.type === 'reasoning') return part.reasoning ?? '';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');

  if (!content) return partText;
  if (!partText) return content;
  if (partText.includes(content)) return partText;
  if (content.includes(partText)) return content;
  return `${content}\n\n${partText}`;
}

export function getProposalDigest(messages: ProposalMessageLike[]): string {
  return messages.map((message) => {
    const partDigest = (message.parts || [])
      .map((part) => {
        if (part.type === 'tool-invocation') return `tool:${getInvocationDigest(part.toolInvocation)}`;
        if (part.type === 'text') return `text:${part.text ?? ''}`;
        if (part.type === 'reasoning') return `reasoning:${part.reasoning ?? ''}`;
        return part.type ?? '';
      })
      .join('|');
    const toolDigest = (message.toolInvocations || [])
      .map((invocation) => `tool:${getInvocationDigest(invocation)}`)
      .join('|');

    return `${message.id}:${message.role}:${getMessageProposalText(message)}:${partDigest}:${toolDigest}`;
  }).join('||');
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
  const cleaned = stripPseudoToolInvocations(content)
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

function extractPseudoProposal(message: ProposalMessageLike): PendingProposal | null {
  const messageText = getMessageProposalText(message);
  const invocation = extractPseudoToolInvocations(messageText)
    .find((candidate) => candidate.toolName === 'propose_changes');

  if (!invocation) return null;

  const summary = typeof invocation.args.summary === 'string' ? invocation.args.summary : null;
  const plan = Array.isArray(invocation.args.plan)
    ? invocation.args.plan.map(parsePlanItem).filter((item): item is ProposalPlanItem => item !== null)
    : [];

  // Always surface a proposal when propose_changes was called, even if the
  // model didn't populate summary/plan args (common with local models).
  return {
    messageId: message.id,
    summary: summary || extractProposalExcerpt(messageText),
    excerpt: extractProposalExcerpt(messageText),
    plan,
  };
}

function extractToolProposal(message: ProposalMessageLike): PendingProposal | null {
  const messageText = getMessageProposalText(message);
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

    // Always surface a proposal when propose_changes was called, even if the
    // model didn't populate summary/plan args (common with local models).
    return {
      messageId: message.id,
      summary: summary || extractProposalExcerpt(messageText),
      excerpt: extractProposalExcerpt(messageText),
      plan,
    };
  }

  return null;
}

function extractContentProposal(message: ProposalMessageLike): PendingProposal | null {
  const content = getMessageProposalText(message);
  const looksLikeProposal =
    content.includes('## Proposed Changes') ||
    content.includes('propose_changes(') ||
    /\bhere(?:'s| is)\s+(?:a\s+)?proposal\b/i.test(content) ||
    /accept button below/i.test(content) ||
    /reply\s+\*\*"?go ahead"?\*\*/i.test(content) ||
    /proposing changes/i.test(content) ||
    /\bapprove\b.*\b(plan|changes)\b/i.test(content) ||
    /\bproceed with the changes\b/i.test(content) ||
    (/\bproposed?\b.*\bplan\b/i.test(content) && /ready to proceed|if you're ready|review.*(plan|changes)/i.test(content));

  if (!looksLikeProposal) return null;

  return {
    messageId: message.id,
    summary: null,
    excerpt: extractProposalExcerpt(content),
    plan: [],
  };
}

function extractProposalFromMessage(message: ProposalMessageLike): PendingProposal | null {
  if (/auto-approved/i.test(getMessageProposalText(message))) {
    return null;
  }
  // Also check tool invocation results for auto-approved text (the result
  // string from onToolCall may not appear in message content/parts text).
  const allInvocations = collectToolInvocations(message);
  for (const inv of allInvocations) {
    if (inv.toolName === 'propose_changes' && typeof inv.result === 'string' && /auto-approved/i.test(inv.result)) {
      return null;
    }
  }
  return extractToolProposal(message) || extractPseudoProposal(message) || extractContentProposal(message);
}

const REPO_CONTINUATION_TOOL_NAMES = new Set([
  'read_repo_file',
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);

function collectToolInvocations(message: ProposalMessageLike): ProposalToolInvocationLike[] {
  const partInvocations = (message.parts || [])
    .filter((part) => part.type === 'tool-invocation' && part.toolInvocation)
    .map((part) => part.toolInvocation!);
  return [...partInvocations, ...(message.toolInvocations || [])];
}

/**
 * Check if a tool invocation was blocked (returned an error because
 * the user hasn't approved the proposal yet, or the stream was interrupted).
 */
function isBlockedInvocation(invocation: ProposalToolInvocationLike): boolean {
  if (invocation.state !== 'result') return true; // Not yet completed
  const result = invocation.result;
  if (typeof result === 'string') {
    if (
      result.includes('Changes are locked') ||
      result.includes('Tool call was interrupted') ||
      result.startsWith('Error:') ||
      result.startsWith('Error reading file:')
    ) {
      return true;
    }
  }
  if (typeof result === 'object' && result !== null && 'error' in result) {
    return true;
  }
  return false;
}

export function hasRepoContinuationAfterProposal(
  messages: ProposalMessageLike[],
  proposalMessageId: string,
): boolean {
  let reachedProposalMessage = false;

  for (const message of messages) {
    if (message.role !== 'assistant') continue;

    const invocations = collectToolInvocations(message);
    if (!reachedProposalMessage) {
      if (message.id !== proposalMessageId) continue;
      reachedProposalMessage = true;

      let sawProposalInMessage = false;
      for (const invocation of invocations) {
        if (invocation.toolName === 'propose_changes') {
          sawProposalInMessage = true;
          continue;
        }

        if (
          sawProposalInMessage &&
          REPO_CONTINUATION_TOOL_NAMES.has(invocation.toolName ?? '') &&
          !isBlockedInvocation(invocation)
        ) {
          return true;
        }
      }

      continue;
    }

    if (invocations.some((invocation) =>
      REPO_CONTINUATION_TOOL_NAMES.has(invocation.toolName ?? '') &&
      !isBlockedInvocation(invocation)
    )) {
      return true;
    }
  }

  return false;
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
