import type { Message as AIMessage } from '@ai-sdk/react';
import { useChangesetStore } from '@/stores/changeset-store';
import { db, type Message as StoredMessage } from '@/lib/db';
import type { PendingProposal } from '@/lib/proposed-changes';
import { isRepoWriteMessage } from '@/lib/repo-intent';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';
import { SERVER_EXECUTED_REPO_TOOLS, SERVER_TOOL_EVENT_TYPES, type ServerToolEvent } from '@/lib/server-tool-events';
import { extractPseudoToolInvocations, extractTextFileEdits, getPseudoToolSourceText } from '@/lib/pseudo-tool-calls';
import type { Provider } from '@/stores/settings-store';

/** Delay before auto-continue fires after a stalled or interrupted response. */
export const AUTO_CONTINUE_DELAY_MS = 300;

/** Debounce interval for auto-saving conversation file state to IndexedDB. */
export const AUTO_SAVE_DEBOUNCE_MS = 1000;

/** Max character length for auto-generated conversation titles. */
export const CONVERSATION_TITLE_MAX_LENGTH = 50;

/** Max sample paths shown when a repo file lookup fails. */
export const REPO_PATH_SAMPLE_LIMIT = 8;

export function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

export function isInvalidRepoReadPath(path: string): boolean {
  return !path || path === '.' || path === '/' || path.endsWith('/');
}

