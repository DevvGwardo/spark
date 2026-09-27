import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useChat as useAIChat, type UIMessage as AIMessage } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { parseDataStreamPart } from '@ai-sdk/ui-utils';
import { useShallow } from 'zustand/shallow';
import { useChatStore } from '@/stores/chat-store';
import { looksLikePlanText } from '@/lib/plan-steps';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore, type FileType, type PreviewFile, type ProjectType } from '@/stores/preview-store';
import { useActivityStore } from '@/stores/activity-store';
import { useUIStore } from '@/stores/ui-store';
import { db } from '@/lib/db';
import { fetchRepoFileTreeResult, getApiBaseUrl } from '@/lib/api';
import { createQueuedMessage, moveQueuedMessageToFront, removeQueuedMessage, type QueuedMessage } from '@/lib/chat-queue';
import { PROVIDERS, supportsReasoningEffort } from '@/lib/providers';
import { useHermesStore } from '@/stores/hermes-store';
import type { ToolCallRecords, ToolCallRecordsByMessage, ToolCallStatus } from '@/stores/hermes-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { evaluateCompaction } from '../../shared/compaction';
import { buildCompactionSummaryMessage, requestCompaction } from '@/lib/compaction-client';
import { getActiveProfile, useProfilesStore } from '@/stores/profiles-store';

import { getMessageContent } from './chat-utils';
export { getMessageContent } from './chat-utils';

import { useChatQueueStore } from '@/stores/chat-queue-store';
import { useStreamLockStore } from '@/stores/stream-lock-store';
import { usePanelStore } from '@/stores/panel-store';

import { findPendingProposal, type PendingProposal, type ProposalToolInvocationLike } from '@/lib/proposed-changes';
import {
  getRepoTurnIntentInstruction,
  isRepoApprovalFollowUpMessage,
  isRepoEditIntentMessage,
  isRepoWriteMessage,
} from '@/lib/repo-intent';
import type { ToolActivityEvent } from '@/components/chat/AgentActivity';
import {
  INITIAL_COMPUTER_USE_DOCK_STATE,
  isComputerUseFrameData,
  isComputerUseToolName,
  parseComputerUseFrame,
  reduceComputerUseDockState,
  type ComputerUseDockState,
} from '@/lib/computer-use-dock';
import { fetchComputerUseStatus } from '@/lib/hermes-api';
import { getErrorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { handleServerToolEvent, SERVER_EXECUTED_REPO_TOOLS, type ServerToolEvent } from '@/lib/server-tool-events';
import { getChatScopeId } from '@/lib/chat-scope';
import { resolveHermesSessionForResume, hermesSessionTitle, type HermesSessionMessage, type AcpApprovalRequest } from '@/lib/hermes-api';
import { expandContextRefs, hasContextRefs } from '@/lib/context-refs';
import { extractPseudoToolInvocations, extractTextFileEdits, getPseudoToolSourceText } from '@/lib/pseudo-tool-calls';
import { getLocalAbsolutePath, LOCAL_IMAGE_TOKEN_RE } from '@/lib/local-images';
import {
  normalizeBatchEditRepoFilesArgs,
  normalizeCreateRepoFileArgs,
  normalizeDeleteRepoFileArgs,
  normalizeEditRepoFileArgs,
  normalizeProposeChangesArgs,
} from '@/lib/repo-tool-args';
import {
  AUTO_CONTINUE_DELAY_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  CONVERSATION_TITLE_MAX_LENGTH,
  REPO_EDIT_TOOL_NAMES,
  REPO_MODE_DISABLED_HERMES_TOOLSETS,
  allowPseudoRepoWritesForAssistantMessage,
  collectRepoWorkflowToolNames,
  describedEditButDidNotExecute,
  formatMissingRepoFileError,
  formatRepoTreeUnavailableError,
  formatFallbackSwitchToast,
  formatHermesTransportStatus,
  getPendingProposalKey,
  getRepoToolExistingPaths,
  getServerToolEventKey,
  hasRecoverablePseudoRepoWrites,
  isAgentStatusData,
  isApprovalRequestData,
  isFallbackSwitchData,
  isHermesTransportStatusData,
  isHermesLoopStatusData,
  isHermesToolActivityData,
  isInvalidRepoReadPath,
  isServerExecutedRepoToolName,
  isServerToolEvent,
  normalizeRepoPath,
  parseFallbackSwitchDelta,
  parseHermesTransportStatusDelta,
  resolveRepoWriteAction,
  sanitizePartialToolCalls,
  synthesizeToolInvocationsForPersistence,
  stalledOnRepoRead,
  toStoredAIMessages,
  upsertStoredMessage,
  type AgentStatusEvent,
  type AutoContinueRequest,
  type ProviderOverride,
  type SendMessageOptions,
} from './chat-utils';
export type { AgentStatusEvent } from './chat-utils';

const HERMES_RESUME_CHAT_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

function hermesSessionChatToAIMessages(sessionId: string, chat: HermesSessionMessage[] | undefined): AIMessage[] {
  if (!chat?.length) return [];
  return (chat as HermesSessionMessage[])
    .filter((m) => getMessageContent(m).trim().length > 0)
    .filter((m) => HERMES_RESUME_CHAT_ROLES.has(m.role))
    .map((m, index) => {
      const textContent = getMessageContent(m);
      const content = m.role === 'tool' ? `[Tool result]\n${textContent}` : textContent;
      const parts = m.parts?.length ? m.parts : [{ type: 'text' as const, text: content }];

      return {
        id: `hermes-resume-${sessionId}-${index}`,
        role: (m.role === 'tool' ? 'assistant' : m.role) as AIMessage['role'],
        content,
        parts,
      };
    });
}

const TOOL_INVOCATION_STATE_PRIORITY: Record<string, number> = {
  'partial-call': 0,
  call: 1,
  result: 2,
};

function asUnknownArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value as unknown[] : undefined;
}

// ─── Structured tool-call events (bridge + server contract) ────────────────
// The backend emits these as custom JSON fields on `data:` lines
// (bridge: delta.* keys; server streamText path: data-part array items):
//   tool_call_begin {type, call_id, name, ts}
//   tool_call_delta {type, call_id, output}           (append-only chunks)
//   tool_call_end   {type, call_id, name, success, exit_code, duration_ms,
//                    output_truncated, output_truncated_lines}
// The pure reducer below maintains the per-call record map so components can
// render enriched tool cards (status verbs, exit codes, durations, output).

export interface ToolCallBeginEvent {
  type: 'tool_call_begin';
  call_id: string;
  name: string;
  ts?: number;
}

export interface ToolCallDeltaEvent {
  type: 'tool_call_delta';
  call_id: string;
  output: string;
}

export interface ToolCallEndEvent {
  type: 'tool_call_end';
  call_id: string;
  name: string;
  success: boolean;
  exit_code: number | null;
  duration_ms: number;
  output_truncated: boolean;
  output_truncated_lines: number;
}

export type ToolCallEvent = ToolCallBeginEvent | ToolCallDeltaEvent | ToolCallEndEvent;

export function parseToolCallEvent(value: unknown): ToolCallEvent | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const callId = typeof record.call_id === 'string' && record.call_id ? record.call_id : null;
  if (!callId) {
    return null;
  }
  if (record.type === 'tool_call_begin') {
    const name = typeof record.name === 'string' && record.name ? record.name : '';
    if (!name) {
      return null;
    }
    return {
      type: 'tool_call_begin',
      call_id: callId,
      name,
      ...(typeof record.ts === 'number' ? { ts: record.ts } : {}),
    };
  }
  if (record.type === 'tool_call_delta') {
    return {
      type: 'tool_call_delta',
      call_id: callId,
      output: typeof record.output === 'string' ? record.output : '',
    };
  }
  if (record.type === 'tool_call_end') {
    return {
      type: 'tool_call_end',
      call_id: callId,
      name: typeof record.name === 'string' ? record.name : '',
      success: record.success === true,
      exit_code: typeof record.exit_code === 'number' ? record.exit_code : null,
      duration_ms: typeof record.duration_ms === 'number' ? record.duration_ms : 0,
      output_truncated: record.output_truncated === true,
      output_truncated_lines: typeof record.output_truncated_lines === 'number'
        ? record.output_truncated_lines
        : 0,
    };
  }
  return null;
}

/**
 * Pure reducer for the per-conversation tool-call record map. Applies
 * begin/delta/end events; returns the same reference when nothing changed so
 * callers can cheaply detect updates.
 */
export function reduceToolCallRecords(
  records: ToolCallRecords,
  event: unknown,
): ToolCallRecords {
  const parsed = parseToolCallEvent(event);
  if (!parsed) {
    return records;
  }

  const current = records[parsed.call_id];

  if (parsed.type === 'tool_call_begin') {
    // A begin for an already-running call id (duplicate/retry replay) is a no-op.
    if (current && current.status === 'running') {
      return records;
    }
    // A begin after a terminal record for the SAME call id is a fresh run.
    if (current && current.name === parsed.name && current.status !== 'running') {
      return records;
    }
    return {
      ...records,
      [parsed.call_id]: {
        callId: parsed.call_id,
        name: parsed.name,
        status: 'running' as ToolCallStatus,
        outputChunks: [],
        output: '',
        exitCode: null,
        durationMs: null,
        outputTruncated: false,
        outputTruncatedLines: 0,
      },
    };
  }

  if (parsed.type === 'tool_call_delta') {
    if (!current || current.status !== 'running') {
      return records;
    }
    const outputChunks = [...current.outputChunks, parsed.output];
    return {
      ...records,
      [parsed.call_id]: { ...current, outputChunks, output: outputChunks.join('') },
    };
  }

  // tool_call_end
  const status: ToolCallStatus = parsed.success ? 'completed' : 'failed';
  if (!current) {
    // End without a begin (snapshot replay / dropped begin) — synthesize.
    return {
      ...records,
      [parsed.call_id]: {
        callId: parsed.call_id,
        name: parsed.name,
        status,
        outputChunks: [],
        output: '',
        exitCode: parsed.exit_code,
        durationMs: parsed.duration_ms,
        outputTruncated: parsed.output_truncated,
        outputTruncatedLines: parsed.output_truncated_lines,
      },
    };
  }
  if (current.status !== 'running') {
    return records;
  }
  return {
    ...records,
    [parsed.call_id]: {
      ...current,
      status,
      exitCode: parsed.exit_code,
      durationMs: parsed.duration_ms,
      outputTruncated: parsed.output_truncated,
      outputTruncatedLines: parsed.output_truncated_lines,
    },
  };
}

/** Compact duration: `1.2s` under a minute, `mm:ss` beyond. */
export function formatToolDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  const ms = Math.round(durationMs);
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface SplitToolOutputResult {
  head: string;
  tail: string;
  hiddenLines: number;
  totalLines: number;
}

/**
 * HEAD+TAIL output splitter for tool cards: keeps the first `headLines` and
 * last `tailLines` lines and reports how many middle lines were hidden so the
 * UI can render an expandable "… +N lines" row. Returns the untouched output
 * (hiddenLines 0) when everything fits.
 */
export function splitToolOutputHeadTail(
  output: string,
  opts?: { headLines?: number; tailLines?: number },
): SplitToolOutputResult {
  const headLines = Math.max(1, opts?.headLines ?? 12);
  const tailLines = Math.max(1, opts?.tailLines ?? 8);
  const lines = output.split('\n');
  const totalLines = lines.length;
  if (totalLines <= headLines + tailLines) {
    return { head: output, tail: '', hiddenLines: 0, totalLines };
  }
  return {
    head: lines.slice(0, headLines).join('\n'),
    tail: lines.slice(totalLines - tailLines).join('\n'),
    hiddenLines: totalLines - headLines - tailLines,
    totalLines,
  };
}

/** Short display prefix for a shell command used in approval audit lines. */
export function getCommandDisplayPrefix(command: string, max = 40): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }
  const prefix = trimmed.split(/\s+/).slice(0, 2).join(' ');
  return prefix.length > max ? `${prefix.slice(0, max - 1)}…` : prefix;
}

interface PlanStepLike {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function parsePlanSteps(payload: unknown): PlanStepLike[] | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const steps = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) {
    return null;
  }
  const parsed: PlanStepLike[] = [];
  for (const entry of steps) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const step = typeof record.step === 'string' && record.step.trim() ? record.step : '';
    if (!step) continue;
    const status = record.status === 'in_progress' || record.status === 'completed'
      ? record.status
      : 'pending';
    parsed.push({ step, status });
  }
  return parsed.length > 0 ? parsed : null;
}

/** Find a tool invocation's stored args in the message buffer (SDK parts or
 *  persisted toolInvocations), preferring an exact call_id match. */
function findToolInvocationArgs(
  msgs: AIMessage[],
  callId: string | undefined,
  toolName: string,
): { args?: Record<string, unknown> } | null {
  const hasCallId = typeof callId === 'string' && callId.length > 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const message = msgs[i] as unknown as {
      parts?: Array<{ toolInvocation?: { toolCallId?: string; toolName?: string; args?: Record<string, unknown> } }>;
      toolInvocations?: Array<{ toolCallId?: string; toolName?: string; args?: Record<string, unknown> }>;
    };
    const invocations = [
      ...(Array.isArray(message.parts) ? message.parts
        .filter((part) => part?.toolInvocation)
        .map((part) => part.toolInvocation as { toolCallId?: string; toolName?: string; args?: Record<string, unknown> }) : []),
      ...(Array.isArray(message.toolInvocations) ? message.toolInvocations : []),
    ];
    const exact = hasCallId
      ? invocations.find((inv) => inv?.toolCallId === callId)
      : undefined;
    const byName = exact
      ? undefined
      : invocations.find((inv) => inv?.toolName === toolName && typeof inv?.args === 'object');
    const match = exact ?? byName;
    if (match && typeof match.args === 'object' && match.args) {
      return { args: match.args as Record<string, unknown> };
    }
  }
  return null;
}

function truncateArgsJson(json: string, max = 2000): string {
  if (json.length <= max) {
    return json;
  }
  return `${json.slice(0, max)}…`;
}

function getPersistedToolInvocationKey(invocation: Record<string, unknown>, fallbackIndex: number): string {
  const toolName = typeof invocation.toolName === 'string' ? invocation.toolName : '';
  const args = invocation.args && typeof invocation.args === 'object'
    ? invocation.args as Record<string, unknown>
    : {};
  const path = typeof args.path === 'string' ? args.path : '';
  const filename = typeof args.filename === 'string' ? args.filename : '';
  const batchPaths = Array.isArray(args.changes)
    ? args.changes
        .map((change) =>
          change && typeof change === 'object'
            ? `${typeof (change as { action?: unknown }).action === 'string' ? (change as { action: string }).action : ''}:${typeof (change as { path?: unknown }).path === 'string' ? (change as { path: string }).path : ''}`
            : '',
        )
        .join('|')
    : '';

  if (toolName && (path || filename || batchPaths)) {
    return `${toolName}:${path}:${filename}:${batchPaths}`;
  }

  const toolCallId = typeof invocation.toolCallId === 'string' ? invocation.toolCallId : '';
  if (toolCallId) {
    return `${toolName}:${toolCallId}`;
  }

  const argsDigest = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
  return `${toolName}:${argsDigest || fallbackIndex}`;
}

function mergePersistedToolInvocation(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const currentPriority = TOOL_INVOCATION_STATE_PRIORITY[
    typeof current.state === 'string' ? current.state : ''
  ] ?? 0;
  const incomingPriority = TOOL_INVOCATION_STATE_PRIORITY[
    typeof incoming.state === 'string' ? incoming.state : ''
  ] ?? 0;
  const preferred = incomingPriority >= currentPriority ? incoming : current;
  const fallback = preferred === incoming ? current : incoming;

  return {
    ...fallback,
    ...preferred,
    args: preferred.args ?? fallback.args,
    result: preferred.result ?? fallback.result,
  };
}

function mergePersistedToolInvocations(
  ...groups: Array<unknown[] | undefined>
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const indexByKey = new Map<string, number>();

  for (const group of groups) {
    for (const invocation of group ?? []) {
      if (!invocation || typeof invocation !== 'object') {
        continue;
      }

      const record = invocation as Record<string, unknown>;
      const key = getPersistedToolInvocationKey(record, merged.length);
      const existingIndex = indexByKey.get(key);

      if (existingIndex === undefined) {
        indexByKey.set(key, merged.length);
        merged.push(record);
        continue;
      }

      merged[existingIndex] = mergePersistedToolInvocation(merged[existingIndex], record);
    }
  }

  return merged;
}

function pickPreferredArray(primary?: unknown[], secondary?: unknown[]): unknown[] | undefined {
  if ((secondary?.length ?? 0) > (primary?.length ?? 0)) {
    return secondary;
  }

  return primary ?? secondary;
}

type SnapshotLocalImageResult = { url: string; hash: string; path: string };

function replaceLocalImageRefsInText(
  text: string,
  replacements: Map<string, string>,
): string {
  const directPath = getLocalAbsolutePath(text);
  if (directPath) {
    return replacements.get(directPath) ?? text;
  }

  const tokenRegex = new RegExp(LOCAL_IMAGE_TOKEN_RE);
  return text.replace(tokenRegex, (match: string, leading: string, path: string, trailing = '') => {
    const absolutePath = getLocalAbsolutePath(path);
    const replacement = absolutePath ? replacements.get(absolutePath) : null;
    if (!replacement) return match;
    return `${leading}${replacement}${trailing}`;
  });
}

function collectLocalImagePathsFromText(text: string, paths: Set<string>) {
  const directPath = getLocalAbsolutePath(text);
  if (directPath) {
    paths.add(directPath);
  }

  const tokenRegex = new RegExp(LOCAL_IMAGE_TOKEN_RE);
  for (const match of text.matchAll(tokenRegex)) {
    const absolutePath = getLocalAbsolutePath(match[2] ?? '');
    if (absolutePath) {
      paths.add(absolutePath);
    }
  }
}

function collectLocalImagePathsFromValue(value: unknown, paths: Set<string>) {
  if (typeof value === 'string') {
    collectLocalImagePathsFromText(value, paths);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLocalImagePathsFromValue(item, paths);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const nestedValue of Object.values(value)) {
    collectLocalImagePathsFromValue(nestedValue, paths);
  }
}

function replaceLocalImageRefsInValue(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return replaceLocalImageRefsInText(value, replacements);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceLocalImageRefsInValue(item, replacements));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      replaceLocalImageRefsInValue(nestedValue, replacements),
    ]),
  );
}