export function getRepoPathSuggestions(paths: string[], requestedPath: string, limit = 6): string[] {
  const normalizedRequestedPath = normalizeRepoPath(requestedPath).toLowerCase();
  const requestedSegments = normalizedRequestedPath.split('/').filter(Boolean);
  const requestedBasename = requestedSegments.at(-1) || normalizedRequestedPath;
  const requestedTopLevel = requestedSegments[0] || '';

  return paths
    .map((candidatePath) => {
      const normalizedCandidate = candidatePath.toLowerCase();
      const candidateSegments = normalizedCandidate.split('/').filter(Boolean);
      const candidateBasename = candidateSegments.at(-1) || normalizedCandidate;
      let score = 0;

      if (normalizedCandidate === normalizedRequestedPath) score += 100;
      if (candidateBasename === requestedBasename) score += 60;
      if (requestedBasename && candidateBasename.includes(requestedBasename)) score += 30;
      if (requestedBasename && normalizedCandidate.includes(requestedBasename)) score += 20;
      if (normalizedRequestedPath && normalizedCandidate.includes(normalizedRequestedPath)) score += 10;
      if (requestedTopLevel && candidateSegments[0] === requestedTopLevel) score += 25;

      const overlap = requestedSegments.filter((segment) => candidateSegments.includes(segment)).length;
      if (overlap > 0) score += overlap * 12;

      return { candidatePath, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.candidatePath.localeCompare(right.candidatePath))
    .slice(0, limit)
    .map((entry) => entry.candidatePath);
}

function getRepoPathExamples(paths: string[], requestedPath: string, limit = REPO_PATH_SAMPLE_LIMIT): string[] {
  const normalizedRequestedPath = normalizeRepoPath(requestedPath).toLowerCase();
  const requestedTopLevel = normalizedRequestedPath.split('/').find(Boolean) || '';

  if (requestedTopLevel) {
    const topLevelMatches = paths.filter((path) => path.toLowerCase().startsWith(`${requestedTopLevel}/`));
    if (topLevelMatches.length > 0) {
      return topLevelMatches.slice(0, limit);
    }
  }

  return paths.slice(0, limit);
}

export function formatMissingRepoFileError(requestedPath: string, repoPaths: string[]): string {
  const normalizedPath = normalizeRepoPath(requestedPath);
  const suggestions = getRepoPathSuggestions(repoPaths, normalizedPath);

  if (suggestions.length > 0) {
    return `Error: \`${normalizedPath}\` is not present in the selected repository. Retry using one of these exact file paths from the loaded repo tree. Do not guess sibling paths or directory names.\nPossible matches:\n${suggestions.map((path) => `- ${path}`).join('\n')}`;
  }

  const samplePaths = getRepoPathExamples(repoPaths, normalizedPath);
  return `Error: \`${normalizedPath}\` is not present in the selected repository. Retry using an exact file path from the loaded repo tree. Do not guess sibling paths or directory names.${samplePaths.length > 0 ? ` Example paths from the same area:\n${samplePaths.map((path) => `- ${path}`).join('\n')}` : ''}`;
}

export function formatRepoTreeUnavailableError(repoStatus: 'idle' | 'loading' | 'ready' | 'error', repoError?: string | null): string {
  if (repoStatus === 'loading') {
    return 'Error: The selected repository is still indexing. Wait for the repo tree to finish loading before reading files.';
  }

  if (repoStatus === 'error') {
    return `Error: The selected repository tree could not be indexed${repoError ? ` (${repoError})` : ''}. Re-select the repo or wait for indexing to recover before reading files.`;
  }

  return 'Error: The selected repository file tree is not available yet. Load the repo tree before reading files so you can choose a real path.';
}

export function getRepoToolExistingPaths(scopeId: string): Set<string> {
  const changeset = useChangesetStore.getState().getChangeset(scopeId);
  return new Set<string>([
    ...changeset.repoFileTree,
    ...Object.keys(changeset.repoFileCache),
    ...Object.keys(changeset.changes),
  ]);
}

export function resolveRepoWriteAction(
  requestedAction: 'create' | 'edit' | 'delete',
  path: string,
  existingPaths: Set<string>,
): 'create' | 'edit' | 'delete' {
  if (requestedAction === 'create' && existingPaths.has(path)) {
    return 'edit';
  }
  return requestedAction;
}

/**
 * Sanitize messages so that any tool invocations stuck in 'partial-call' or 'call'
 * state (from an interrupted stream) get a synthetic error result.
 * Without this, the AI SDK throws "ToolInvocation must have a result".
 */
export function sanitizePartialToolCalls<T extends { parts?: Array<Record<string, unknown>>; toolInvocations?: Array<Record<string, unknown>> }>(msgs: T[]): T[] {
  let dirty = false;
  const cleaned = msgs.map((msg) => {
    let msgDirty = false;

    const fixedParts = msg.parts?.map((part) => {
      if (
        part.type === 'tool-invocation' &&
        (part as { toolInvocation?: { state?: string } }).toolInvocation &&
        ((part as { toolInvocation: { state: string } }).toolInvocation.state === 'partial-call' ||
         (part as { toolInvocation: { state: string } }).toolInvocation.state === 'call')
      ) {
        msgDirty = true;
        return {
          ...part,
          toolInvocation: {
            ...(part as { toolInvocation: Record<string, unknown> }).toolInvocation,
            state: 'result',
            result: { error: 'Tool call was interrupted mid-execution. Please retry this tool call to complete the operation.' },
          },
        };
      }
      return part;
    });

    const fixedInvocations = msg.toolInvocations?.map((inv) => {
      if (inv.state === 'partial-call' || inv.state === 'call') {
        msgDirty = true;
        return { ...inv, state: 'result', result: { error: 'Tool call was interrupted mid-execution. Please retry this tool call to complete the operation.' } };
      }
      return inv;
    });

    if (msgDirty) {
      dirty = true;
      return { ...msg, parts: fixedParts ?? msg.parts, toolInvocations: fixedInvocations ?? msg.toolInvocations };
    }
    return msg;
  });

  return dirty ? cleaned : msgs;
}

export function toStoredAIMessages(msgs: Awaited<ReturnType<typeof db.messages.getByConversation>>): AIMessage[] {
  const restored = msgs.map((m) => ({
    id: m.id,
    role: m.role as AIMessage['role'],
    content: m.content,
    timestamp: m.timestamp,
    ...(m.parts ? { parts: m.parts } : {}),
    ...(m.toolInvocations ? { toolInvocations: m.toolInvocations } : {}),
  }));

  return sanitizePartialToolCalls(restored as Array<{
    id: string;
    role: AIMessage['role'];
    content: string;
    timestamp: string;
    parts?: Array<Record<string, unknown>>;
    toolInvocations?: Array<Record<string, unknown>>;
  }>) as unknown as AIMessage[];
}

export function isServerToolEvent(value: unknown): value is ServerToolEvent {
  return !!value && typeof value === 'object' && 'type' in value && (SERVER_TOOL_EVENT_TYPES as Set<string>).has((value as { type: string }).type);
}

export function isServerExecutedRepoToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && (SERVER_EXECUTED_REPO_TOOLS as Set<string>).has(toolName);
}

export function isHermesToolActivityData(
  value: unknown,
): value is { type: 'hermes_tool_activity'; activity: ToolActivityEvent } {
  return !!value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'hermes_tool_activity'
    && !!(value as { activity?: unknown }).activity
    && typeof (value as { activity?: unknown }).activity === 'object';
}

export interface AgentStatusEvent {
  label: string;
  phase?: string;
  iteration?: number;
  elapsed_ms?: number;
  source?: string;
}

export function isAgentStatusData(
  value: unknown,
): value is { type: 'agent_status'; status: AgentStatusEvent } {
  return !!value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'agent_status'
    && !!(value as { status?: unknown }).status
    && typeof (value as { status?: unknown }).status === 'object'
    && typeof ((value as { status: { label?: unknown } }).status.label) === 'string';
}

export interface HermesLoopStatusEvent {
  phase: 'agent' | 'judge' | 'done' | 'stopped' | 'error';
  iteration: number;
  maxIterations: number;
  stopReason?: string;
}

export function isHermesLoopStatusData(
  value: unknown,
): value is { type: 'hermes_loop_status'; status: HermesLoopStatusEvent } {
  return !!value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'hermes_loop_status'
    && !!(value as { status?: unknown }).status
    && typeof (value as { status?: unknown }).status === 'object'
    && typeof ((value as { status: { phase?: unknown } }).status.phase) === 'string';
}

export async function upsertStoredMessage(message: StoredMessage): Promise<void> {
  try {
    await db.messages.add(message);
  } catch {
    await db.messages.update(message.id, message);
  }
}

function parseToolActivityInput(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : { input: trimmed };
  } catch {
    return { input: trimmed };
  }
}

export function synthesizeToolInvocationsForPersistence(
  toolActivity: ToolActivityEvent[] = [],
  serverToolEvents: ServerToolEvent[] = [],
): Array<Record<string, unknown>> {
  const serverInvocations = serverToolEvents.map((event, index) => {
    switch (event.type) {
      case 'repo_file_read':
        return {
          toolCallId: `server-read-${index}:${event.path}`,
          toolName: 'read_repo_file',
          args: { path: event.path },
          state: 'result',
          result: { ok: true },
        };
      case 'repo_file_edit':
        return {
          toolCallId: `server-edit-${index}:${event.path}`,
          toolName: 'edit_repo_file',
          args: { path: event.path, content: event.content, description: event.description },
          state: 'result',
          result: { ok: true },
        };
      case 'repo_file_create':
        return {
          toolCallId: `server-create-${index}:${event.path}`,
          toolName: 'create_repo_file',
          args: { path: event.path, content: event.content, description: event.description },
          state: 'result',
          result: { ok: true },
        };
      case 'repo_file_delete':
        return {
          toolCallId: `server-delete-${index}:${event.path}`,
          toolName: 'delete_repo_file',
          args: { path: event.path, reason: event.reason },
          state: 'result',
          result: { ok: true },
        };
      case 'repo_batch_edit':
        return {
          toolCallId: `server-batch-edit-${index}`,
          toolName: 'batch_edit_repo_files',
          args: {
            changes: event.changes.map((change) => ({
              path: change.path,
              action: change.action,
              content: change.content,
              description: change.description,
            })),
          },
          state: 'result',
          result: { ok: true },
        };
      case 'repo_proposal':
        return {
          toolCallId: `server-proposal-${index}`,
          toolName: 'propose_changes',
          args: {
            summary: event.summary,
            plan: event.plan,
          },
          state: 'result',
          result: { ok: true },
        };
    }
  });

  const activityInvocations = toolActivity.map((event, index) => ({
    toolCallId: `activity-${index}:${event.tool}`,
    toolName: event.tool,
    args: parseToolActivityInput(event.input),
    state: event.status === 'completed' ? 'result' : 'call',
    ...(event.status === 'completed'
      ? {
          result: event.output
            ? (/^(error|failed)[:\s]/i.test(event.output.trim())
                ? { error: event.output.trim() }
                : { output: event.output })
            : { ok: true },
        }
      : {}),
    ...(typeof event.textOffset === 'number' ? { textOffset: event.textOffset } : {}),
  }));

  // Merge both sources — server tool events first (repo ops), then tool activity
  // (non-repo tools). This preserves all invocations in mixed Hermes turns.
  return [...serverInvocations, ...activityInvocations];
}