async function snapshotAssistantMessageImages(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const snapshotLocalImage = window.electronAPI?.snapshotLocalImage;
  if (!snapshotLocalImage) {
    return message;
  }

  const localImagePaths = new Set<string>();
  if (typeof message.content === 'string') {
    collectLocalImagePathsFromText(message.content, localImagePaths);
  }

  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const invocation = (part as { toolInvocation?: { result?: unknown } }).toolInvocation;
    collectLocalImagePathsFromValue(invocation?.result, localImagePaths);
  }

  const toolInvocations = Array.isArray(message.toolInvocations) ? message.toolInvocations : [];
  for (const invocation of toolInvocations) {
    if (!invocation || typeof invocation !== 'object') continue;
    const result = (invocation as { result?: unknown }).result;
    collectLocalImagePathsFromValue(result, localImagePaths);
  }

  if (localImagePaths.size === 0) {
    return message;
  }

  const replacements = new Map<string, string>();
  await Promise.all(Array.from(localImagePaths).map(async (path) => {
    try {
      const snapshot = await snapshotLocalImage(path) as SnapshotLocalImageResult;
      if (snapshot?.url) {
        replacements.set(path, snapshot.url);
      }
    } catch {
      // Leave original references intact when snapshotting is unavailable.
    }
  }));

  if (replacements.size === 0) {
    return message;
  }

  const nextMessage: Record<string, unknown> = { ...message };

  if (typeof nextMessage.content === 'string') {
    nextMessage.content = replaceLocalImageRefsInText(nextMessage.content, replacements);
  }

  if (parts.length > 0) {
    nextMessage.parts = parts.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const toolInvocation = (part as { toolInvocation?: { result?: unknown } }).toolInvocation;
      if (typeof toolInvocation?.result === 'undefined') return part;

      return {
        ...part,
        toolInvocation: {
          ...toolInvocation,
          result: replaceLocalImageRefsInValue(toolInvocation.result, replacements),
        },
      };
    });
  }

  if (toolInvocations.length > 0) {
    nextMessage.toolInvocations = toolInvocations.map((invocation) => {
      if (!invocation || typeof invocation !== 'object') return invocation;
      const result = (invocation as { result?: unknown }).result;
      if (typeof result === 'undefined') return invocation;

      return {
        ...invocation,
        result: replaceLocalImageRefsInValue(result, replacements),
      };
    });
  }

  return nextMessage;
}

function buildAssistantSnapshotForPersistence(params: {
  message?: Record<string, unknown>;
  streamedMessage?: Record<string, unknown>;
  toolActivity?: ToolActivityEvent[];
  serverToolEvents?: ServerToolEvent[];
  fallbackId?: string;
  fallbackTimestamp?: string;
}): Record<string, unknown> | undefined {
  const source = params.message ?? {};
  const streamed = params.streamedMessage ?? {};
  const parts = pickPreferredArray(asUnknownArray(source.parts), asUnknownArray(streamed.parts));
  const sourceContent = typeof source.content === 'string' ? source.content : undefined;
  const streamedContent = typeof streamed.content === 'string' ? streamed.content : undefined;
  const toolInvocations = mergePersistedToolInvocations(
    asUnknownArray(source.toolInvocations),
    asUnknownArray(streamed.toolInvocations),
    synthesizeToolInvocationsForPersistence(
      params.toolActivity ?? [],
      params.serverToolEvents ?? [],
    ),
  );
  const id = typeof source.id === 'string' && source.id
    ? source.id
    : typeof streamed.id === 'string' && streamed.id
      ? streamed.id
      : params.fallbackId;

  if (!id) {
    return undefined;
  }

  const timestamp = typeof source.timestamp === 'string' && source.timestamp
    ? source.timestamp
    : typeof streamed.timestamp === 'string' && streamed.timestamp
      ? streamed.timestamp
      : params.fallbackTimestamp ?? new Date().toISOString();

  return {
    id,
    role: typeof source.role === 'string'
      ? source.role
      : typeof streamed.role === 'string'
        ? streamed.role
        : 'assistant',
    content: sourceContent && sourceContent.length > 0
      ? sourceContent
      : (streamedContent ?? sourceContent ?? ''),
    timestamp,
    ...(parts ? { parts } : {}),
    ...(toolInvocations.length > 0 ? { toolInvocations } : {}),
  };
}