export const REPO_EDIT_TOOL_NAMES = new Set([
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
]);

export const REPO_MODE_DISABLED_HERMES_TOOLSETS = new Set([
  'terminal',
  'files',
  'code_execution',
  'computer',
]);

export function collectStructuredToolNames(message: {
  parts?: Array<{ type?: string; toolInvocation?: { toolName?: string } }>;
  toolInvocations?: Array<{ toolName?: string }>;
}): string[] {
  const partInvocations = message.parts
    ?.filter((part) => part.type === 'tool-invocation' && part.toolInvocation?.toolName)
    .map((part) => part.toolInvocation?.toolName ?? '')
    ?? [];
  const toolInvocationNames = message.toolInvocations?.map((invocation) => invocation.toolName ?? '') ?? [];
  return [...partInvocations, ...toolInvocationNames].filter(Boolean);
}

export function collectRepoWorkflowToolNames(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
  serverToolEvents: ServerToolEvent[] = [],
): string[] {
  const structuredToolNames = collectStructuredToolNames(message);
  const activityNames = toolActivity.map((event) => event.tool.toLowerCase());
  const serverEventNames = serverToolEvents.flatMap((event) => {
    switch (event.type) {
      case 'repo_file_read':
        return ['read_repo_file'];
      case 'repo_file_edit':
        return ['edit_repo_file'];
      case 'repo_file_create':
        return ['create_repo_file'];
      case 'repo_file_delete':
        return ['delete_repo_file'];
      case 'repo_batch_edit':
        return ['batch_edit_repo_files'];
      case 'repo_proposal':
        return ['propose_changes'];
      default:
        return [];
    }
  });

  return [...structuredToolNames, ...activityNames, ...serverEventNames]
    .map((toolName) => toolName.toLowerCase())
    .filter((toolName) =>
      toolName === 'read_repo_file' ||
      REPO_EDIT_TOOL_NAMES.has(toolName),
    );
}

export function stalledOnRepoRead(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
  serverToolEvents: ServerToolEvent[] = [],
): boolean {
  const orderedRepoWorkflowNames = collectRepoWorkflowToolNames(message, toolActivity, serverToolEvents);

  if (orderedRepoWorkflowNames.length === 0) {
    return false;
  }

  const lastTool = orderedRepoWorkflowNames.at(-1);

  // Stalled if the final repo workflow step is a file read (stopped mid-analysis)
  if (lastTool === 'read_repo_file') {
    return true;
  }

  return false;
}

/**
 * Detect when the agent describes what edit tools it will use in text
 * but stops without actually calling them. This happens when the LLM
 * generates text like "I'll use batch_edit_repo_files" instead of
 * actually invoking the tool.
 */
export function describedEditButDidNotExecute(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
    toolInvocations?: Array<{ toolName?: string }>;
  },
  toolActivity: ToolActivityEvent[] = [],
  serverToolEvents: ServerToolEvent[] = [],
  editIntent: boolean,
): boolean {
  if (!editIntent) return false;

  const content = getPseudoToolSourceText(message);
  const pseudoInvocations = extractPseudoToolInvocations(content);
  const recoverablePseudoEdit = pseudoInvocations.some((invocation) => REPO_EDIT_TOOL_NAMES.has(invocation.toolName));
  const recoverableTextEdit = extractTextFileEdits(content).length > 0;

  if (recoverablePseudoEdit || recoverableTextEdit) {
    return false;
  }

  // Check if the response text mentions repo edit tools
  const mentionsEditTools = /\b(?:batch_edit_repo_files|edit_repo_file|create_repo_file|delete_repo_file)\b/.test(content);
  if (!mentionsEditTools) return false;

  // Check if any edit tool was actually called (via structured tool invocations or tool activity)
  const repoWorkflowNames = collectRepoWorkflowToolNames(message, toolActivity, serverToolEvents);
  const calledEditTool = repoWorkflowNames.some((name) => REPO_EDIT_TOOL_NAMES.has(name));

  // Agent described an edit tool but never actually called one
  return !calledEditTool;
}

export interface ProviderOverride {
  provider: Provider;
  model: string;
}

export interface AutoContinueRequest {
  conversationId: string;
  content: string;
  continuingApprovedProposal?: boolean;
  forceRepoEditIntent?: boolean;
}

export interface SendMessageOptions {
  clearDraft?: boolean;
  repoEditIntentOverride?: boolean;
}

export function summarizeContentForLog(content: string, limit = 220): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

export function getPendingProposalKey(proposal: PendingProposal | null): string | null {
  if (!proposal) return null;
  return JSON.stringify({
    summary: proposal.summary ?? null,
    excerpt: proposal.excerpt ?? null,
    plan: proposal.plan,
  });
}

export function getServerToolEventKey(event: ServerToolEvent): string {
  return JSON.stringify(event);
}

export function hasRecoverablePseudoRepoWrites(
  message: {
    content?: string;
    parts?: Array<{ type?: string; text?: string }>;
  },
  allowPseudoRepoWrites: boolean,
): boolean {
  if (!allowPseudoRepoWrites) {
    return false;
  }

  const sourceText = getPseudoToolSourceText(message);
  if (
    extractPseudoToolInvocations(sourceText).some((invocation) => REPO_EDIT_TOOL_NAMES.has(invocation.toolName))
  ) {
    return true;
  }

  return extractTextFileEdits(sourceText).length > 0;
}

export function allowPseudoRepoWritesForAssistantMessage(
  messages: Array<{ role: string; content: string }>,
  assistantIndex: number,
): boolean {
  if (assistantIndex <= 0) {
    return false;
  }

  const previousUserMessage = messages.slice(0, assistantIndex).findLast((message) =>
    message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0,
  );

  return previousUserMessage ? isRepoWriteMessage(previousUserMessage.content) : false;
}

/**
 * Tailwind anchor class for a composer toolbar popover. The toolbar row clips
 * horizontally (`overflow-x-clip`, tagged `data-toolbar-clip`), so a popover
 * anchored `left-0` near the right edge of a narrow/split panel gets cut off —
 * flip it to `right-0` when it wouldn't fit.
 */
export function toolbarPopoverAlignment(anchor: HTMLElement | null, popoverWidth = 240): 'left-0' | 'right-0' {
  if (!anchor) return 'left-0';
  const clip = anchor.closest('[data-toolbar-clip]');
  if (!clip) return 'left-0';
  const fitsLeft = anchor.getBoundingClientRect().left + popoverWidth <= clip.getBoundingClientRect().right;
  return fitsLeft ? 'left-0' : 'right-0';
}