export function useChat(
  conversationId: string | null,
  onConversationCreated?: (id: string) => void,
  providerOverride?: ProviderOverride,
  panelId: string = 'default',
  onReadyForPR?: (panelId: string, mode?: 'create' | 'review') => void,
  stateScopeId?: string,
) {
  const sanitizeRetryMessages = useCallback((msgs: AIMessage[]): AIMessage[] => (
    sanitizePartialToolCalls(
      msgs as unknown as Array<{
        id: string;
        role: AIMessage['role'];
        content: string;
        parts?: Array<Record<string, unknown>>;
        toolInvocations?: Array<Record<string, unknown>>;
      }>,
    ) as unknown as AIMessage[]
  ), []);

  const scopeId = stateScopeId ?? panelId;
  const createConversation = useChatStore((s) => s.createConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const loadConversations = useChatStore((s) => s.loadConversations);

  // Each non-default panel is a fully isolated session with its own Hermes
  // profile. The 'default' panel keeps the legacy behavior of tracking the
  // globally selected profile so existing single-session workflows and the
  // profiles settings UI still work. Read latest value at call time to match
  // the prior getActiveProfile() semantics and avoid stale closures.
  const getSessionProfile = useCallback((): string => {
    if (panelId === 'default') return getActiveProfile();
    const panel = usePanelStore.getState().panels.find((p) => p.id === panelId);
    return panel?.profile || getActiveProfile();
  }, [panelId]);

  const { activeProvider, providers, defaultSystemPrompt, githubPAT, autoApproveRepoChanges, outputStyle } = useSettingsStore(
    useShallow((s) => ({
      activeProvider: s.activeProvider,
      providers: s.providers,
      defaultSystemPrompt: s.defaultSystemPrompt,
      githubPAT: s.githubPAT,
      autoApproveRepoChanges: s.autoApproveRepoChanges,
      outputStyle: s.outputStyle,
    })),
  );
  const knowledgeContext = useKnowledgeStore((s) => s.getActiveContext());
  const changeset = useChangesetStore(useShallow((s) => s.getChangeset(scopeId)));
  const addChangeForPanel = useChangesetStore((s) => s.addChange);
  const preview = usePreviewStore(useShallow((s) => s.getPreview(scopeId)));
  const pendingPanelPrompt = useUIStore((s) => s.pendingPanelPrompts[panelId] ?? null);
  const clearPanelPrompt = useUIStore((s) => s.clearPanelPrompt);
  const { activeRepo, isRepoMode } = changeset;
  const hermesToolsetConfig = useHermesStore((s) => s.toolsets);
  const hermesSwarmEnabled = useHermesStore((s) => s.swarm.enabled);
  const hermesLoopEnabled = useHermesStore((s) => s.loops[panelId]?.enabled ?? false);
  const hermesToolsets = useMemo(
    () =>
      Object.entries(hermesToolsetConfig)
        .filter(([, enabled]) => enabled)
        .map(([toolset]) => toolset),
    [hermesToolsetConfig],
  );
  // Local execution toolsets (terminal, files, code_execution) sent to all non-Hermes providers
  const agentToolsets = useMemo(
    () =>
      Object.entries(hermesToolsetConfig)
        .filter(([key, enabled]) => enabled && (key === 'terminal' || key === 'files' || key === 'code_execution'))
        .map(([key]) => key)
        .join(','),
    [hermesToolsetConfig],
  );
  const addChange = useCallback((change: Parameters<typeof addChangeForPanel>[1]) => addChangeForPanel(scopeId, change), [addChangeForPanel, scopeId]);

  // Determine effective provider/model (supports overrides)
  const effectiveProvider = providerOverride?.provider ?? activeProvider;
  const config = providers[effectiveProvider];
  const effectiveModel = providerOverride?.model ?? config.model;
  const reasoningEffort = supportsReasoningEffort(effectiveProvider, effectiveModel)
    ? config.reasoningEffort
    : undefined;

  const baseSystemPrompt = knowledgeContext
    ? `${defaultSystemPrompt}\n\n--- Knowledge Base ---\n${knowledgeContext}`
    : defaultSystemPrompt;

  const buildRepoSystemPrompt = useCallback((
    repo: typeof activeRepo,
    repoMode: boolean,
    repoEditIntent: boolean,
    hasRepoAccess: boolean,
  ) => {
    let prompt = baseSystemPrompt;

    if (repoMode && repo) {
      let repoContext = `\n\n--- GitHub Repository ---\nYou are working on the GitHub repository ${repo.fullName} (default branch: ${repo.defaultBranch}).

IMPORTANT: First determine whether the current user turn is asking for read-only repository help or for actual code changes.
- If the user is asking what the repo is, how it works, where something lives, for an overview, or for analysis/review, stay read-only: inspect files as needed and answer directly.
- Only begin editing when the user explicitly asks you to modify the repository.
- Never treat repo selection by itself as permission to edit.

When the user asks you to make changes:
1. Use read_repo_file to read the files you need to understand and modify.
2. Then use batch_edit_repo_files to apply ALL changes at once (preferred), or edit_repo_file / create_repo_file individually.
3. Do NOT ask the user to specify file paths or share files — explore the repo yourself using the repository context provided with the request.
4. Do NOT ask clarifying questions. Use your judgment, explore the repo to understand the codebase, and make the changes directly. If the request is ambiguous, make reasonable assumptions and explain them.
5. When the user asks you to update multiple things, make sure you address ALL of them, not just one.
6. All changes are staged for a pull request (not applied directly).
7. Never print pseudo-tool syntax like batch_edit_repo_files(...) in visible text. Use the actual tool calls instead.
8. IMPORTANT: If you need to edit many large files, split batch_edit_repo_files into multiple calls (max 3-4 files per batch) to avoid output truncation. For very large files, use individual edit_repo_file calls instead.
9. Never conclude that the repository is empty or inaccessible just because a guessed file path failed to read. If a read fails, choose another path from the loaded repo tree and continue exploring.
10. Do not guess generic placeholder paths like \`.\`, \`/\`, \`src/main\`, \`server\`, \`client\`, or \`package.json\` unless that exact path is present in the loaded repo tree.
11. Only use exact file paths that appear in the repo tree or that are returned by a read_repo_file error as a possible match. Do not infer unlisted sibling paths or directory names.`;

      if (!hasRepoAccess) {
        repoContext += `\n11. GitHub file access is unavailable for this request because no GitHub token is configured. Do not call repo tools and do not search the web just to compensate for missing repo access.
12. If the user asked for explanation or analysis, work only from the issue text and any already provided context. Mention the access limitation once, then provide the best concise analysis you can without repeating the issue description verbatim.
13. If the user asked for code changes, explain briefly that repository access is unavailable and that you cannot inspect or modify files until GitHub access is configured.`;
      }

      prompt += repoContext;
      prompt = `${prompt}\n\n${getRepoTurnIntentInstruction(repoEditIntent)}`;
    }

    return prompt;
  }, [baseSystemPrompt]);

  const apiBaseUrl = getApiBaseUrl();

  // Use a ref so callbacks always have current conversation ID.
  // We update it lazily in the conversation-switch effect (not eagerly on every render)
  // so that onFinish for a streaming response can still persist to the correct conversation.
  const convIdRef = useRef(conversationId);

  // Skip the next IndexedDB reload when we just created a conversation and are about to append
  const skipNextLoadRef = useRef(false);
  // Keep a just-created conversation local until the first send settles.
  // Switching the panel immediately remounts the chat tree and drops the in-flight transcript.
  const pendingConversationIdRef = useRef<string | null>(null);
  // Captures the conversationId at stream start so we can distinguish the
  // draft→new-conv promotion (keep session) from a user navigating to a
  // different thread mid-stream (advance session so the UI reflects the
  // new thread). Set when isStreaming goes false→true; cleared on end.
  const streamConvIdRef = useRef<string | null>(null);
  // Tracks the conversationId the user is *currently viewing*, updated every
  // render. Unlike convIdRef (which intentionally lags behind during a
  // mid-stream conversation switch so in-flight tool events stay routed to
  // the aborting conversation), this ref always reflects the prop. Used as a
  // secondary guard in onFinish so a late write from the aborting stream
  // doesn't clobber the visible buffer of whichever conversation the user
  // has navigated to.
  const viewedConvIdRef = useRef<string | null>(null);
  viewedConvIdRef.current = conversationId;
  // Captures the scopeId at stream start so late onToolCall callbacks from an
  // aborted stream don't write changeset/preview state into the new conversation's scope.
  const streamScopeIdRef = useRef<string | null>(null);
  const repoEditIntentRef = useRef(false);
  const pendingProposalRef = useRef<PendingProposal | null>(null);
  const explicitProposalKeyRef = useRef<string | null>(null);
  const approvedProposalContinuationRef = useRef<{
    conversationId: string | null;
    proposalKey: string | null;
  } | null>(null);
  const pausedProposalKeyRef = useRef<string | null>(null);
  const contentProposalStabilityRef = useRef<{ key: string | null; cycles: number }>({
    key: null,
    cycles: 0,
  });
  const appliedPseudoRepoMessageIdsRef = useRef(new Set<string>());
  // Track scopes that have been hydrated from DB this session.
  // Once a scope is hydrated (or populated by the user), we use in-memory state
  // on subsequent visits and skip the async DB read entirely.
  const hydratedScopesRef = useRef(new Set<string>());

  const resetPanelFileState = useCallback(() => {
    const csStore = useChangesetStore.getState();
    const psStore = usePreviewStore.getState();
    csStore.clearActiveRepo(scopeId);
    psStore.resetPreview(scopeId);
  }, [scopeId]);

  const saveConversationFiles = useCallback((convId: string, sourceScopeId: string = scopeId) => {
    const cs = useChangesetStore.getState().getChangeset(sourceScopeId);
    const ps = usePreviewStore.getState().getPreview(sourceScopeId);

    // Keep the denormalized project pointer (attached repo) in sync so the sidebar
    // can group threads by project without loading each conversation's files. Only
    // write when it actually changed to avoid redundant updates during streaming.
    const repoFullName = cs.activeRepo?.fullName ?? null;
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (conv && (conv.repoFullName ?? null) !== repoFullName) {
      void db.conversations.update(convId, { repoFullName }).then(() => {
        void useChatStore.getState().loadConversations();
      });
    }

    const hasChanges = Object.keys(cs.changes).length > 0 || cs.activeRepo !== null;
    const hasFiles = ps.files.length > 0;

    if (!hasChanges && !hasFiles) {
      return db.conversationFiles.delete(convId);
    }

    return db.conversationFiles.save({
      conversationId: convId,
      changeset: {
        activeRepo: cs.activeRepo,
        isRepoMode: cs.isRepoMode,
        pullRequest: cs.pullRequest,
        changes: cs.changes,
        repoFileTree: cs.repoFileTree,
        repoFileCache: cs.repoFileCache,
        selectedRepoFilePath: cs.selectedRepoFilePath,
      },
      preview: {
        files: ps.files,
        activeFileId: ps.activeFileId,
        projectType: ps.projectType,
        isOpen: ps.isOpen,
        activeView: ps.activeView,
      },
      repoFileCache: Object.keys(cs.repoFileCache).length > 0
        ? cs.repoFileCache
        : undefined,
    });
  }, [scopeId]);

  const [draftInput, setDraftInput] = useState('');
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [providerUnavailableOpen, setProviderUnavailableOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [toolActivityMap, setToolActivityMap] = useState<Record<string, ToolActivityEvent[]>>({});
  const [agentStatus, setAgentStatus] = useState<AgentStatusEvent | null>(null);
  const [transportStatusMessage, setTransportStatusMessage] = useState<string | null>(null);
  const [computerUseDock, setComputerUseDock] = useState<ComputerUseDockState>(INITIAL_COMPUTER_USE_DOCK_STATE);
  const [conversationAutoApproveEnabled, setConversationAutoApproveEnabled] = useState(false);
  const requestConversationIdRef = useRef<string | null>(conversationId);
  /** When set, Hermes chat requests use this id as conversation_id (session attach). */
  const hermesSessionIdOverrideRef = useRef<string | null>(null);
  const activeRequestBodyRef = useRef<Record<string, unknown> | null>(null);
  const toolActivityRef = useRef<Record<string, ToolActivityEvent[]>>({});
  // Structured tool-call records (message id / 'current' → call_id → record)
  // reduced from the tool_call_begin/delta/end custom fields. Mirrored into
  // the hermes store (per panel) so chat components can render enriched
  // cards. Keyed like toolActivityRef: 'current' while streaming, message id
  // after finish.
  const [toolCallRecords, setToolCallRecordsState] = useState<ToolCallRecordsByMessage>({});
  const toolCallRecordsRef = useRef<ToolCallRecordsByMessage>({});
  // True between a stream_retry event and the next stream event — the status
  // row shows "Reconnecting…" while set, then clears itself.
  const streamRetryShowingRef = useRef(false);
  // Cap explicit user-initiated tool retries per message to avoid loops.
  const visibleRetryCountRef = useRef(0);
  const MAX_VISIBLE_TOOL_RETRIES = 3;
  // Tool calls already explicitly retried this turn — makes the visible Retry
  // idempotent (a queued duplicate click is dropped instead of double-firing).
  const retriedToolsRef = useRef(new Set<string>());
  // True between a send that had planMode enabled and the finish of that
  // assistant turn. onFinish uses it to park the delivered plan text in
  // `planGatePrompt` (the implementation gate). Only set on the send path, so
  // mid-stream plan_update events (the live checklist) never trigger it.
  const planModeTurnRef = useRef(false);

  // Hook-level counterpart of the scanner's per-stream retry clear — used by
  // onFinish/onError/sendMessage where the chatStreamFetch closure is out of
  // scope.
  const clearStreamRetryIndicator = useCallback(() => {
    if (!streamRetryShowingRef.current) {
      return;
    }
    streamRetryShowingRef.current = false;
    useChatStore.getState().setStreamRetry(null);
  }, []);
  const computerUsePermissionsCheckedRef = useRef(false);
  const serverToolEventsRef = useRef<Record<string, ServerToolEvent[]>>({});
  const serverToolEventKeysRef = useRef<Record<string, Set<string>>>({});
  const serverSideToolsDetectedRef = useRef(false);
  // Use only the prop-level conversationId for the AI SDK session key.
  // pendingConversationIdRef must NOT influence the session ID because it gets
  // set inside sendMessage *before* append() runs. If the session switches early,
  // append targets the old draft session while the UI shows the new (empty) one,
  // causing messages to vanish.
  // A unique draft epoch ensures each "New thread" gets a fresh AI SDK session
  // so stale messages/status from a previous draft don't bleed through.
  const draftEpochRef = useRef(0);
  const prevConversationIdForSessionRef = useRef(conversationId);
  if (prevConversationIdForSessionRef.current !== null && conversationId === null) {
    draftEpochRef.current += 1;
  }
  prevConversationIdForSessionRef.current = conversationId;
  // sessionLock pins the AI SDK session key during a draft→conv promotion.
  // sendMessage binds the panel to the freshly created conversation before
  // append() resolves, which would otherwise swap AI SDK buckets mid-stream
  // and strand the response on draft-N:panel while the UI watches empty
  // conv:panel. Set when sendMessage creates the conversation; cleared by
  // the effect below once isStreaming flips false.
  const [sessionLock, setSessionLock] = useState<string | null>(null);
  const derivedSessionId = `${conversationId ?? `draft-${draftEpochRef.current}`}:${panelId}`;
  const chatSessionId = sessionLock ?? derivedSessionId;
  // Derive aiChatSessionId directly from chatSessionId so it tracks
  // conversationId synchronously. The previous useState + useLayoutEffect
  // pattern caused a race condition: when the user switched conversations
  // mid-stream, aiChatSessionId stayed stale (blocked by isStreaming guard in
  // useLayoutEffect), which also blocked the conversation-switch effect
  // (guarded on aiChatSessionId !== chatSessionId). This meant
  // hydrateConversationMessages was never called and the UI kept showing the
  // old conversation's messages.
  const aiChatSessionId = chatSessionId;
  const isStreamingRef = useRef(false);
  const shouldRetainRequestConversationId =
    conversationId === null && (isStreamingRef.current || pendingConversationIdRef.current !== null);
  // Keep the request conversation aligned with the visible conversation unless we are
  // intentionally holding on to the previous conversation during an in-flight handoff.
  requestConversationIdRef.current = shouldRetainRequestConversationId
    ? requestConversationIdRef.current
    : conversationId;
  const abortControllerRef = useRef<AbortController | null>(null);
  const isSendingRef = useRef(false);
  const autoSendingQueuedRef = useRef<string | null>(null);
  // Track consecutive 'unknown' finish reasons during active repo work to auto-continue
  // when the model is interrupted (e.g. token limit, dropped stream). Cap retries to
  // prevent infinite loops.
  const unknownFinishRetryRef = useRef(0);
  const MAX_UNKNOWN_FINISH_RETRIES = 6;
  const repoStopRetryRef = useRef(0);
  const MAX_REPO_STOP_RETRIES = 5;
  const autoContinueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when the user explicitly clicks stop — prevents onFinish from auto-continuing
  const userStoppedRef = useRef(false);
  const messagesRef = useRef<AIMessage[]>([]);

  const persistAssistantSnapshot = useCallback(async (
    message: Record<string, unknown>,
    convId: string,
    fallback?: {
      toolActivity?: ToolActivityEvent[];
      serverToolEvents?: ServerToolEvent[];
    },
  ) => {
    const messageId = typeof message.id === 'string' && message.id ? message.id : crypto.randomUUID();
    const timestamp = typeof message.timestamp === 'string' && message.timestamp
      ? message.timestamp
      : new Date().toISOString();
    const streamedMessage = messagesRef.current.find((entry) => entry.id === messageId) as
      | (AIMessage & { timestamp?: string })
      | undefined;
    const snapshot = buildAssistantSnapshotForPersistence({
      message: {
        ...message,
        id: messageId,
        timestamp,
      },
      streamedMessage: streamedMessage as unknown as Record<string, unknown> | undefined,
      toolActivity: fallback?.toolActivity,
      serverToolEvents: fallback?.serverToolEvents,
      fallbackId: messageId,
      fallbackTimestamp: timestamp,
    });

    if (!snapshot) {
      return;
    }

    const persistedSnapshot = await snapshotAssistantMessageImages(snapshot);

    const parts = asUnknownArray(persistedSnapshot.parts);
    const toolInvocations = asUnknownArray(persistedSnapshot.toolInvocations);

    await upsertStoredMessage({
      id: messageId,
      conversationId: convId,
      role: 'assistant',
      content: typeof persistedSnapshot.content === 'string' ? persistedSnapshot.content : '',
      timestamp: typeof persistedSnapshot.timestamp === 'string' ? persistedSnapshot.timestamp : timestamp,
      parts,
      toolInvocations: toolInvocations && toolInvocations.length > 0
        ? toolInvocations
        : undefined,
    });
    await db.conversations.update(convId, { updatedAt: new Date().toISOString() });
    await loadConversations();
  }, [loadConversations]);

  const chatStreamFetch = useCallback(async (url: URL | RequestInfo, init?: RequestInit) => {
    // Cancel any previous streaming request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        'X-Hermes-Profile': getSessionProfile(),
      },
      signal: abortControllerRef.current.signal,
    });
    if (!response.ok) {
      const text = await response.clone().text().catch(() => '');
      console.error(`[useChat] fetch Error response body:`, text.slice(0, 500));
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === 'string' && parsed.error.trim()) {
            throw new Error(parsed.error);
          }
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message !== text) {
            throw parseError;
          }
        }
        throw new Error(text);
      }
      throw new Error(`Request failed with status ${response.status}`);
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const applyServerToolEvent = (event: ServerToolEvent) => {
      const msgId = 'current';
      const eventKey = getServerToolEventKey(event);
      const seenEventKeys = serverToolEventKeysRef.current[msgId] ?? new Set<string>();

      if (seenEventKeys.has(eventKey)) {
        return;
      }

      seenEventKeys.add(eventKey);
      serverToolEventKeysRef.current[msgId] = seenEventKeys;
      serverSideToolsDetectedRef.current = true;
      const currentEvents = serverToolEventsRef.current[msgId] || [];
      serverToolEventsRef.current = {
        ...serverToolEventsRef.current,
        [msgId]: [...currentEvents, event],
      };
      if (event.type === 'repo_proposal') {
        const plan = Array.isArray(event.plan)
          ? event.plan
              .filter((item): item is { path: string; action: string; description: string } =>
                !!item &&
                typeof item === 'object' &&
                typeof (item as { path?: unknown }).path === 'string' &&
                typeof (item as { action?: unknown }).action === 'string' &&
                typeof (item as { description?: unknown }).description === 'string',
              )
              .map((item) => ({
                path: item.path,
                action: item.action,
                description: item.description,
              }))
          : [];
        pendingProposalRef.current = {
          messageId: '',
          summary: typeof event.summary === 'string' ? event.summary : null,
          excerpt: null,
          plan,
        };
        explicitProposalKeyRef.current = getPendingProposalKey(pendingProposalRef.current);
      }
      const addChangeFn = (change: { path: string; action: 'create' | 'edit' | 'delete'; content: string; originalContent?: string; staged: boolean }) => {
        const changesetStore = useChangesetStore.getState();
        const existing = changesetStore.getChangeset(scopeId).changes[change.path];
        const originalContent = change.originalContent ?? existing?.originalContent ?? '';
        changesetStore.addChange(scopeId, {
          path: change.path,
          action: change.action,
          content: change.content,
          originalContent,
          staged: change.staged,
        });
      };
      const batchAddChangesFn = (changes: Array<{ path: string; action: 'create' | 'edit' | 'delete'; content: string; originalContent?: string; staged: boolean }>) => {
        const changesetStore = useChangesetStore.getState();
        // Resolve originalContent for each change before the batch update
        const resolved = changes.map((change) => {
          const existing = changesetStore.getChangeset(scopeId).changes[change.path];
          return {
            ...change,
            originalContent: change.originalContent ?? existing?.originalContent ?? '',
          };
        });
        changesetStore.batchAddChanges(scopeId, resolved);
        // Verify
      };
      handleServerToolEvent(
        event,
        scopeId,
        {
          conversationId: convIdRef.current,
          addChange: addChangeFn,
          batchAddChanges: batchAddChangesFn,
        },
      );
    };

    const updateToolActivity = (activity: ToolActivityEvent) => {
      const msgId = 'current';
      const prev = [...(toolActivityRef.current[msgId] || [])];

      const existingIdx = activity.status === 'completed'
        ? prev.findLastIndex(
            (e) =>
              e.tool === activity.tool &&
              e.status === 'running' &&
              (!activity.input || e.input === activity.input),
          )
        : prev.findIndex(
            (e) => e.tool === activity.tool && e.input === activity.input && e.status === 'running',
          );

      if (existingIdx >= 0 && activity.status === 'completed') {
        // Preserve the running event's input (which has the full args)
        const fullInput = prev[existingIdx].input || activity.input;
        prev[existingIdx] = {
          ...prev[existingIdx],
          ...activity,
          input: fullInput,
          output: activity.output ?? prev[existingIdx].output,
        };
      } else if (existingIdx < 0) {
        prev.push(activity);
      }

      toolActivityRef.current = { ...toolActivityRef.current, [msgId]: prev };
      setToolActivityMap({ ...toolActivityRef.current });

      if (isComputerUseToolName(activity.tool)) {
        setComputerUseDock((current) => reduceComputerUseDockState(current, {
          toolActivity: {
            tool: activity.tool,
            status: activity.status,
            input: activity.input,
          },
        }));
        if (!computerUsePermissionsCheckedRef.current) {
          computerUsePermissionsCheckedRef.current = true;
          void fetchComputerUseStatus()
            .then((status) => {
              const raw = (status.raw || '').toLowerCase();
              let hint: string | null = null;
              if (raw.includes('not granted') || raw.includes('permission') || raw.includes('not ready')) {
                hint = 'Grant Accessibility and Screen Recording via hermes computer-use permissions.';
              } else if (!status.installed || raw.includes('not installed')) {
                hint = 'Install cua-driver from Hermes Ops before desktop control works.';
              }
              if (hint) {
                setComputerUseDock((current) => reduceComputerUseDockState(current, { permissionsHint: hint }));
              }
            })
            .catch(() => undefined);
        }
      }
    };

    const updateAgentStatus = (nextStatus: AgentStatusEvent) => {
      setAgentStatus((current) => {
        if (
          current?.label === nextStatus.label &&
          current?.phase === nextStatus.phase &&
          current?.iteration === nextStatus.iteration &&
          current?.elapsed_ms === nextStatus.elapsed_ms
        ) {
          return current;
        }
        return nextStatus;
      });
    };

    // ─── Structured tool-call events (tool_call_begin/delta/end) ────────────

    const applyToolCallRecords = (event: unknown) => {
      const current = toolCallRecordsRef.current;
      const nextCurrent = reduceToolCallRecords(current.current ?? {}, event);
      if (nextCurrent === current.current) {
        return;
      }
      const next = { ...current, current: nextCurrent };
      toolCallRecordsRef.current = next;
      setToolCallRecordsState(next);
      useHermesStore.getState().setToolCallRecords(panelId, next);
    };

    const clearStreamRetry = () => {
      clearStreamRetryIndicator();
    };

    // Only the conversation the user is currently viewing may write the
    // global plan/usage/retry slices — a mid-stream switch to another thread
    // must not clobber the visible conversation's state.
    const isCurrentConversationStream = () => {
      const viewed = viewedConvIdRef.current;
      const streamed = streamConvIdRef.current ?? convIdRef.current;
      return !viewed || !streamed || viewed === streamed;
    };

    const handleStreamRetry = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      streamRetryShowingRef.current = true;
      if (!isCurrentConversationStream()) {
        return;
      }
      const record = payload as Record<string, unknown>;
      useChatStore.getState().setStreamRetry({
        attempt: typeof record.attempt === 'number' ? record.attempt : 1,
        maxAttempts: typeof record.max_attempts === 'number' ? record.max_attempts : 1,
        reason: typeof record.reason === 'string' ? record.reason : '',
      });
    };

    const handlePlanUpdate = (payload: unknown) => {
      const steps = parsePlanSteps(payload);
      if (!steps || !isCurrentConversationStream()) {
        return;
      }
      useChatStore.getState().setPlanSteps(steps);
    };

    const handleUsageEvent = (payload: unknown) => {
      if (!payload || typeof payload !== 'object' || !isCurrentConversationStream()) {
        return;
      }
      const record = payload as Record<string, unknown>;
      const toNumber = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : 0;
      useContextUsageStore.getState().setUsage({
        inputTokens: toNumber(record.input_tokens),
        outputTokens: toNumber(record.output_tokens),
        ...(typeof record.cached_input_tokens === 'number' && Number.isFinite(record.cached_input_tokens)
          ? { cachedInputTokens: record.cached_input_tokens }
          : {}),
        contextWindow: toNumber(record.context_window),
        model: typeof record.model === 'string' ? record.model : '',
      });
    };

    // Enrich the matching toolActivity entry with structured execution info
    // (exit code, duration, truncation) when a tool_call_end arrives, so the
    // existing AgentActivity cards render the enriched UI without the cards
    // needing access to the records map.
    const enrichToolActivityFromRecord = (end: ToolCallEndEvent) => {
      const msgId = 'current';
      const prev = [...(toolActivityRef.current[msgId] || [])];
      const idx = prev.findLastIndex((e) => e.tool === end.name && e.status === 'running');
      if (idx < 0) {
        return;
      }
      prev[idx] = {
        ...prev[idx],
        success: end.success,
        exitCode: end.exit_code,
        durationMs: end.duration_ms,
        outputTruncated: end.output_truncated,
        outputTruncatedLines: end.output_truncated_lines,
      };
      toolActivityRef.current = { ...toolActivityRef.current, [msgId]: prev };
      setToolActivityMap({ ...toolActivityRef.current });
    };

    const handleToolCallEvent = (event: unknown) => {
      applyToolCallRecords(event);
      const parsed = parseToolCallEvent(event);
      if (parsed?.type === 'tool_call_end') {
        enrichToolActivityFromRecord(parsed);
      }
      clearStreamRetry();
    };

    const getCustomEventType = (value: unknown): string | null => {
      if (!value || typeof value !== 'object') {
        return null;
      }
      const type = (value as { type?: unknown }).type;
      return typeof type === 'string' ? type : null;
    };

    const notifyTransportStatus = (message: string | null) => {
      setTransportStatusMessage((current) => (current === message ? current : message));
    };

    const seenFallbackSwitches = new Set<string>();
    const notifyFallbackSwitch = (switchEvent: { provider: string; model: string }) => {
      const key = `${switchEvent.provider}:${switchEvent.model}`;
      if (seenFallbackSwitches.has(key)) {
        return;
      }
      seenFallbackSwitches.add(key);
      toast.warning(formatFallbackSwitchToast(switchEvent), 8000);
    };

    // Track cumulative text length so we can stamp each tool activity event
    // with the content offset at which it appeared in the stream.  This
    // offset is persisted and used by MessageBubble to interleave tools
    // with text at the correct positions after hydration from IndexedDB.
    let streamTextOffset = 0;

    const stream = new ReadableStream({
      async pull(controller) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            controller.close();
            return;
          }
          throw e;
        }
        const { done, value } = readResult;
        if (done) {
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;

        // Safety: if buffer grows beyond 1MB without newlines, flush it
        // to prevent memory issues from malformed streams
        if (buffer.length > 1_048_576 && !buffer.includes('\n')) {
          buffer = '';
        }

        // Extract tool_activity from SSE data lines before SDK processes them
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed?.choices?.[0]?.delta;
              if (delta?.tool_activity) {
                updateToolActivity({ ...(delta.tool_activity as ToolActivityEvent), textOffset: streamTextOffset });
              }
              const computerUseFrame = parseComputerUseFrame(delta?.computer_use_frame);
              if (computerUseFrame) {
                setComputerUseDock((current) => reduceComputerUseDockState(current, { frame: computerUseFrame }));
              }
              if (delta?.agent_status && typeof delta.agent_status === 'object') {
                updateAgentStatus(delta.agent_status as AgentStatusEvent);
              }
              const transportStatus = parseHermesTransportStatusDelta(delta?.transport_status);
              if (transportStatus) {
                notifyTransportStatus(formatHermesTransportStatus(transportStatus));
              }
              const fallbackSwitch = parseFallbackSwitchDelta(delta?.fallback_switch);
              if (fallbackSwitch) {
                notifyFallbackSwitch(fallbackSwitch);
              }
              if (delta?.approval_request && typeof delta.approval_request === 'object') {
                const approval = delta.approval_request as AcpApprovalRequest;
                if (typeof approval.approval_id === 'string') {
                  useHermesStore.getState().setPendingAcpApproval(approval);
                }
              }
              if (delta?.server_tool_event && isServerToolEvent(delta.server_tool_event)) {
                applyServerToolEvent(delta.server_tool_event as ServerToolEvent);
              }
              if (isServerToolEvent(parsed)) {
                applyServerToolEvent(parsed);
              }
              // Structured tool-call / retry / plan / usage custom fields.
              const toolCallEvent = delta?.tool_call_begin ?? delta?.tool_call_delta ?? delta?.tool_call_end;
              if (toolCallEvent) {
                handleToolCallEvent(toolCallEvent);
              }
              if (delta?.stream_retry && typeof delta.stream_retry === 'object') {
                handleStreamRetry(delta.stream_retry);
              }
              if (delta?.plan_update && typeof delta.plan_update === 'object') {
                handlePlanUpdate(delta.plan_update);
              }
              if (delta?.usage && typeof delta.usage === 'object') {
                handleUsageEvent(delta.usage);
              }
              // Raw JSON `data:` lines may carry the same custom events directly
              // (no OpenAI choices wrapper) — e.g. the direct SSE proxy path.
              if (parsed && typeof parsed === 'object' && !('choices' in parsed)) {
                const eventType = getCustomEventType(parsed);
                if (eventType === 'tool_call_begin' || eventType === 'tool_call_delta' || eventType === 'tool_call_end') {
                  handleToolCallEvent(parsed);
                } else if (eventType === 'stream_retry') {
                  handleStreamRetry(parsed);
                } else if (eventType === 'plan_update') {
                  handlePlanUpdate(parsed);
                } else if (eventType === 'usage') {
                  handleUsageEvent(parsed);
                }
              }
              // Any stream activity after a retry supersedes the reconnecting
              // indicator (auto-clear). stream_retry chunks themselves must
              // not clear it — they set it.
              if (delta && typeof delta === 'object' && !('stream_retry' in delta)) {
                clearStreamRetry();
              }
            } catch {
              // Not valid JSON, skip
            }
            continue;
          }

          try {
            const parsedPart = parseDataStreamPart(line);

            // Track accumulated text length for tool-position interleaving
            if (parsedPart.type === 'text' && typeof parsedPart.value === 'string') {
              streamTextOffset += parsedPart.value.length;
              // Resumed text output supersedes a reconnecting indicator.
              clearStreamRetry();
            }

            if (
              (parsedPart.type === 'tool_call' || parsedPart.type === 'tool_call_streaming_start') &&
              isServerExecutedRepoToolName(parsedPart.value.toolName)
            ) {
              serverSideToolsDetectedRef.current = true;
            }

            if (parsedPart.type === 'data' && Array.isArray(parsedPart.value)) {
              for (const item of parsedPart.value) {
                if (isHermesToolActivityData(item)) {
                  updateToolActivity({ ...item.activity, textOffset: streamTextOffset });
                  continue;
                }
                if (isComputerUseFrameData(item)) {
                  setComputerUseDock((current) => reduceComputerUseDockState(current, { frame: item.frame }));
                  continue;
                }
                if (isAgentStatusData(item)) {
                  updateAgentStatus(item.status);
                  continue;
                }
                if (isApprovalRequestData(item)) {
                  useHermesStore.getState().setPendingAcpApproval(item);
                  continue;
                }
                if (isFallbackSwitchData(item)) {
                  notifyFallbackSwitch({ provider: item.provider, model: item.model });
                  continue;
                }
                if (isHermesTransportStatusData(item)) {
                  notifyTransportStatus(formatHermesTransportStatus(item));
                  continue;
                }
                if (isHermesLoopStatusData(item)) {
                  useHermesStore.getState().setLoopStatus(panelId, {
                    phase: item.status.phase,
                    iteration: item.status.iteration,
                    stopReason: item.status.stopReason ?? null,
                  });
                  continue;
                }
                if (isServerToolEvent(item)) {
                  applyServerToolEvent(item);
                }
                const customEventType = getCustomEventType(item);
                if (
                  customEventType === 'tool_call_begin' ||
                  customEventType === 'tool_call_delta' ||
                  customEventType === 'tool_call_end'
                ) {
                  handleToolCallEvent(item);
                  continue;
                }
                if (customEventType === 'stream_retry') {
                  handleStreamRetry(item);
                  continue;
                }
                if (customEventType === 'plan_update') {
                  handlePlanUpdate(item);
                  continue;
                }
                if (customEventType === 'usage') {
                  handleUsageEvent(item);
                  continue;
                }
              }
            }
          } catch {
            // Not an AI SDK data-stream line, skip.
          }
        }

        // Pass raw bytes through unmodified for the SDK to process
        controller.enqueue(value);
      },
    });

    return new Response(stream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }, [clearStreamRetryIndicator, panelId, scopeId, getSessionProfile]);

  const ensureRepoFileTreeLoaded = useCallback(async (): Promise<string[]> => {
    const currentChangeset = useChangesetStore.getState().getChangeset(scopeId);
    if (!currentChangeset.isRepoMode || !currentChangeset.activeRepo) {
      return [];
    }

    if (currentChangeset.repoFileTree.length > 0) {
      return currentChangeset.repoFileTree;
    }

    if (!githubPAT) {
      return [];
    }

    useChangesetStore.getState().setRepoFileTreeStatus(scopeId, 'loading');

    const result = await fetchRepoFileTreeResult(
      githubPAT,
      currentChangeset.activeRepo.owner,
      currentChangeset.activeRepo.name,
      currentChangeset.activeRepo.defaultBranch,
    );

    if (result.error) {
      useChangesetStore.getState().setRepoFileTreeStatus(scopeId, 'error', result.error);
      return [];
    }

    useChangesetStore.getState().setRepoFileTree(scopeId, result.paths);
    return result.paths;
  }, [githubPAT, scopeId]);

  const buildRequestBody = useCallback((overrides?: {
    conversationId?: string | null;
    repoFileTree?: string[];
    repoFileCache?: Record<string, string>;
    continuingApprovedProposal?: boolean;
    repoEditIntent?: boolean;
  }) => {
    const currentChangeset = useChangesetStore.getState().getChangeset(scopeId);
    const currentGithubPAT = useSettingsStore.getState().githubPAT;
    const currentActiveRepo = currentChangeset.activeRepo;
    const currentIsRepoMode = currentChangeset.isRepoMode && !!currentActiveRepo;
    const conversationIdForRequest = overrides?.conversationId
      ?? hermesSessionIdOverrideRef.current
      ?? requestConversationIdRef.current;
    const repoFileTreeForRequest = overrides?.repoFileTree ?? currentChangeset.repoFileTree;
    const repoFileCacheForRequest = overrides?.repoFileCache ?? currentChangeset.repoFileCache;
    const repoEditIntentForRequest = typeof overrides?.repoEditIntent === 'boolean'
      ? overrides.repoEditIntent
      : repoEditIntentRef.current;
    const continuingApprovedProposal = overrides?.continuingApprovedProposal === true;

    // Compute effective hermes toolsets from fresh store state to avoid stale memo values mid-stream
    const currentHermesUsesLocalCloneFallback = currentIsRepoMode && !!currentActiveRepo?.localPath && !currentGithubPAT;
    // Auto-use the local checkout when one is attached (hermes-desktop parity):
    // the agent keeps its terminal/files toolsets and works on the checkout via
    // the bridge's worktree isolation instead of being reduced to GitHub-API-only
    // tools with no build ability. No toggle required.
    const currentHermesWorktreeMode = effectiveProvider === 'hermes'
      && currentIsRepoMode
      && !!currentActiveRepo?.localPath;
    const currentEffectiveHermesToolsets = currentIsRepoMode
      && !currentHermesUsesLocalCloneFallback
      && !currentHermesWorktreeMode
      ? hermesToolsets.filter((toolset) => !REPO_MODE_DISABLED_HERMES_TOOLSETS.has(toolset))
      : hermesToolsets;

    return {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      ...(effectiveProvider === 'hermes'
        ? { reasoning_effort: useHermesStore.getState().reasoningEffort }
        : reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      api_key: config.apiKey,
      system_prompt: buildRepoSystemPrompt(
        currentActiveRepo,
        currentIsRepoMode,
        repoEditIntentForRequest,
        !!(currentIsRepoMode && currentActiveRepo && (currentGithubPAT || currentActiveRepo.localPath)),
      ),
      ...(currentIsRepoMode && currentActiveRepo
        ? {
            activeRepo: {
              ...currentActiveRepo,
              default_branch: currentActiveRepo.defaultBranch,
            },
          }
        : {}),
      ...(currentIsRepoMode && currentActiveRepo ? { repo_edit_intent: repoEditIntentForRequest } : {}),
      ...(effectiveProvider === 'hermes' ? { hermes_toolsets: currentEffectiveHermesToolsets.join(',') } : {}),
      ...(effectiveProvider === 'hermes' && hermesSwarmEnabled ? { hermes_swarm_mode: true } : {}),
      ...(effectiveProvider === 'hermes' && !hermesSwarmEnabled && hermesLoopEnabled
        ? {
            hermes_loop_mode: {
              max_iterations: useHermesStore.getState().getLoop(panelId).config.maxIterations,
              time_budget_minutes: useHermesStore.getState().getLoop(panelId).config.timeBudgetMinutes,
            },
          }
        : {}),
      // Only pin a provider when the user explicitly picked one (not Agent default).
      // Agent default / Auto leave routing to the bridge so a CLI custom base_url
      // is used instead of a stale openrouter pin with an empty API key.
      ...(effectiveProvider === 'hermes'
        && !useHermesStore.getState().followAgentModel
        && useHermesStore.getState().underlyingProvider
        ? { hermes_provider: useHermesStore.getState().underlyingProvider }
        : {}),
      // Hermes MCP comes from config.yaml (bridge loads agent MCP natively) — do not dual-inject Spark zustand tools.
      ...(effectiveProvider !== 'hermes' && effectiveProvider !== 'openclaw' && agentToolsets ? { agent_toolsets: agentToolsets } : {}),
      ...(effectiveProvider === 'hermes' && effectiveModel.startsWith('MiniMax-')
        ? { hermes_minimax_key: useSettingsStore.getState().providers.minimax?.apiKey || useSettingsStore.getState().providers['minimax-payg']?.apiKey || '' }
        : {}),
      ...(currentIsRepoMode && currentActiveRepo && currentGithubPAT ? { github_pat: currentGithubPAT } : {}),
      ...(currentIsRepoMode && repoFileTreeForRequest.length > 0 ? { repo_file_tree: repoFileTreeForRequest } : {}),
      ...(currentIsRepoMode && Object.keys(repoFileCacheForRequest).length > 0
        ? { repo_file_cache: repoFileCacheForRequest }
        : {}),
      ...(effectiveProvider === 'hermes' && useHermesStore.getState().useRuns
        ? { hermes_use_runs: true }
        : {}),
      ...(conversationIdForRequest ? { conversation_id: conversationIdForRequest } : {}),
      ...(continuingApprovedProposal ? { continuing_approved_proposal: true } : {}),
      // STEP 7: Pass the active permission mode and output style. `planMode`
      // stays for servers that only understand the legacy boolean.
      ...(useChatStore.getState().planMode ? { planMode: true } : {}),
      permissionMode: useChatStore.getState().permissionMode,
      ...(outputStyle && outputStyle !== 'default' ? { outputStyle } : {}),
    };
  }, [
    agentToolsets,
    buildRepoSystemPrompt,
    config.apiKey,
    config.maxTokens,
    config.temperature,
    config.topP,
    hermesSwarmEnabled,
    hermesLoopEnabled,
    hermesToolsets,
    effectiveModel,
    effectiveProvider,
    reasoningEffort,
    outputStyle,
    scopeId,
    panelId,
  ]);

  const panelCount = usePanelStore((s) => s.panels.length);
  const panelCountThrottle = panelCount <= 2 ? 32 : panelCount <= 4 ? 64 : 96;

  const requestBody = (() => {
    const nextBody = activeRequestBodyRef.current ?? buildRequestBody();
    if (!('continuing_approved_proposal' in nextBody)) {
      return nextBody;
    }
    const { continuing_approved_proposal: _ignoredContinuation, ...rest } = nextBody;
    return rest;
  })();

  const chatTransport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${apiBaseUrl}/functions/v1/chat`,
        fetch: chatStreamFetch,
        body: requestBody,
        prepareSendMessagesRequest: ({ id, messages: requestMessages, body: perRequestBody }: any) => {
          // Hermes strict validation requires a `content` string field on every message
          const normalizedMessages = requestMessages.map((m: any) => ({
            ...m,
            content: m.content ?? getMessageContent(m),
          }));

          return {
            body: {
              id,
              messages: normalizedMessages,
              ...(activeRequestBodyRef.current ?? buildRequestBody()),
              ...(perRequestBody ?? {}),
            },
          };
        },
      }),
    [apiBaseUrl, buildRequestBody, chatStreamFetch, requestBody],
  );

  const {
    messages,
    sendMessage: sdkSendMessage,
    append: sdkAppend,
    status,
    stop: sdkStop,
    regenerate: sdkRegenerate,
    reload: sdkReload,
    setMessages,
    error,
  } = (useAIChat as any)({
    transport: chatTransport,
    api: `${apiBaseUrl}/functions/v1/chat`,
    fetch: chatStreamFetch,
    body: requestBody,
    experimental_prepareRequestBody: ({ id, messages: requestMessages, requestData, requestBody: perRequestBody }: any) => ({
      id,
      messages: requestMessages,
      data: requestData,
      ...(activeRequestBodyRef.current ?? buildRequestBody()),
      ...(perRequestBody ?? {}),
    }),
    id: aiChatSessionId,
    streamProtocol: 'data',
    // Scale the render throttle with panel count so several concurrently
    // streaming sessions stay smooth: each extra panel multiplies per-token
    // render work, so coarser batching keeps total work roughly constant.
    experimental_throttle: panelCountThrottle,
    maxSteps: Infinity,
    onFinish: async (event: any) => {
      const message = event.message;
      const options = event;
      // Use streamConvIdRef (captured at stream start) so mid-stream
      // conversation navigation doesn't redirect persistence to the wrong thread.
      const convId = streamConvIdRef.current ?? convIdRef.current;
      if (!convId) return;
      setAgentStatus(null);
      clearStreamRetryIndicator();
      // The turn is over — any still-parked approval request can no longer be
      // delivered, so drop its banner instead of leaving dead Approve buttons.
      useHermesStore.getState().clearPendingAcpApprovals();

      // Loop mode: the stream is over — release the toggle's transient
      // phase so it doesn't stay stuck on "done"/"stopped" forever. The
      // loop stays enabled; only iteration state resets.
      {
        const loop = useHermesStore.getState().getLoop(panelId);
        if (loop.enabled && (loop.phase === 'agent' || loop.phase === 'judge' || loop.phase === 'done' || loop.phase === 'stopped' || loop.phase === 'error')) {
          useHermesStore.getState().setLoopStatus(panelId, { phase: 'idle', iteration: 0 });
        }
      }

      // Plan gate: when this turn was a plan-mode send and the assistant
      // delivered a plan, park the text for the implementation gate. The live
      // checklist (plan_update events) is separate — this fires once at turn
      // completion, only for the conversation the user is still viewing.
      if (planModeTurnRef.current) {
        planModeTurnRef.current = false;
        const assistantText = typeof message?.content === 'string' ? message.content : '';
        if (
          assistantText.trim().length > 0 &&
          convId === viewedConvIdRef.current &&
          looksLikePlanText(assistantText)
        ) {
          useChatStore.getState().setPlanGatePrompt(assistantText);
        }
      }
      setComputerUseDock(INITIAL_COMPUTER_USE_DOCK_STATE);
      computerUsePermissionsCheckedRef.current = false;

      const currentToolActivity = toolActivityRef.current.current || [];
      const currentServerToolEvents = serverToolEventsRef.current.current || [];
      const hasCurrentFallbackData = currentToolActivity.length > 0 || currentServerToolEvents.length > 0;
      const incomingParts = Array.isArray(message?.parts) ? message.parts as unknown[] : undefined;
      const incomingToolInvocations = Array.isArray(message?.toolInvocations)
        ? message.toolInvocations as unknown[]
        : undefined;
      const synthesizedCurrentToolInvocations = hasCurrentFallbackData
        ? synthesizeToolInvocationsForPersistence(currentToolActivity, currentServerToolEvents)
        : [];
      let finishedMessage = message as unknown as Record<string, unknown> | undefined;
      let finishedMessageId = typeof message?.id === 'string' && message.id ? message.id : null;
      const messageWithTimestamp = message as (AIMessage & { timestamp?: string }) | undefined;
      const finishedTimestamp = typeof messageWithTimestamp?.timestamp === 'string' && messageWithTimestamp.timestamp
        ? messageWithTimestamp.timestamp
        : new Date().toISOString();

      if (
        !finishedMessageId &&
        (
          hasCurrentFallbackData ||
          (typeof message?.content === 'string' && message.content.length > 0) ||
          (incomingParts?.length ?? 0) > 0 ||
          (incomingToolInvocations?.length ?? 0) > 0
        )
      ) {
        finishedMessageId = crypto.randomUUID();
        finishedMessage = {
          id: finishedMessageId,
          role: 'assistant',
          content: typeof message?.content === 'string' ? message.content : '',
          timestamp: finishedTimestamp,
          ...(incomingParts ? { parts: incomingParts } : {}),
          ...(
            incomingToolInvocations && incomingToolInvocations.length > 0
              ? { toolInvocations: incomingToolInvocations }
              : (synthesizedCurrentToolInvocations.length > 0
                  ? { toolInvocations: synthesizedCurrentToolInvocations }
                  : {})
          ),
        };
      }

      // Remap tool activity from 'current' to the actual message ID
      if (finishedMessageId && toolActivityRef.current['current']) {
        const currentActivity = toolActivityRef.current['current'];
        delete toolActivityRef.current['current'];
        toolActivityRef.current[finishedMessageId] = currentActivity;
        setToolActivityMap({ ...toolActivityRef.current });
      }
      // Same remap for the structured tool-call records so enriched cards
      // survive the in-memory conversation switch (persisted snapshots keep
      // the synthesized tool invocations, which degrade gracefully).
      if (finishedMessageId && toolCallRecordsRef.current['current']) {
        const currentRecords = toolCallRecordsRef.current['current'];
        const { current: _droppedCurrent, ...restRecords } = toolCallRecordsRef.current;
        const remapped = { ...restRecords, [finishedMessageId]: currentRecords };
        toolCallRecordsRef.current = remapped;
        setToolCallRecordsState(remapped);
        useHermesStore.getState().setToolCallRecords(panelId, remapped);
      }
      if (finishedMessageId && serverToolEventsRef.current['current']) {
        const currentEvents = serverToolEventsRef.current['current'];
        delete serverToolEventsRef.current['current'];
        serverToolEventsRef.current[finishedMessageId] = currentEvents;
      }
      if (finishedMessageId && serverToolEventKeysRef.current.current) {
        const currentEventKeys = serverToolEventKeysRef.current.current;
        delete serverToolEventKeysRef.current.current;
        serverToolEventKeysRef.current[finishedMessageId] = currentEventKeys;
      }

      const messageToolActivity = finishedMessageId
        ? toolActivityRef.current[finishedMessageId] || []
        : currentToolActivity;
      const messageServerToolEvents = finishedMessageId
        ? serverToolEventsRef.current[finishedMessageId] || []
        : currentServerToolEvents;
      const persistedFinishedMessage = finishedMessage
        ? buildAssistantSnapshotForPersistence({
            message: finishedMessage,
            streamedMessage: finishedMessageId
              ? messagesRef.current.find((entry) => entry.id === finishedMessageId) as unknown as Record<string, unknown> | undefined
              : undefined,
            toolActivity: messageToolActivity,
            serverToolEvents: messageServerToolEvents,
            fallbackId: finishedMessageId ?? undefined,
            fallbackTimestamp: finishedTimestamp,
          })
        : undefined;
      const finishedMessageParts = Array.isArray(finishedMessage?.parts) ? finishedMessage.parts as unknown[] : undefined;
      const finishedMessageToolInvocations = Array.isArray(finishedMessage?.toolInvocations)
        ? finishedMessage.toolInvocations as unknown[]
        : undefined;
      const shouldInjectFinishedMessage =
        !!finishedMessageId &&
        !messagesRef.current.some((entry) => entry.id === finishedMessageId) &&
        (
          (typeof finishedMessage?.content === 'string' && finishedMessage.content.length > 0) ||
          (finishedMessageParts?.length ?? 0) > 0 ||
          (finishedMessageToolInvocations?.length ?? 0) > 0 ||
          messageToolActivity.length > 0 ||
          messageServerToolEvents.length > 0
        );

      if (shouldInjectFinishedMessage && (persistedFinishedMessage || finishedMessage)) {
        const injectedMessage = (persistedFinishedMessage ?? finishedMessage) as Record<string, unknown>;
        const injectedParts = Array.isArray(injectedMessage.parts) ? injectedMessage.parts as unknown[] : undefined;
        const injectedToolInvocations = Array.isArray(injectedMessage.toolInvocations)
          ? injectedMessage.toolInvocations as unknown[]
          : undefined;
        const nextMessages = [
          ...messagesRef.current,
          {
            id: finishedMessageId,
            role: (typeof injectedMessage.role === 'string' ? injectedMessage.role : 'assistant') as AIMessage['role'],
            content: typeof injectedMessage.content === 'string' ? injectedMessage.content : '',
            ...(typeof injectedMessage.timestamp === 'string' ? { timestamp: injectedMessage.timestamp } : {}),
            ...(injectedParts ? { parts: injectedParts } : {}),
            ...(injectedToolInvocations ? { toolInvocations: injectedToolInvocations } : {}),
          } as AIMessage,
        ];
        // Only update the message buffers if the user is still viewing
        // the conversation that this stream belongs to. If they navigated away,
        // persistAssistantSnapshot already saved the message to the correct
        // conversation in IndexedDB. Writing here would clobber the currently
        // visible conversation's buffer with a different thread's response.
        //
        // Check viewedConvIdRef in addition to convIdRef: during a mid-stream
        // conversation switch, the abort branch intentionally leaves
        // convIdRef pointing at the aborting conversation (to keep tool
        // events routed correctly), which would let this guard pass. The
        // viewedConvIdRef always mirrors the current conversationId prop so
        // it catches the case where the user has already navigated away.
        if (convId === convIdRef.current && convId === viewedConvIdRef.current) {
          messagesRef.current = nextMessages;
          setMessages(nextMessages);
        }
      }

      // Persist assistant message (including parts and tool invocations)
      if (!finishedMessage && !persistedFinishedMessage) return;
      await persistAssistantSnapshot((persistedFinishedMessage ?? finishedMessage) as Record<string, unknown>, convId, {
        toolActivity: messageToolActivity,
        serverToolEvents: messageServerToolEvents,
      });

      // If the user explicitly clicked stop, skip all auto-continue logic.
      // Reset counters so the next user-initiated send starts fresh.
      if (userStoppedRef.current) {
        userStoppedRef.current = false;
        unknownFinishRetryRef.current = 0;
        repoStopRetryRef.current = 0;
        activeRequestBodyRef.current = null;
        approvedProposalContinuationRef.current = null;
        return;
      }

      const finishReason = options?.finishReason;
      const repoWorkflowNames = collectRepoWorkflowToolNames(
        finishedMessage! as {
          content?: string;
          parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
          toolInvocations?: Array<{ toolName?: string }>;
        },
        messageToolActivity,
        messageServerToolEvents,
      );
      const latestUserApproval = isRepoApprovalFollowUpMessage(
        messagesRef.current.findLast((entry) => entry.role === 'user') ? getMessageContent(messagesRef.current.findLast((entry) => entry.role === 'user')) : '',
      );
      const approvedPlanMentioned = /\b(?:approved|accepted)\s+plan\b/i.test(
        getMessageContent(finishedMessage),
      );
      const inferredApprovedContinuation =
        pendingProposalRef.current !== null &&
        (
          latestUserApproval ||
          repoWorkflowNames.some((toolName) => REPO_EDIT_TOOL_NAMES.has(toolName)) ||
          approvedPlanMentioned
        );
      const continuingApprovedProposal =
        approvedProposalContinuationRef.current !== null || inferredApprovedContinuation;
      if (continuingApprovedProposal && approvedProposalContinuationRef.current === null) {
        approvedProposalContinuationRef.current = {
          conversationId: convId,
          proposalKey: getPendingProposalKey(pendingProposalRef.current),
        };
      }
      // Detect partial/incomplete tool calls left by a dropped stream (common
      // with Minimax and other providers that may terminate mid-tool-call).
      const hasPartialToolCalls = (finishedMessage!.parts as Array<{ type?: string; toolInvocation?: { state?: string } }> | undefined)?.some(
        (p) => p.type === 'tool-invocation' && (p.toolInvocation?.state === 'partial-call' || p.toolInvocation?.state === 'call'),
      ) || (finishedMessage!.toolInvocations as Array<{ state?: string }> | undefined)?.some(
        (inv) => inv.state === 'partial-call' || inv.state === 'call',
      );

      if (finishReason !== 'tool-calls') {
        if (
          // Auto-continue when tool calls were interrupted mid-stream. The
          // sanitizePartialToolCalls helper will patch them with error results
          // before re-sending, so the model sees the failure and can retry.
          hasPartialToolCalls &&
          activeRepo &&
          unknownFinishRetryRef.current < MAX_UNKNOWN_FINISH_RETRIES
        ) {
          unknownFinishRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'Your tool call was interrupted mid-execution. Continue the accepted plan — retry the tool call and complete the remaining work.'
              : repoEditIntentRef.current
                ? 'Your tool call was interrupted mid-execution. Retry the tool call and continue where you left off.'
                : 'Your tool call was interrupted mid-execution. Retry the tool call and continue your analysis.',
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          // Auto-continue when the model is interrupted mid-work with an unknown
          // finish reason (common with OpenRouter/Gemini hitting token limits or
          // returning non-standard finish reasons). Recover when the turn was
          // actively doing repo work, including read-only analysis with
          // server-side repo reads, and cap retries to avoid loops.
          (finishReason === 'other' || finishReason === 'length') &&
          activeRepo &&
          (
            repoEditIntentRef.current ||
            continuingApprovedProposal ||
            repoWorkflowNames.length > 0 ||
            stalledOnRepoRead(
              finishedMessage as {
                content?: string;
                parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
                toolInvocations?: Array<{ toolName?: string }>;
              },
              messageToolActivity,
              messageServerToolEvents,
            )
          ) &&
          unknownFinishRetryRef.current < MAX_UNKNOWN_FINISH_RETRIES
        ) {
          unknownFinishRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'You were interrupted in the middle of the accepted repo plan. Continue the accepted plan now and complete the remaining file changes.'
              : repoEditIntentRef.current
                ? 'You were interrupted mid-work. Continue where you left off — complete the remaining file changes.'
                : "You were interrupted in the middle of a read-only repo analysis. Continue inspecting the repo as needed and answer the user's question directly.",
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          finishReason === 'stop' &&
          activeRepo &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          stalledOnRepoRead(
            finishedMessage as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
            messageServerToolEvents,
          )
        ) {
          repoStopRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'Continue the accepted plan now. You stopped after reading a file but the approved repo work is not finished yet. Keep using repo tools until the accepted changes are complete.'
              : repoEditIntentRef.current
                ? 'You stopped in the middle of repo work after reading a file. Continue making the requested changes. Do not stop after a single read_repo_file result.'
                : "You stopped in the middle of a read-only repo analysis after reading a file. Continue inspecting the repo as needed and answer the user's question directly.",
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          finishReason === 'stop' &&
          activeRepo &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          describedEditButDidNotExecute(
            message as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
            messageServerToolEvents,
            repoEditIntentRef.current,
          )
        ) {
          repoStopRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: continuingApprovedProposal
              ? 'Continue the accepted plan now. You described the approved changes but did not execute any repo tools. Do not narrate the plan again. Call read_repo_file or the repo edit tools directly.'
              : 'You described changes but did not apply them. Do not describe what you will do — actually call the edit tools now. Use batch_edit_repo_files or edit_repo_file to make the changes directly.',
            continuingApprovedProposal,
            forceRepoEditIntent: continuingApprovedProposal || repoEditIntentRef.current,
          });
        } else if (
          finishReason === 'stop' &&
          continuingApprovedProposal &&
          activeRepo &&
          repoStopRetryRef.current < MAX_REPO_STOP_RETRIES &&
          repoWorkflowNames.length === 0
        ) {
          repoStopRetryRef.current += 1;
          scheduleAutoContinue({
            conversationId: convId,
            content: 'Continue the accepted plan now. You did not execute any repo tools in the last step. Use read_repo_file for more context or call the repo edit tools directly.',
            continuingApprovedProposal: true,
            forceRepoEditIntent: true,
          });
        } else {
          // Natural finish — reset retry counters
          unknownFinishRetryRef.current = 0;
          repoStopRetryRef.current = 0;
          activeRequestBodyRef.current = null;
          approvedProposalContinuationRef.current = null;
          pendingProposalRef.current = null;
          explicitProposalKeyRef.current = null;
          // PR readiness is handled by the auto-PR useEffect that watches
          // the isStreaming transition — don't signal here since the stream
          // may not be fully consumed yet.
        }
      } else {
        // Tool-calls finish — let the AI SDK continue the conversation
        activeRequestBodyRef.current = null;
      }
    },
    onToolCall: async ({ toolCall }: any) => {
      // Use the scope captured at stream start so late tool callbacks from an
      // aborted stream don't write into the new conversation's scope.
      const toolScopeId = streamScopeIdRef.current ?? scopeId;

      // When server-side tool execution is active, repo tools are handled
      // server-side — return a no-op result to avoid duplicate execution.
      if (serverSideToolsDetectedRef.current && SERVER_EXECUTED_REPO_TOOLS.has(toolCall.toolName)) {
        return `Handled server-side`;
      }

      if (toolCall.toolName === 'propose_changes') {
        if (approvedProposalContinuationRef.current) {
          return 'This proposal was already approved. Continue directly with read_repo_file or the repo edit tools now.';
        }
        const normalizedArgs = normalizeProposeChangesArgs((toolCall as any).args, {
          existingPaths: getRepoToolExistingPaths(toolScopeId),
        }) as { summary?: unknown; plan?: unknown };
        pendingProposalRef.current = {
          messageId: '',
          summary: typeof normalizedArgs.summary === 'string' ? normalizedArgs.summary : null,
          excerpt: null,
          plan: Array.isArray(normalizedArgs.plan)
            ? normalizedArgs.plan
                .filter((item): item is { path: string; action: string; description: string } =>
                  !!item &&
                  typeof item === 'object' &&
                  typeof (item as { path?: unknown }).path === 'string' &&
                  typeof (item as { action?: unknown }).action === 'string' &&
                  typeof (item as { description?: unknown }).description === 'string',
                )
                .map((item) => ({
                  path: item.path,
                  action: item.action,
                  description: item.description,
                }))
            : [],
        };
        explicitProposalKeyRef.current = getPendingProposalKey(pendingProposalRef.current);
        return 'Proposal ready for review. Pause for approval before editing repo files.';
      }

      // Handle file creation tools (artifacts/preview)
      const FILE_TYPE_MAP: Record<string, FileType> = {
        create_html_file: 'html',
        create_css_file: 'css',
        create_js_file: 'js',
        create_react_component: 'jsx',
        create_markdown_file: 'md',
      };

      const fileType = FILE_TYPE_MAP[toolCall.toolName];
      if (fileType) {
        const { filename, content } = (toolCall as any).args as { filename: string; content: string };
        const previewStore = usePreviewStore.getState();
        const previewState = previewStore.getPreview(toolScopeId);
        // Check if file already exists (update it) or add new
        const existing = previewState.files.find((f) => f.filename === filename);
        if (existing) {
          previewStore.updateFile(toolScopeId, existing.id, content);
        } else {
          previewStore.addFile(toolScopeId, { filename, content, type: fileType });
        }
        return JSON.stringify({ success: true, filename, message: `Created ${filename}` });
      }

      // Handle repo tool calls
      if (toolCall.toolName === 'read_repo_file') {
        const { path } = (toolCall as any).args as { path: string };
        const normalizedPath = normalizeRepoPath(path);
        const currentRepo = useChangesetStore.getState().getChangeset(toolScopeId).activeRepo;
        if (!currentRepo || !githubPAT) {
          return 'Error: No active repository or GitHub token not configured.';
        }

        if (isInvalidRepoReadPath(normalizedPath)) {
          return 'Error: Choose a concrete file path from the loaded repository tree, not `.` , `/`, or a directory path.';
        }

        const currentChangeset = useChangesetStore.getState().getChangeset(toolScopeId);
        const repoTree = currentChangeset.repoFileTree.length > 0
          ? currentChangeset.repoFileTree
          : await ensureRepoFileTreeLoaded();

        const repoTreeStatus = useChangesetStore.getState().getChangeset(toolScopeId).repoFileTreeStatus;
        const repoTreeError = useChangesetStore.getState().getChangeset(toolScopeId).repoFileTreeError;

        if (repoTree.length === 0) {
          return formatRepoTreeUnavailableError(repoTreeStatus, repoTreeError);
        }

        if (!repoTree.includes(normalizedPath)) {
          return formatMissingRepoFileError(normalizedPath, repoTree);
        }

        // Return cached content if available (avoids redundant GitHub API calls)
        const cached = useChangesetStore.getState().getChangeset(toolScopeId).repoFileCache[normalizedPath];
        if (cached !== undefined) {
          return cached;
        }

        try {
          const response = await fetch(
            `${getApiBaseUrl()}/functions/v1/github-integration`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'read-file',
                pat: githubPAT,
                owner: currentRepo.owner,
                repo: currentRepo.name,
                path: normalizedPath,
                ref: currentRepo.defaultBranch,
              }),
            }
          );
          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return `Error reading file: server returned ${response.status}${errText ? ` — ${errText.slice(0, 200)}` : ''}`;
          }
          const data = await response.json();
          if (data.error) return `Error reading file: ${data.error}`;
          useChangesetStore.getState().cacheRepoFile(toolScopeId, normalizedPath, data.content || '');
          return data.content || '';
        } catch {
          return 'Error: Failed to read file from GitHub.';
        }
      }

      if (toolCall.toolName === 'edit_repo_file') {
        const normalizedArgs = normalizeEditRepoFileArgs((toolCall as any).args) as {
          path?: unknown;
          content?: unknown;
        };
        const path = typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '';
        const content = typeof normalizedArgs.content === 'string' ? normalizedArgs.content : '';
        if (!path) {
          return 'Error: edit_repo_file is missing a valid path.';
        }
        const existingPaths = getRepoToolExistingPaths(toolScopeId);
        const approvedPlanAllowsEdit =
          approvedProposalContinuationRef.current !== null &&
          (pendingProposalRef.current?.plan ?? []).some((item) => item.action === 'edit' && item.path === path);
        if (!existingPaths.has(path) && !approvedPlanAllowsEdit) {
          return `Error: edit_repo_file can only modify existing repo files. \`${path}\` is not in the indexed repo tree or staged changes. Use create_repo_file only for genuinely new paths.`;
        }
        const existing = useChangesetStore.getState().getChangeset(toolScopeId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(toolScopeId).repoFileCache[path] ?? '';
        addChangeForPanel(toolScopeId, { path, action: 'edit', content, originalContent, staged: true });
        return `Staged edit to ${path}`;
      }

      if (toolCall.toolName === 'create_repo_file') {
        const normalizedArgs = normalizeCreateRepoFileArgs((toolCall as any).args) as {
          path?: unknown;
          content?: unknown;
        };
        const path = typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '';
        const content = typeof normalizedArgs.content === 'string' ? normalizedArgs.content : '';
        if (!path) {
          return 'Error: create_repo_file is missing a valid path.';
        }
        const existingPaths = getRepoToolExistingPaths(toolScopeId);
        const action = resolveRepoWriteAction('create', path, existingPaths);
        const existing = useChangesetStore.getState().getChangeset(toolScopeId).changes[path];
        const originalContent = action === 'edit'
          ? existing?.originalContent ?? useChangesetStore.getState().getChangeset(toolScopeId).repoFileCache[path] ?? ''
          : '';
        addChangeForPanel(toolScopeId, { path, action, content, originalContent, staged: true });
        return action === 'edit' ? `Staged edit to ${path}` : `Staged new file ${path}`;
      }

      if (toolCall.toolName === 'delete_repo_file') {
        const normalizedArgs = normalizeDeleteRepoFileArgs((toolCall as any).args) as { path?: unknown };
        const path = typeof normalizedArgs.path === 'string' ? normalizedArgs.path : '';
        if (!path) {
          return 'Error: delete_repo_file is missing a valid path.';
        }
        const existingPaths = getRepoToolExistingPaths(toolScopeId);
        if (!existingPaths.has(path)) {
          return `Error: delete_repo_file can only delete existing repo files. \`${path}\` is not in the indexed repo tree or staged changes.`;
        }
        const existing = useChangesetStore.getState().getChangeset(toolScopeId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(toolScopeId).repoFileCache[path] ?? '';
        addChangeForPanel(toolScopeId, { path, action: 'delete', content: '', originalContent, staged: true });
        return `Staged deletion of ${path}`;
      }

      if (toolCall.toolName === 'batch_edit_repo_files') {
        const normalizedArgs = normalizeBatchEditRepoFilesArgs((toolCall as any).args, {
          existingPaths: getRepoToolExistingPaths(toolScopeId),
        }) as { changes?: unknown };
        const fileChanges = Array.isArray(normalizedArgs.changes)
          ? normalizedArgs.changes as Array<{ path: string; action: 'create' | 'edit' | 'delete'; content: string; description: string }>
          : [];
        const knownPaths = getRepoToolExistingPaths(toolScopeId);
        const approvedPlanEditPaths = new Set(
          approvedProposalContinuationRef.current !== null
            ? (pendingProposalRef.current?.plan ?? [])
                .filter((item) => item.action === 'edit')
                .map((item) => item.path)
            : [],
        );
        const results: string[] = [];
        for (const change of fileChanges) {
          if (!change?.path || (change.action !== 'create' && change.action !== 'edit' && change.action !== 'delete')) {
            continue;
          }
          const action = resolveRepoWriteAction(change.action, change.path, knownPaths);
          if (action === 'edit' && !knownPaths.has(change.path) && !approvedPlanEditPaths.has(change.path)) {
            return `Error: batch_edit_repo_files cannot edit missing file \`${change.path}\`. Use create only for genuinely new files and edit only for paths already in the repo.`;
          }
          if (action === 'delete' && !knownPaths.has(change.path)) {
            return `Error: batch_edit_repo_files cannot delete missing file \`${change.path}\`. Use delete only for paths already present in the repo or staged changes.`;
          }
          const existing = useChangesetStore.getState().getChangeset(toolScopeId).changes[change.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(toolScopeId).repoFileCache[change.path] ?? '';
          addChangeForPanel(toolScopeId, {
            path: change.path,
            action,
            content: change.content || '',
            originalContent,
            staged: true,
          });
          if (action === 'delete') {
            knownPaths.delete(change.path);
          } else {
            knownPaths.add(change.path);
          }
          results.push(`Staged ${action} on ${change.path}`);
        }
        return results.join('\n');
      }
    },
    onError: (err: any) => {
      activeRequestBodyRef.current = null;
      pendingProposalRef.current = null;
      explicitProposalKeyRef.current = null;
      approvedProposalContinuationRef.current = null;
      delete toolActivityRef.current.current;
      delete serverToolEventsRef.current.current;
      delete serverToolEventKeysRef.current.current;
      clearStreamRetryIndicator();
      setAgentStatus(null);
      // Dead stream: parked approval requests can no longer be resolved.
      useHermesStore.getState().clearPendingAcpApprovals();
      // Loop mode: a failed stream must release the phase too, or the toggle
      // stays stuck mid-loop with no way to tell it's dead.
      {
        const loop = useHermesStore.getState().getLoop(panelId);
        if (loop.enabled && loop.phase !== 'idle') {
          useHermesStore.getState().setLoopStatus(panelId, { phase: 'idle', iteration: 0 });
        }
      }
      const errorMessage = getErrorMessage(err);
      console.error('[useChat] onError Chat error:', errorMessage, 'provider:', effectiveProvider, 'model:', effectiveModel);
      if (errorMessage.includes('not configured')) {
        setProviderUnavailableOpen(true);
      }
      // Handle truncated tool call JSON (model output exceeded token limit)
      if (errorMessage.includes('JSON parsing failed') || errorMessage.includes('Unexpected end of JSON')) {
        console.warn('Tool call was truncated — the model likely exceeded its output token limit. The response will be retried with a prompt to use smaller changes.');
      }
    },
  });

  const append = sdkAppend ?? sdkSendMessage;
  const reload = sdkReload ?? sdkRegenerate;

  // Wrap SDK stop to also abort the in-flight fetch
  const stop = useCallback(() => {
    userStoppedRef.current = true;
    // Stopping strands any parked approval request for this run.
    useHermesStore.getState().clearPendingAcpApprovals();
    // Cancel any pending auto-continue so it doesn't fire after stop
    if (autoContinueTimerRef.current) {
      clearTimeout(autoContinueTimerRef.current);
      autoContinueTimerRef.current = null;
    }
    // Hermes runs survive client disconnects (background continuation), so an
    // explicit Stop must also cancel the run server-side — aborting the fetch
    // alone would leave the agent running.
    const convId = streamConvIdRef.current ?? convIdRef.current;
    if (convId) {
      void fetch(`${getApiBaseUrl()}/api/hermes/chat/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId }),
      }).catch(() => { /* best-effort */ });
      // Stopping a detached background run: drop the polled flag right away
      // so the UI doesn't keep showing it as running until the next poll.
      useActivityStore.getState().clearBackgroundRun(convId);
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    // The in-flight send is over — clear the guard synchronously so a deferred
    // send queued right after stop (e.g. steering a queued message) isn't
    // blocked by the duplicate-send guard and left lingering in the tray.
    isSendingRef.current = false;
    sdkStop();
  }, [sdkStop]);

  // Keep messagesRef in sync for use in callbacks without adding messages to deps
  messagesRef.current = messages;

  // Wrapper that prevents overwriting the AI SDK streaming buffer unless forced
  const safeSetMessages = useCallback((msgs: AIMessage[], force = false) => {
    if (!force && isStreamingRef.current) return;
    setMessages(msgs);
  }, [setMessages]);

  const scheduleAutoContinue = useCallback((request: AutoContinueRequest) => {
    const currentMessages = messagesRef.current;
    const sanitized = sanitizeRetryMessages(currentMessages);
    if (sanitized !== currentMessages) {
      safeSetMessages(sanitized, true);
    }

    if (autoContinueTimerRef.current) {
      clearTimeout(autoContinueTimerRef.current);
    }

    autoContinueTimerRef.current = setTimeout(() => {
      autoContinueTimerRef.current = null;
      serverSideToolsDetectedRef.current = false;
      activeRequestBodyRef.current = buildRequestBody({
        conversationId: request.conversationId,
        continuingApprovedProposal: request.continuingApprovedProposal,
        repoEditIntent: request.forceRepoEditIntent,
      });
      append(
        {
          role: 'system',
          parts: [{ type: 'text', text: request.content }] as any,
        },
        {
          body: {
            conversation_id: request.conversationId,
            ...(isRepoMode && activeRepo ? {
              repo_edit_intent: typeof request.forceRepoEditIntent === 'boolean'
                ? request.forceRepoEditIntent
                : repoEditIntentRef.current,
            } : {}),
            ...(request.continuingApprovedProposal ? { continuing_approved_proposal: true } : {}),
          },
        },
      ).catch((err: any) => {
        console.error('[useChat] autoContinue Failed to auto-continue:', err);
        activeRequestBodyRef.current = null;
      });
    }, AUTO_CONTINUE_DELAY_MS);
  }, [activeRepo, append, buildRequestBody, isRepoMode, safeSetMessages, sanitizeRetryMessages]);

  // Track streaming state in global activity store
  const isStreaming = status === 'streaming' || status === 'submitted';
  isStreamingRef.current = isStreaming;

  // ── Auto-compaction ────────────────────────────────────────────────────────
  // When the context window fills up, summarize the conversation and replace the
  // working history with the summary so the next turn has room again. Only ever
  // fires while idle: compacting mid-stream would clobber the streaming buffer
  // and the turn in flight.
  const liveUsage = useContextUsageStore((s) => s.usage);
  const autoCompact = useSettingsStore((s) => s.autoCompact);
  const autoCompactThreshold = useSettingsStore((s) => s.autoCompactThreshold);
  const compactionInFlightRef = useRef(false);

  useEffect(() => {
    if (!autoCompact || !liveUsage) return;
    if (compactionInFlightRef.current || isStreaming) return;

    const decision = evaluateCompaction({
      used: liveUsage.inputTokens + liveUsage.outputTokens,
      total: liveUsage.contextWindow,
      threshold: autoCompactThreshold,
      enabled: autoCompact,
    });
    if (!decision.shouldCompact) return;

    const sourceMessages: AIMessage[] = Array.isArray(messages) ? (messages as AIMessage[]) : [];
    const history = sourceMessages
      .map((m) => ({ role: m.role, content: getMessageContent(m) }))
      .filter((m) => m.content.trim().length > 0);
    // Nothing worth summarizing — a single message has no history to compress.
    if (history.length < 2) return;

    compactionInFlightRef.current = true;
    void (async () => {
      try {
        const result = await requestCompaction({
          provider: effectiveProvider,
          model: effectiveModel,
          apiKey: config.apiKey,
          messages: history,
          threshold: autoCompactThreshold,
        });
        safeSetMessages(
          [
            {
              id: `compaction-${Date.now()}`,
              role: 'user',
              content: buildCompactionSummaryMessage(result.summary).content,
            },
          ] as unknown as AIMessage[],
          true,
        );
        // The stored usage describes the pre-compaction history, so drop it —
        // otherwise this effect would fire again on the same numbers. The next
        // turn reports fresh usage for the compacted history.
        useContextUsageStore.getState().setUsage(null);
      } catch (err) {
        // Never break the conversation because a summary failed; the history is
        // left untouched and the user can keep going.
        console.error('[useChat] auto-compaction failed:', err);
      } finally {
        compactionInFlightRef.current = false;
      }
    })();
  }, [
    autoCompact,
    autoCompactThreshold,
    liveUsage,
    isStreaming,
    messages,
    effectiveProvider,
    effectiveModel,
    config.apiKey,
    safeSetMessages,
  ]);

  // A hermes run for this conversation that is still active server-side but
  // not streamed by this panel (the originating panel/window was closed).
  // The panel treats it like a live stream: running indicator, Stop enabled,
  // and the in-flight output polled in below.
  const hasBackgroundRun = useActivityStore((s) =>
    conversationId ? !!s.backgroundRuns[conversationId] : false,
  );
  const isBackgroundRunActive = hasBackgroundRun && !isStreaming;

  // Poll the in-flight output of a detached background run and mirror it into
  // the message buffer as a synthetic assistant message so the user sees the
  // run progressing. On completion the run's persisted message replaces it
  // via the hermes-background-run-finished re-hydration below.
  useEffect(() => {
    if (!isBackgroundRunActive || !conversationId) return;
    let cancelled = false;

    const syntheticId = `background-run-${conversationId}`;
    const pollPartial = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/hermes/chat/active/${conversationId}`);
        if (!response.ok || cancelled) return;
        const payload = await response.json() as { active?: boolean; text?: string };
        if (cancelled || !payload.active || !payload.text) return;
        if (convIdRef.current !== conversationId || isStreamingRef.current) return;
        const current = messagesRef.current;
        const existingIdx = current.findIndex((m) => m.id === syntheticId);
        const synthetic = {
          id: syntheticId,
          role: 'assistant' as const,
          parts: [{ type: 'text', text: payload.text }] as any,
        } as AIMessage;
        const next = existingIdx >= 0
          ? current.map((m, i) => (i === existingIdx ? synthetic : m))
          : [...current, synthetic];
        safeSetMessages(next);
      } catch {
        // Server unreachable — retry on the next tick.
      }
    };

    void pollPartial();
    const timer = setInterval(() => { void pollPartial(); }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isBackgroundRunActive, conversationId, safeSetMessages]);

  // Release the draft→conv session lock once the stream settles. Keeping the
  // lock past stream end would strand the next user turn on the draft bucket.
  // Only clear on streaming true→false transition — the lock may be set
  // synchronously in sendMessage *before* status flips to 'streaming', so
  // clearing on plain !isStreaming would tear the lock down immediately.
  const streamingForLockRef = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      streamingForLockRef.current = true;
    } else if (streamingForLockRef.current && sessionLock !== null) {
      streamingForLockRef.current = false;
      setSessionLock(null);
    }
  }, [isStreaming, sessionLock]);

  // Serialize Hermes streams per-profile across panels. With per-session
  // profiles, distinct sessions never contend; this lock only prevents the
  // legacy case where two panels happen to resolve to the same profile (e.g.
  // two 'default' panels or the profiles UI pointing multiple panels at the
  // same name). Different profiles stream fully in parallel.
  const globalActiveProfile = useProfilesStore((s) => s.activeProfile) || 'default';
  const panelBoundProfile = usePanelStore((s) => s.panels.find((p) => p.id === panelId)?.profile);
  const sessionProfile = panelId === 'default'
    ? globalActiveProfile
    : (panelBoundProfile || globalActiveProfile);
  const profileLockHolder = useStreamLockStore((s) => s.locks[sessionProfile]);
  const isAnotherPanelStreamingSameProfile =
    effectiveProvider === 'hermes' && !!profileLockHolder && profileLockHolder !== panelId;
  const effectiveBusy = isStreaming || isAnotherPanelStreamingSameProfile;

  useEffect(() => {
    if (effectiveProvider !== 'hermes') return;
    if (!isStreaming) return;
    // Capture the profile at stream start. If the user switches the active
    // profile mid-stream (only possible for the 'default' panel), the backend
    // keeps streaming against the original profile — so acquire and release
    // must use the same value. Closure capture here.
    const profile = sessionProfile;
    useStreamLockStore.getState().acquire(profile, panelId);
    return () => {
      useStreamLockStore.getState().release(profile, panelId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lock stays bound to profile captured at stream start
  }, [effectiveProvider, isStreaming, panelId]);

  useEffect(() => {
    useChatQueueStore.getState().setPanelQueue({
      panelId,
      conversationId,
      profile: sessionProfile,
      isStreaming,
      waitingForOtherPanel: isAnotherPanelStreamingSameProfile,
      messages: queuedMessages,
    });
  }, [
    conversationId,
    isAnotherPanelStreamingSameProfile,
    isStreaming,
    panelId,
    queuedMessages,
    sessionProfile,
  ]);

  useEffect(() => {
    return () => {
      useChatQueueStore.getState().clearPanelQueue(panelId);
    };
  }, [panelId]);

  useLayoutEffect(() => {
    // Track which conversation owns the active stream. Set on false→true and
    // cleared when streaming ends; intentionally not updated on mid-stream
    // navigation so it still identifies the stream's original conversation.
    if (!isStreaming) {
      streamConvIdRef.current = null;
      streamScopeIdRef.current = null;
    } else if (streamConvIdRef.current === null) {
      // Use convIdRef (already set by sendMessage before append()) or
      // pendingConversationIdRef, because the conversationId prop lags
      // behind for new conversations (onConversationCreated fires after
      // the stream resolves).
      streamConvIdRef.current = convIdRef.current ?? pendingConversationIdRef.current ?? conversationId;
      streamScopeIdRef.current = scopeId;
    }
    // Session ID sync removed: aiChatSessionId is now derived via useMemo from
    // chatSessionId, so it's always in sync. No async state lag possible.
  }, [isStreaming, conversationId, scopeId]);
  useEffect(() => {
    const pendingProposal = findPendingProposal(messages as Array<{
      id: string;
      role: string;
      content?: string;
      parts?: Array<{ type?: string; text?: string; reasoning?: string; toolInvocation?: { toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown } }>;
      toolInvocations?: Array<{ toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown }>;
    }>);
    const proposalKey = getPendingProposalKey(pendingProposal);
    const isExplicitProposal = !!proposalKey && explicitProposalKeyRef.current === proposalKey;

    pendingProposalRef.current = pendingProposal ?? pendingProposalRef.current;

    if (!isStreaming || !pendingProposal || autoApproveRepoChanges || conversationAutoApproveEnabled || approvedProposalContinuationRef.current) {
      if (!pendingProposal) {
        pausedProposalKeyRef.current = null;
        contentProposalStabilityRef.current = { key: null, cycles: 0 };
      }
      return;
    }

    if (!isExplicitProposal) {
      const stability = contentProposalStabilityRef.current;
      if (stability.key === proposalKey) {
        stability.cycles += 1;
      } else {
        contentProposalStabilityRef.current = { key: proposalKey, cycles: 1 };
      }

      if (contentProposalStabilityRef.current.cycles < 3) {
        return;
      }
    } else {
      contentProposalStabilityRef.current = { key: proposalKey, cycles: 0 };
    }

    if (!proposalKey || pausedProposalKeyRef.current === proposalKey) {
      return;
    }

    pausedProposalKeyRef.current = proposalKey;
    stop();

    const proposalMessage = messages.find((message: any) => message.id === pendingProposal.messageId);
    const persistedConversationId = convIdRef.current ?? pendingConversationIdRef.current;
    if (proposalMessage && persistedConversationId) {
      void persistAssistantSnapshot(proposalMessage as unknown as Record<string, unknown>, persistedConversationId, {
        toolActivity: proposalMessage.id ? toolActivityRef.current[proposalMessage.id] || [] : [],
        serverToolEvents: proposalMessage.id ? serverToolEventsRef.current[proposalMessage.id] || [] : [],
      });
    }

    if (!conversationId && pendingConversationIdRef.current) {
      skipNextLoadRef.current = true;
      onConversationCreated?.(pendingConversationIdRef.current);
    }
  }, [
    autoApproveRepoChanges,
    conversationAutoApproveEnabled,
    conversationId,
    isStreaming,
    messages,
    onConversationCreated,
    persistAssistantSnapshot,
    stop,
  ]);
  useEffect(() => {
    if (isStreaming || !activeRepo) return;

    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (appliedPseudoRepoMessageIdsRef.current.has(message.id)) continue;

      const messageToolActivity = message.id ? toolActivityRef.current[message.id] || [] : [];
      const messageServerToolEvents = message.id ? serverToolEventsRef.current[message.id] || [] : [];
      const executedRepoWrites = collectRepoWorkflowToolNames(
        message as {
          content?: string;
          parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
          toolInvocations?: Array<{ toolName?: string }>;
        },
        messageToolActivity,
        messageServerToolEvents,
      ).some((toolName) => REPO_EDIT_TOOL_NAMES.has(toolName));

      if (executedRepoWrites) continue;

      const sourceText = getPseudoToolSourceText(message as {
        content?: string;
        parts?: Array<{ type?: string; text?: string }>;
      });
      const messageIndex = messages.findIndex((entry: any) => entry.id === message.id);
      const previousUserMessage = messageIndex > 0
        ? messages.slice(0, messageIndex).findLast((entry: any) =>
            entry.role === 'user' && getMessageContent(entry).trim().length > 0,
          )
        : undefined;
      const allowPseudoRepoWrites = (previousUserMessage
        ? isRepoWriteMessage(getMessageContent(previousUserMessage))
        : false) || repoEditIntentRef.current;
      const pseudoInvocations = extractPseudoToolInvocations(sourceText);
      const repoEditInvocation = allowPseudoRepoWrites
        ? pseudoInvocations.find((invocation) =>
            ['batch_edit_repo_files', 'edit_repo_file', 'create_repo_file', 'delete_repo_file', 'write_to_file', 'replace_file_content'].includes(invocation.toolName),
          )
        : undefined;
      const textFileEdits = repoEditInvocation || !allowPseudoRepoWrites ? [] : extractTextFileEdits(sourceText);

      if (!repoEditInvocation && textFileEdits.length === 0) continue;

      if (repoEditInvocation?.toolName === 'batch_edit_repo_files') {
        const normalizedArgs = normalizeBatchEditRepoFilesArgs(repoEditInvocation.args, {
          existingPaths: getRepoToolExistingPaths(scopeId),
        }) as { changes?: unknown };
        const fileChanges = Array.isArray(normalizedArgs.changes)
          ? normalizedArgs.changes as Array<{ path?: string; action?: 'create' | 'edit' | 'delete'; content?: string }>
          : [];
        const knownPaths = getRepoToolExistingPaths(scopeId);

        for (const change of fileChanges) {
          if (
            typeof change?.path !== 'string' ||
            (change.action !== 'create' && change.action !== 'edit' && change.action !== 'delete')
          ) {
            continue;
          }
          const action = resolveRepoWriteAction(change.action, change.path, knownPaths);

          const existing = useChangesetStore.getState().getChangeset(scopeId).changes[change.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[change.path] ?? '';
          addChange({
            path: change.path,
            action,
            content: typeof change.content === 'string' ? change.content : '',
            originalContent,
            staged: true,
          });
          if (action === 'delete') {
            knownPaths.delete(change.path);
          } else {
            knownPaths.add(change.path);
          }
        }
      } else if (repoEditInvocation) {
        const normalizedArgs = repoEditInvocation.toolName === 'create_repo_file'
          ? normalizeCreateRepoFileArgs(repoEditInvocation.args)
          : repoEditInvocation.toolName === 'delete_repo_file'
            ? normalizeDeleteRepoFileArgs(repoEditInvocation.args)
            : normalizeEditRepoFileArgs(repoEditInvocation.args);
        const path = typeof (normalizedArgs as { path?: unknown }).path === 'string'
          ? (normalizedArgs as { path: string }).path
          : null;
        const action = repoEditInvocation.toolName === 'create_repo_file'
          ? 'create'
          : repoEditInvocation.toolName === 'delete_repo_file'
            ? 'delete'
            : 'edit';
        if (!path) continue;
        const knownPaths = getRepoToolExistingPaths(scopeId);
        const resolvedAction = resolveRepoWriteAction(action, path, knownPaths);
        if (resolvedAction === 'delete' && !knownPaths.has(path)) {
          continue;
        }
        const existing = useChangesetStore.getState().getChangeset(scopeId).changes[path];
        const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[path] ?? '';
        addChange({
          path,
          action: resolvedAction,
          content: typeof (normalizedArgs as { content?: unknown }).content === 'string' ? (normalizedArgs as { content: string }).content : '',
          originalContent,
          staged: true,
        });
      } else {
        for (const edit of textFileEdits) {
          const existing = useChangesetStore.getState().getChangeset(scopeId).changes[edit.path];
          const originalContent = existing?.originalContent ?? useChangesetStore.getState().getChangeset(scopeId).repoFileCache[edit.path] ?? '';
          addChange({
            path: edit.path,
            action: 'edit',
            content: edit.content,
            originalContent,
            staged: true,
          });
        }
      }

      appliedPseudoRepoMessageIdsRef.current.add(message.id);
    }
  }, [activeRepo, addChange, isStreaming, messages, scopeId]);
  // Auto-open PR modal when streaming finishes with staged changes.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && activeRepo && onReadyForPR) {
      const lastAssistantMessage = messages.findLast((message: any) => message.role === 'assistant');
      const lastAssistantIndex = lastAssistantMessage
        ? messages.findIndex((message: any) => message.id === lastAssistantMessage.id)
        : -1;
      const allowPseudoRepoWrites = lastAssistantIndex >= 0
        ? allowPseudoRepoWritesForAssistantMessage(messages as Array<{
            id: string;
            role: string;
            content: string;
            parts?: Array<{ type?: string; text?: string; reasoning?: string; toolInvocation?: ProposalToolInvocationLike }>;
            toolInvocations?: ProposalToolInvocationLike[];
          }>, lastAssistantIndex) || repoEditIntentRef.current
        : repoEditIntentRef.current;
      const messageToolActivity = lastAssistantMessage?.id
        ? toolActivityRef.current[lastAssistantMessage.id] || []
        : [];
      const messageServerToolEvents = lastAssistantMessage?.id
        ? serverToolEventsRef.current[lastAssistantMessage.id] || []
        : [];
      const executedRepoWrites = lastAssistantMessage
        ? collectRepoWorkflowToolNames(
            lastAssistantMessage as {
              content?: string;
              parts?: Array<{ type?: string; text?: string; toolInvocation?: { toolName?: string } }>;
              toolInvocations?: Array<{ toolName?: string }>;
            },
            messageToolActivity,
            messageServerToolEvents,
          ).some((toolName) => REPO_EDIT_TOOL_NAMES.has(toolName))
        : false;
      const recoverablePseudoRepoWrites = lastAssistantMessage
        ? hasRecoverablePseudoRepoWrites(
            lastAssistantMessage as {
              content?: string;
              parts?: Array<{ type?: string; text?: string }>;
            },
            allowPseudoRepoWrites,
          )
        : false;

      if (!executedRepoWrites && !recoverablePseudoRepoWrites) {
        return;
      }

      const stagedCount = useChangesetStore.getState().getStagedCount(scopeId);
      if (stagedCount > 0) {
        // Streaming finished with staged changes — open PR modal
        onReadyForPR(panelId);
      }
    }
  }, [activeRepo, isStreaming, messages, onReadyForPR, panelId, scopeId]);

  // requestConversationIdRef is synced with conversationId during render (line 264)

  // Anchor the elapsed timer globally so a panel close/reopen mid-stream
  // doesn't restart it. Set on stream start; cleared only when a stream this
  // panel owned ends while mounted (true→false transition). Deliberately NOT
  // cleared on initial mount or in the unmount cleanup — the run may continue
  // server-side and the reopened panel needs the anchor.
  const streamedThisInstanceRef = useRef(false);
  useEffect(() => {
    if (conversationId) {
      useActivityStore.getState().setStreaming(conversationId, isStreaming);
      if (isStreaming) {
        streamedThisInstanceRef.current = true;
        useActivityStore.getState().markStreamAnchor(conversationId, Date.now());
      } else if (streamedThisInstanceRef.current) {
        streamedThisInstanceRef.current = false;
        useActivityStore.getState().clearStreamAnchor(conversationId);
      }
    }
    return () => {
      if (conversationId) {
        useActivityStore.getState().setStreaming(conversationId, false);
      }
    };
  }, [isStreaming, conversationId]);

  // Track previous conversation so we can save its file state on switch
  const prevConversationIdRef = useRef<string | null>(null);

  /** Replace the panel's changeset + preview with saved data from IndexedDB. */
  const restoreFileState = useCallback((convId: string) => {
    // If this scope was already hydrated (from DB or user interaction) this session,
    // the in-memory changeset store already has the correct state — skip the async DB read.
    // This eliminates race conditions when rapidly switching between visited conversations.
    if (hydratedScopesRef.current.has(scopeId)) {
  
      return;
    }

    db.conversationFiles.get(convId).then((saved) => {
      // Each conversation has its own isolated scope in the changeset store,
      // so writing to a non-current scope is safe — it pre-populates the store
      // for when the user returns to that conversation. No staleness guard needed.
      hydratedScopesRef.current.add(scopeId);
      const csStore = useChangesetStore.getState();
      const psStore = usePreviewStore.getState();
      const currentChangeset = csStore.getChangeset(scopeId);
      const currentPreview = psStore.getPreview(scopeId);
      const hasLiveState =
        currentChangeset.activeRepo !== null ||
        Object.keys(currentChangeset.changes).length > 0 ||
        currentPreview.files.length > 0;
      if (saved) {
        const { changeset: cs, preview } = saved;
        if (cs.activeRepo) {
            csStore.switchActiveRepo(scopeId, cs.activeRepo);
            // Backfill the thread→project pointer for threads whose repo was
            // attached before the sidebar grouped by project, so they show
            // under their project on open instead of "No project".
            const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
            if (conv && (conv.repoFullName ?? null) !== cs.activeRepo.fullName) {
              void db.conversations.update(convId, { repoFullName: cs.activeRepo.fullName })
                .then(() => { void useChatStore.getState().loadConversations(); })
                .catch(() => { /* best-effort grouping backfill */ });
            }
          } else {
          csStore.clearActiveRepo(scopeId);
        }
        csStore.setPullRequest(scopeId, cs.pullRequest ?? null);
        csStore.setRepoFileTree(scopeId, cs.repoFileTree);
        csStore.setSelectedRepoFilePath(scopeId, cs.selectedRepoFilePath ?? null);
        const restoredCache = cs.repoFileCache
          ?? saved.repoFileCache
          ?? Object.fromEntries(
            Object.values(cs.changes)
              .filter((change) => typeof change.originalContent === 'string')
              .map((change) => [change.path, change.originalContent as string])
          );
        for (const [path, content] of Object.entries(restoredCache)) {
          csStore.cacheRepoFile(scopeId, path, content);
        }
        for (const change of Object.values(cs.changes)) {
          csStore.addChange(scopeId, change);
        }
        psStore.replacePreview(scopeId, {
          isOpen: preview.isOpen ?? false,
          files: preview.files as PreviewFile[],
          activeFileId: preview.activeFileId,
          projectType: preview.projectType as ProjectType,
          railWidth: typeof (preview as Record<string, unknown>).railWidth === 'number' ? (preview as Record<string, unknown>).railWidth as number : 320,
          activeView:
            preview.activeView === 'changes'
              ? 'changes'
              : preview.activeView === 'repo'
                ? 'repo'
              : 'preview',
        });
      } else if (!hasLiveState) {
        resetPanelFileState();
      }
      // Reset pseudo-repo tracking only for the scope the user is currently viewing.
      if (convIdRef.current === convId) {
        appliedPseudoRepoMessageIdsRef.current = new Set();
      }
    });
  }, [resetPanelFileState, scopeId]);

  const hydrateConversationMessages = useCallback((convId: string) => {
    db.messages.getByConversation(convId).then((msgs) => {
      // Guard against stale results when rapidly switching conversations.
      if (convIdRef.current !== convId) return;
      safeSetMessages(toStoredAIMessages(msgs));
    });
  }, [safeSetMessages]);

  // When a server-side background run (window closed mid-task) finishes, its
  // assistant message is persisted server-side without flowing through this
  // hook. If that conversation is open here and not streaming, re-hydrate so
  // the result appears without a manual conversation switch.
  useEffect(() => {
    const onBackgroundRunFinished = (event: Event) => {
      const finishedConvId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (!finishedConvId || finishedConvId !== conversationId) return;
      if (isStreamingRef.current) return;
      hydrateConversationMessages(finishedConvId);
    };
    window.addEventListener('hermes-background-run-finished', onBackgroundRunFinished);
    return () => window.removeEventListener('hermes-background-run-finished', onBackgroundRunFinished);
  }, [conversationId, hydrateConversationMessages]);

  // Load messages (and file state) from IndexedDB when switching conversations
  useEffect(() => {
    // Always keep these refs in sync — they're needed by callbacks (onFinish, onToolCall)
    // even during streaming.
    if (conversationId && pendingConversationIdRef.current === conversationId) {
      pendingConversationIdRef.current = null;
    }
    // If the user navigates to a different conversation while one is streaming,
    // abort the stream and clear the message buffer immediately so the user
    // doesn't see the old conversation's streaming chunks in the new one.
    // The stream's partial result is already being persisted to IndexedDB
    // via onFinish/onToolCall, so nothing is lost.
    //
    // IMPORTANT: do NOT update convIdRef before detecting the switch. Streaming
    // callbacks (e.g. server tool events at applyServerToolEvent) read
    // convIdRef.current synchronously; if we retargeted it to the new
    // conversation here, in-flight chunks from the old stream would route
    // their tool activity and changeset writes to the wrong conversation
    // during the window between this update and stop() taking effect.
    const prevConvId = prevConversationIdRef.current;
    // Identify the stream's owning conversation via streamConvIdRef rather than
    // prevConvId: for a stream that started from a draft, prevConvId is still
    // null (it's only updated when not streaming), so a "New thread" click
    // mid-stream would otherwise be a no-op and the UI would stay pinned to
    // the streaming conversation.
    const streamOwnerConvId = streamConvIdRef.current ?? prevConvId;
    // During draft→conv promotion the conversationId prop lags one render
    // behind the panel binding; pendingConversationIdRef still points at the
    // stream's conversation in that window. Don't treat the lag as navigation.
    const isPromotionLag =
      conversationId === null && pendingConversationIdRef.current === streamOwnerConvId;
    if (isStreaming && streamOwnerConvId !== null && conversationId !== streamOwnerConvId && !isPromotionLag) {
      stop();
      // Release the session lock so chatSessionId falls back to the derived
      // id for the new conversation. Without this, a stream that started
      // from a draft keeps the AI SDK bucket pinned to `draft-N:panelId`
      // even after the user switches conversations — so buffered chunks
      // that arrive after stop() (already read from the network) and the
      // subsequent onFinish write the aborting stream's partial response
      // into the bucket the user is now viewing. Clearing the lock makes
      // the next render subscribe to the new conversation's bucket, so
      // late writes from the aborting stream's captured mutate land in
      // the now-invisible draft bucket instead of bleeding into the view.
      if (sessionLock !== null) {
        setSessionLock(null);
      }
      // Immediately clear the message buffer. safeSetMessages would silently
      // drop this due to isStreamingRef.current, but the stream is being
      // aborted so clobbering its buffer is the correct behavior.
      // Use force=true to bypass the streaming guard.
      safeSetMessages([], true);
      // Kick off async hydration of the new conversation — by the time the
      // IndexedDB read resolves, isStreaming will likely be false and
      // safeSetMessages will accept the result.
      if (conversationId !== null) {
        hydrateConversationMessages(conversationId);
      }
      // Leave convIdRef pointing at the aborting conversation; the effect
      // will re-run once isStreaming flips false and update it then.
      // Still return early — the full switch (save files, reset state) runs
      // when isStreaming becomes false and the effect re-runs.
      return;
    }

    if (conversationId !== null) {
      convIdRef.current = conversationId;
    }
    // When going to null, we intentionally leave convIdRef pointing at the old conversation
    // until the next conversation is assigned. This prevents losing streaming responses.

    // Don't hydrate or reset messages while streaming — it would clobber the live buffer.
    // Also wait until the AI SDK session ID catches up with the visible conversation so
    // persisted messages never hydrate into the previous conversation's session bucket.
    // Note: prevConversationIdRef is NOT updated here so that the deferred re-run
    // still sees the actual previous conversation and performs the full switch.
    if (isStreaming || aiChatSessionId !== chatSessionId) return;

    prevConversationIdRef.current = conversationId;

    const isDraftPromotion =
      prevConvId === null && conversationId !== null && skipNextLoadRef.current;
    if (prevConvId !== conversationId && !isDraftPromotion) {
      hermesSessionIdOverrideRef.current = null;
    }

    // Transition: null → new conversation (just created).
    // The user may have already set up a repo/changeset on the blank thread.
    // Preserve current state and associate it with the new conversation instead of clearing.
    if (prevConvId === null && conversationId !== null) {
      if (skipNextLoadRef.current) {
        // Just created this conversation — preserve current state
        skipNextLoadRef.current = false;
        hydratedScopesRef.current.add(scopeId);

        // Migrate changeset data from the panel scope to the new conversation scope.
        // When startRepoChatInNewThread attaches a repo on scopeId=panelId and then
        // a conversation is created, the scope shifts to conversationId. Without this
        // migration, onToolCall and subsequent reads see an empty changeset.
        const prevScopeId = panelId;
        if (prevScopeId !== scopeId) {
          const csStore = useChangesetStore.getState();
          const psStore = usePreviewStore.getState();
          csStore.replaceChangeset(scopeId, csStore.getChangeset(prevScopeId));
          psStore.replacePreview(scopeId, psStore.getPreview(prevScopeId));
        }

        // When the AI SDK session ID changed (draft→convId), the AI SDK resets
        // its internal message store to []. If that happened, hydrate from DB
        // so the user message and assistant response aren't lost.
        if (messagesRef.current.length === 0) {
          hydrateConversationMessages(conversationId);
        }
        void saveConversationFiles(conversationId);
        return;
      }
      // Navigating to an existing conversation on startup — restore its file state
      hydrateConversationMessages(conversationId);
      restoreFileState(conversationId);
      return;
    }

    // Save file state for the conversation we're leaving, then clean up
    // its in-memory store entries to prevent unbounded memory growth.
    // Also remove it from hydratedScopesRef so re-visiting it reads fresh DB data.
    if (prevConvId) {
      const prevScopeId = getChatScopeId(panelId, prevConvId);
      void saveConversationFiles(prevConvId, prevScopeId);
      // Clean up in-memory state for the old conversation after persisting to DB.
      useChangesetStore.getState().cleanupPanel(prevScopeId);
      usePreviewStore.getState().cleanupPanel(prevScopeId);
      hydratedScopesRef.current.delete(prevScopeId);
    }

    if (conversationId) {
      if (skipNextLoadRef.current) {
        skipNextLoadRef.current = false;
        hydratedScopesRef.current.add(scopeId);
        // Same guard as above: if the AI SDK reset messages due to a session ID
        // change, we need to restore them from the database.
        if (messagesRef.current.length === 0) {
          hydrateConversationMessages(conversationId);
        }
        return;
      }
      hydrateConversationMessages(conversationId);

      // Restore file state for this conversation
      restoreFileState(conversationId);
    } else {
      const initialBlankThread = prevConvId === null;
      const preservePanelRepoHandoff = useUIStore.getState().preservePanelRepoHandoffs[panelId] === true;
      if (preservePanelRepoHandoff) {
        useUIStore.getState().clearPanelRepoHandoff(panelId);
      }
      safeSetMessages([] as AIMessage[]);
      if (!preservePanelRepoHandoff && !initialBlankThread) {
        resetPanelFileState();
      }
    }

    // Clear hermes tool activity and server-side detection flag on conversation switch
    setToolActivityMap({});
    setAgentStatus(null);
    setComputerUseDock(INITIAL_COMPUTER_USE_DOCK_STATE);
    computerUsePermissionsCheckedRef.current = false;
    setConversationAutoApproveEnabled(false);
    toolActivityRef.current = {};
    serverToolEventsRef.current = {};
    serverToolEventKeysRef.current = {};
    serverSideToolsDetectedRef.current = false;
    toolCallRecordsRef.current = {};
    setToolCallRecordsState({});
    useHermesStore.getState().setToolCallRecords(panelId, {});
    visibleRetryCountRef.current = 0;
    retriedToolsRef.current.clear();
    clearStreamRetryIndicator();

  }, [aiChatSessionId, chatSessionId, clearStreamRetryIndicator, conversationId, safeSetMessages, panelId, resetPanelFileState, restoreFileState, saveConversationFiles, hydrateConversationMessages, isStreaming, scopeId, sessionLock, stop]);

  // Auto-save file state (debounced) whenever the panel's file state changes
  useEffect(() => {
    // Use the prop directly rather than the ref, since the ref may still
    // point to a previous conversation during the null→new transition.
    const convId = conversationId;
    if (!convId) return;
    if (Object.keys(changeset.changes).length === 0 && !changeset.activeRepo && preview.files.length === 0) return;

    const timer = setTimeout(() => {
      // Guard: only save if the user is still on the same conversation.
      // During a rapid switch, changeset/preview values from the old conv
      // could still be in the React state when the timer fires.
      if (convIdRef.current !== convId) return;
      void saveConversationFiles(convId);
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [conversationId, changeset, preview, saveConversationFiles]);

  useEffect(() => {
    return () => {
      if (autoContinueTimerRef.current) {
        clearTimeout(autoContinueTimerRef.current);
      }
      const convId = convIdRef.current;
      if (convId) {
        void saveConversationFiles(convId);
      }
    };
  }, [saveConversationFiles]);

  const queueMessage = useCallback((contentOverride?: string) => {
    const content = (contentOverride ?? draftInput).trim();
    if (!content) return false;

    setQueuedMessages((prev) => [...prev, createQueuedMessage(content)]);
    if (contentOverride === undefined) {
      setDraftInput('');
    }
    return true;
  }, [draftInput]);

  const sendMessage = useCallback(async (rawContent: string, options?: SendMessageOptions) => {
    const content = rawContent.trim();
    if (!content) return;
    // Guard against duplicate / reentrant sends (e.g. React StrictMode, fast
    // double-clicks, or effects re-firing while the first send is in-flight).
    if (isSendingRef.current) {
      console.warn('[useChat] sendMessage Duplicate send blocked');
      return;
    }
    isSendingRef.current = true;
    const clearDraft = options?.clearDraft ?? false;

    // A new user message supersedes any pending plan gate / checklist —
    // the user is steering again, so no consent panel may linger.
    useChatStore.getState().setPlanGatePrompt(null);
    useChatStore.getState().setPlanSteps(null);
    planModeTurnRef.current = false;

    const providerInfo = PROVIDERS[effectiveProvider as keyof typeof PROVIDERS];

    // Check if API key is needed but missing
    if (providerInfo?.needsApiKey && !config.apiKey) {
      isSendingRef.current = false;
      setApiKeyModalOpen(true);
      return;
    }

    // Reset auto-continue counter and stop flag on explicit user messages
    unknownFinishRetryRef.current = 0;
    repoStopRetryRef.current = 0;
    userStoppedRef.current = false;

    let convId = options?.forceNewConversation
      ? null
      : (conversationId ?? pendingConversationIdRef.current);

    // Create conversation if needed
    if (!convId) {
      // Lock the AI SDK session to the draft bucket BEFORE any await so the
      // lock is applied synchronously. Any re-render that happens before the
      // conversation id propagates down through props will still read the
      // locked session id and keep the streaming buffer intact.
      // forceNewConversation (plan-gate "clear context") starts a fresh epoch
      // so the new thread gets its own bucket instead of reusing the draft
      // bucket of an earlier thread.
      if (options?.forceNewConversation) {
        draftEpochRef.current += 1;
      }
      setSessionLock(`draft-${draftEpochRef.current}:${panelId}`);
      try {
        convId = await createConversation(effectiveProvider, effectiveModel, defaultSystemPrompt);
        pendingConversationIdRef.current = convId;
        convIdRef.current = convId;
        requestConversationIdRef.current = convId;
        await saveConversationFiles(convId, scopeId);
      } catch (e) {
        console.error('Failed to create conversation:', e);
        isSendingRef.current = false;
        return;
      }
      // Bind the panel to the real conversation immediately so a "New thread"
      // click during the in-flight stream sees conversationId !== null and
      // actually flips state. Before this, onConversationCreated fired after
      // append() resolved, so clicks during streaming were null→null no-ops.
      // Draft-session stability (see sessionLock above) keeps the AI SDK
      // bucket pinned to the draft until the stream settles, so messages
      // still render for the user.
      skipNextLoadRef.current = true;
      onConversationCreated?.(convId);
    }

    const currentPendingProposal = findPendingProposal(messagesRef.current as Array<{
      id: string;
      role: string;
      content?: string;
      parts?: Array<{ type?: string; text?: string; reasoning?: string; toolInvocation?: { toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown } }>;
      toolInvocations?: Array<{ toolName?: string; state?: string; args?: Record<string, unknown>; result?: unknown }>;
    }>) ?? pendingProposalRef.current;
    const pendingProposalKey = getPendingProposalKey(currentPendingProposal);
    const approvalFollowUp = isRepoApprovalFollowUpMessage(content) &&
      (pendingProposalKey !== null || approvedProposalContinuationRef.current !== null);
    // Persist user message to IndexedDB
    const effectiveRepoEditIntent = isRepoMode && activeRepo
      ? (typeof options?.repoEditIntentOverride === 'boolean'
          ? options.repoEditIntentOverride
          : approvalFollowUp || isRepoEditIntentMessage(content))
      : false;

    repoEditIntentRef.current = effectiveRepoEditIntent;
    if (approvalFollowUp) {
      approvedProposalContinuationRef.current = {
        conversationId: convId,
        proposalKey: pendingProposalKey ?? approvedProposalContinuationRef.current?.proposalKey ?? null,
      };
      pendingProposalRef.current = currentPendingProposal;
    } else if (!effectiveRepoEditIntent) {
      approvedProposalContinuationRef.current = null;
    }

    const userMsgId = crypto.randomUUID();
    await db.messages.add({
      id: userMsgId,
      conversationId: convId,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    });
    await db.conversations.update(convId, { updatedAt: new Date().toISOString() });

    // Auto-rename conversation from first message
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (conv?.title === 'New conversation') {
      const title = content.slice(0, CONVERSATION_TITLE_MAX_LENGTH) + (content.length > CONVERSATION_TITLE_MAX_LENGTH ? '...' : '');
      await renameConversation(convId, title);
    }

    // Clear input and send to AI
    if (clearDraft) {
      setDraftInput('');
    }

    // Sanitize any partial tool invocations from interrupted streams
    const currentMessages = messagesRef.current;
    const sanitized = sanitizeRetryMessages(currentMessages);
    if (sanitized !== currentMessages) {
      safeSetMessages(sanitized, true);
    }

    const repoFileTreeForRequest = await ensureRepoFileTreeLoaded();

    let messageForModel = content;
    if (hasContextRefs(content)) {
      const currentChangeset = useChangesetStore.getState().getChangeset(scopeId);
      const repo = currentChangeset.activeRepo;
      const expansion = await expandContextRefs(content, {
        workspaceRoot: repo?.localPath,
        repoFileTree: repoFileTreeForRequest,
        repoOwner: repo?.owner,
        repoName: repo?.name,
        repoBranch: repo?.defaultBranch,
        githubPat: useSettingsStore.getState().githubPAT || undefined,
      });
      messageForModel = expansion.expanded;
      if (expansion.warnings.length > 0) {
        toast.warning(expansion.warnings.join('\n'));
      }
    }

    delete toolActivityRef.current.current;
    delete serverToolEventsRef.current.current;
    delete serverToolEventKeysRef.current.current;
    serverSideToolsDetectedRef.current = false;
    setAgentStatus(null);
    visibleRetryCountRef.current = 0;
    retriedToolsRef.current.clear();
    if (toolCallRecordsRef.current.current) {
      const { current: _droppedCurrent, ...restRecords } = toolCallRecordsRef.current;
      toolCallRecordsRef.current = restRecords;
      setToolCallRecordsState(restRecords);
      useHermesStore.getState().setToolCallRecords(panelId, restRecords);
    }
    clearStreamRetryIndicator();
    // Plan gate: remember whether this turn was a plan-mode send so onFinish
    // can park the delivered plan text for the implementation gate. Captured
    // from live store state — the same value buildRequestBody reads below.
    planModeTurnRef.current = useChatStore.getState().planMode;
    activeRequestBodyRef.current = buildRequestBody({
      conversationId: convId,
      repoFileTree: repoFileTreeForRequest,
      continuingApprovedProposal: approvalFollowUp,
      repoEditIntent: effectiveRepoEditIntent,
    });

    try {
      await append(
        { role: 'user', parts: [{ type: 'text', text: messageForModel }] as any },
        convId
          ? {
              body: {
                conversation_id: convId,
                ...(isRepoMode && activeRepo ? { repo_edit_intent: repoEditIntentRef.current } : {}),
                ...(repoFileTreeForRequest.length > 0
                  ? { repo_file_tree: repoFileTreeForRequest }
                  : {}),
                ...(approvalFollowUp ? { continuing_approved_proposal: true } : {}),
              },
            }
          : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const expectedAbort =
        message.includes('abort') ||
        message.includes('cancel') ||
        message.includes('stopped');
      if (!expectedAbort) {
        activeRequestBodyRef.current = null;
        isSendingRef.current = false;
        throw error;
      }
      activeRequestBodyRef.current = null;
    } finally {
      isSendingRef.current = false;
      // STEP 9: Auto-clear plan mode after sending
      useChatStore.getState().setPlanMode(false);
    }

    return true;
  }, [activeRepo, append, buildRequestBody, clearStreamRetryIndicator, config, conversationId, createConversation, defaultSystemPrompt, effectiveModel, effectiveProvider, ensureRepoFileTreeLoaded, isRepoMode, onConversationCreated, panelId, renameConversation, saveConversationFiles, scopeId, safeSetMessages, sanitizeRetryMessages]);

  const handleSend = useCallback(() => {
    if (effectiveBusy) {
      queueMessage();
      return;
    }
    void sendMessage(draftInput, { clearDraft: true });
  }, [draftInput, effectiveBusy, queueMessage, sendMessage]);

  const handleQuickSend = useCallback((content: string) => {
    if (effectiveBusy) {
      queueMessage(content);
      return;
    }
    void sendMessage(content);
  }, [effectiveBusy, queueMessage, sendMessage]);

  /**
   * Plan gate decision: send "implement this plan" into the current
   * conversation, or (clearContext) into a brand-new one. Reuses sendMessage
   * — the new thread rides the exact draft→conversation promotion path
   * (createConversation + onConversationCreated binding).
   */
  const handleImplementPlan = useCallback((clearContext: boolean) => {
    const prompt = useChatStore.getState().planGatePrompt;
    if (!prompt) return;
    useChatStore.getState().setPlanGatePrompt(null);
    useChatStore.getState().setPlanSteps(null);
    // The implementation turn must not run under plan-mode tool filtering.
    useChatStore.getState().setPlanMode(false);
    const content = `Here is the approved plan — implement it now:\n\n${prompt}`;
    void sendMessage(content, {
      clearDraft: true,
      forceNewConversation: clearContext,
      repoEditIntentOverride: true,
    });
  }, [sendMessage]);

  const handleCancelPlanGate = useCallback(() => {
    // Stay in plan mode: dismiss the gate but keep the checklist as the
    // record of the proposed plan.
    useChatStore.getState().setPlanGatePrompt(null);
  }, []);

  const clearHermesSessionAttachment = useCallback(() => {
    hermesSessionIdOverrideRef.current = null;
  }, []);

  const handleResumeSession = useCallback(async (sessionSpec?: string): Promise<string> => {
    const detail = await resolveHermesSessionForResume(sessionSpec);
    const sessionId = detail.id;
    hermesSessionIdOverrideRef.current = sessionId;

    const hydrated = hermesSessionChatToAIMessages(sessionId, detail.chat);
    if (hydrated.length > 0) {
      safeSetMessages(hydrated, true);
    }

    const title = hermesSessionTitle(detail);
    const shortId = sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
    const loaded = hydrated.length > 0
      ? `${hydrated.length} message${hydrated.length === 1 ? '' : 's'} loaded. `
      : '';
    return `Attached Hermes session "${title}" (${shortId}). ${loaded}Next message continues that session.`;
  }, [safeSetMessages]);

  useEffect(() => {
    if (!pendingPanelPrompt || effectiveBusy) {
      return;
    }

    clearPanelPrompt(panelId);
    if (pendingPanelPrompt.autoSend) {
      void sendMessage(pendingPanelPrompt.content, {
        repoEditIntentOverride: pendingPanelPrompt.repoEditIntentOverride,
      });
      return;
    }

    setDraftInput(pendingPanelPrompt.content);
  }, [clearPanelPrompt, effectiveBusy, panelId, pendingPanelPrompt, sendMessage]);

  const handleRemoveQueuedMessage = useCallback((messageId: string) => {
    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId));
  }, []);

  const handleSteerQueuedMessage = useCallback((messageId: string) => {
    const queued = queuedMessages.find((message) => message.id === messageId);
    if (!queued) return;

    if (isStreaming) {
      setQueuedMessages((prev) => moveQueuedMessageToFront(prev, messageId));
      stop();
      return;
    }

    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId));
    void sendMessage(queued.content);
  }, [isStreaming, queuedMessages, sendMessage, stop]);

  useEffect(() => {
    if (effectiveBusy) return;
    if (queuedMessages.length === 0) return;
    if (autoSendingQueuedRef.current) return;

    const nextMessage = queuedMessages[0];
    autoSendingQueuedRef.current = nextMessage.id;

    void (async () => {
      const sent = await sendMessage(nextMessage.content);
      if (sent) {
        setQueuedMessages((prev) => removeQueuedMessage(prev, nextMessage.id));
      }
      autoSendingQueuedRef.current = null;
    })();
  }, [effectiveBusy, queuedMessages, sendMessage]);

  // ─── Explicit tool retry / message edit / approval audit actions ──────────
  // Chat components enqueue these through the hermes store (panel-scoped);
  // the effect below consumes them. This keeps the runtime reachable even
  // when the panel runtime only forwards the props it knows about.

  const handleRetryToolInternal = useCallback((request: { toolName: string; callId?: string }) => {
    if (isStreamingRef.current || isSendingRef.current) {
      return;
    }
    if (visibleRetryCountRef.current >= MAX_VISIBLE_TOOL_RETRIES) {
      console.warn('[useChat] retryTool Retry cap reached for this message');
      return;
    }
    const convId = convIdRef.current ?? pendingConversationIdRef.current;
    if (!convId) {
      console.warn('[useChat] retryTool No conversation bound — cannot retry');
      return;
    }
    // Idempotency: one explicit retry per tool call per turn — a queued
    // duplicate click is consumed silently.
    const retryKey = request.callId ? `call:${request.callId}` : `name:${request.toolName}`;
    if (retriedToolsRef.current.has(retryKey)) {
      return;
    }
    retriedToolsRef.current.add(retryKey);
    const name = request.toolName;
    const invocation = findToolInvocationArgs(messagesRef.current, request.callId, name);
    const argsJson = invocation?.args ? truncateArgsJson(JSON.stringify(invocation.args)) : null;
    visibleRetryCountRef.current += 1;
    // Reuse the auto-continue injection mechanism (300ms debounced system
    // append) so the retry is explicit but rides the exact same append path.
    scheduleAutoContinue({
      conversationId: convId,
      content: argsJson
        ? `The previous tool call ${name} failed. Retry it with the same arguments: ${argsJson}`
        : `The previous tool call ${name} failed. Retry it with the same arguments.`,
      continuingApprovedProposal: approvedProposalContinuationRef.current !== null,
      forceRepoEditIntent: repoEditIntentRef.current,
    });
  }, [scheduleAutoContinue]);

  const handleEditMessageInternal = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isStreamingRef.current) {
      return;
    }
    const current = messagesRef.current;
    const userIdx = current.findLastIndex(
      (m) => m.role === 'user' && getMessageContent(m).trim().length > 0,
    );
    if (userIdx < 0) {
      return;
    }
    const convId = convIdRef.current ?? pendingConversationIdRef.current;
    if (!convId) {
      return;
    }
    // Drop the edited user message and every message below it from the live
    // buffer; sendMessage re-appends the edited text and streams a fresh
    // response. Sync messagesRef synchronously so the append path doesn't
    // read a stale buffer before the next render.
    messagesRef.current = current.slice(0, userIdx);
    safeSetMessages(messagesRef.current, true);
    // Rewrite the persisted tail so a reload shows the edited thread: delete
    // the conversation's messages and re-add everything above the edit point.
    try {
      const stored = await db.messages.getByConversation(convId);
      const storedUserIdx = stored.findLastIndex(
        (m) => m.role === 'user' && getMessageContent(m).trim().length > 0,
      );
      if (storedUserIdx >= 0) {
        const kept = stored.slice(0, storedUserIdx);
        await db.messages.deleteByConversation(convId);
        for (const message of kept) {
          await db.messages.add(message);
        }
      }
    } catch (error) {
      console.error('[useChat] editMessage Failed to rewrite persisted messages:', error);
    }
    await sendMessage(trimmed);
  }, [safeSetMessages, sendMessage]);

  const handleApprovalAuditInternal = useCallback(async (entry: {
    tool: string;
    command?: string;
    approved: boolean;
  }) => {
    const convId = convIdRef.current ?? pendingConversationIdRef.current;
    if (!convId) {
      return;
    }
    const commandPrefix = entry.command ? getCommandDisplayPrefix(entry.command) : '';
    const text = entry.approved
      ? `✓ You approved ${entry.tool}${commandPrefix ? ` ${commandPrefix}` : ''}`
      : `✗ You did not approve ${entry.tool}`;
    const messageId = crypto.randomUUID();
    const auditMessage = {
      id: messageId,
      role: 'assistant' as const,
      content: '',
      parts: [{ type: 'tool_approval' as const, text, approved: entry.approved }],
      timestamp: new Date().toISOString(),
    };
    // Only mirror into the live buffer when the user is still viewing the
    // conversation the decision belongs to — the DB write below is the
    // source of truth and rehydrates on switch.
    if (convId === viewedConvIdRef.current) {
      messagesRef.current = [...messagesRef.current, auditMessage as unknown as AIMessage];
      setMessages(messagesRef.current);
    }
    try {
      await upsertStoredMessage({
        id: messageId,
        conversationId: convId,
        role: 'assistant',
        content: '',
        parts: auditMessage.parts,
        timestamp: auditMessage.timestamp,
      });
      await db.conversations.update(convId, { updatedAt: new Date().toISOString() });
      await loadConversations();
    } catch (error) {
      console.error('[useChat] approvalAudit Failed to persist audit entry:', error);
    }
  }, [loadConversations, setMessages]);

  const pendingChatActions = useHermesStore((s) => s.pendingChatActions[panelId] ?? null);

  useEffect(() => {
    if (!pendingChatActions || pendingChatActions.length === 0) {
      return;
    }
    const [next, ...rest] = pendingChatActions;
    // Retry/edit need an idle stream; the audit line can append mid-stream
    // (the approval decision resolves a parked tool call).
    if ((next.kind === 'retry_tool' || next.kind === 'edit_message') && isStreamingRef.current) {
      return;
    }
    useHermesStore.getState().setPendingChatActions(panelId, rest);
    if (next.kind === 'retry_tool') {
      handleRetryToolInternal(next);
    } else if (next.kind === 'edit_message') {
      void handleEditMessageInternal(next.content);
    } else {
      void handleApprovalAuditInternal(next);
    }
  }, [
    handleApprovalAuditInternal,
    handleEditMessageInternal,
    handleRetryToolInternal,
    isStreaming,
    panelId,
    pendingChatActions,
  ]);

  useEffect(() => {
    setQueuedMessages([]);
    autoSendingQueuedRef.current = null;
    pendingProposalRef.current = null;
    explicitProposalKeyRef.current = null;
    approvedProposalContinuationRef.current = null;
    pausedProposalKeyRef.current = null;
    contentProposalStabilityRef.current = { key: null, cycles: 0 };
    // A conversation switch invalidates the previous thread's plan gate,
    // checklist and plan-mode turn tracking.
    useChatStore.getState().setPlanGatePrompt(null);
    useChatStore.getState().setPlanSteps(null);
    planModeTurnRef.current = false;
  }, [conversationId]);

  const handleRegenerate = useCallback(() => {
    const lastUserMessage = messagesRef.current.findLast((message) => message.role === 'user') ? getMessageContent(messagesRef.current.findLast((message) => message.role === 'user')) : '';
    repoEditIntentRef.current = isRepoMode && activeRepo ? isRepoEditIntentMessage(lastUserMessage) : false;
    activeRequestBodyRef.current = buildRequestBody();
    reload();
  }, [activeRepo, buildRequestBody, isRepoMode, reload]);

  const handleComputerUseDockExpand = useCallback(() => {
    setComputerUseDock((current) => reduceComputerUseDockState(current, { userExpanded: true }));
  }, []);

  const handleComputerUseDockCollapse = useCallback(() => {
    setComputerUseDock((current) => reduceComputerUseDockState(current, { userCollapsed: true }));
  }, []);

  // Abort in-flight fetch on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  return {
    messages,
    input: draftInput,
    setInput: setDraftInput,
    handleSend,
    handleQuickSend,
    handleImplementPlan,
    handleCancelPlanGate,
    handleResumeSession,
    clearHermesSessionAttachment,
    queuedMessages,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleStop: stop,
    handleRegenerate,
    // A detached background run reads as streaming to the UI so the running
    // indicator and Stop control stay available after a window close/reopen.
    isStreaming: isStreaming || isBackgroundRunActive,
    isAnotherPanelStreamingSameProfile,
    error,
    apiKeyModalOpen,
    setApiKeyModalOpen,
    providerUnavailableOpen,
    setProviderUnavailableOpen,
    activeProvider: effectiveProvider,
    activeModel: effectiveModel,
    toolActivityMap,
    toolCallRecords,
    agentStatus,
    transportStatusMessage,
    computerUseDock,
    handleComputerUseDockExpand,
    handleComputerUseDockCollapse,
    conversationAutoApproveEnabled,
    setConversationAutoApprove: setConversationAutoApproveEnabled,
    // Enqueued through the hermes store so components can trigger them even
    // when the panel runtime doesn't forward callback props.
    handleRetryTool: (toolName: string, callId?: string) => {
      useHermesStore.getState().requestChatAction(panelId, { kind: 'retry_tool', toolName, callId });
    },
    handleEditMessage: (content: string) => {
      useHermesStore.getState().requestChatAction(panelId, { kind: 'edit_message', content });
    },
    handleApprovalAudit: (entry: { tool: string; command?: string; approved: boolean }) => {
      useHermesStore.getState().requestChatAction(panelId, { kind: 'approval_audit', ...entry });
    },
  };
}
