import type { Conversation, Message } from '@/lib/db';

export const EXPORT_SCHEMA_VERSION = 1;

interface ToolInvocationLike {
  toolCallId?: string;
  toolName?: string;
  state?: string;
  args?: unknown;
  result?: unknown;
}

interface MessagePartLike {
  type?: string;
  text?: string;
  reasoning?: string;
  image?: unknown;
  data?: unknown;
  mimeType?: string;
  toolInvocation?: ToolInvocationLike;
}

const DATA_URI_REGEX = /data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/gi;

function estimateDataUriBytes(dataUri: string): number {
  const commaIndex = dataUri.indexOf(',');
  if (commaIndex === -1) return 0;
  const base64 = dataUri.slice(commaIndex + 1);
  // Base64 decodes to roughly 3/4 of the input length, discounting padding.
  const padding = (base64.match(/=+$/)?.[0].length) ?? 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function stripDataUrisInString(value: string): string {
  return value.replace(DATA_URI_REGEX, (match) => `[image omitted, ${estimateDataUriBytes(match)} bytes]`);
}

function stripDataUrisInValue<T>(value: T): T {
  if (typeof value === 'string') {
    return stripDataUrisInString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripDataUrisInValue(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripDataUrisInValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

function sanitizeMessage(message: Message): Message {
  const sanitizedContent = stripDataUrisInString(message.content ?? '');
  const sanitizedParts = message.parts ? stripDataUrisInValue(message.parts) : undefined;
  const sanitizedToolInvocations = message.toolInvocations
    ? stripDataUrisInValue(message.toolInvocations)
    : undefined;

  return {
    ...message,
    content: sanitizedContent,
    ...(sanitizedParts !== undefined ? { parts: sanitizedParts } : {}),
    ...(sanitizedToolInvocations !== undefined ? { toolInvocations: sanitizedToolInvocations } : {}),
  };
}

export function formatConversationJson(conversation: Conversation, messages: Message[]): string {
  const payload = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    conversation,
    messages: messages.map(sanitizeMessage),
  };
  return JSON.stringify(payload, null, 2);
}

function collectToolInvocations(message: Message): ToolInvocationLike[] {
  const fromParts: ToolInvocationLike[] = [];
  const parts = (message.parts ?? []) as MessagePartLike[];
  for (const part of parts) {
    if (part && part.type === 'tool-invocation' && part.toolInvocation) {
      fromParts.push(part.toolInvocation);
    }
  }
  const direct = (message.toolInvocations ?? []) as ToolInvocationLike[];
  return [...fromParts, ...direct];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function renderMessageContent(message: Message): string {
  const parts = (message.parts ?? []) as MessagePartLike[];
  const textChunks: string[] = [];

  if (parts.length > 0) {
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        textChunks.push(stripDataUrisInString(part.text));
      } else if (part.type === 'reasoning' && typeof part.reasoning === 'string') {
        textChunks.push(stripDataUrisInString(part.reasoning));
      } else if (part.type === 'image') {
        const raw = typeof part.image === 'string' ? part.image : typeof part.data === 'string' ? part.data : '';
        if (raw) {
          textChunks.push(`[image omitted, ${estimateDataUriBytes(raw)} bytes]`);
        } else {
          textChunks.push('[image omitted]');
        }
      }
    }
  }

  if (textChunks.length === 0 && typeof message.content === 'string' && message.content.length > 0) {
    textChunks.push(stripDataUrisInString(message.content));
  }

  return textChunks.join('\n\n');
}

export function formatConversationMarkdown(conversation: Conversation, messages: Message[]): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push(`_${conversation.provider} · ${conversation.model} · ${conversation.createdAt}_`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    lines.push(`## ${message.role}`);
    const body = renderMessageContent(message);
    if (body.length > 0) {
      lines.push(body);
    }

    const invocations = collectToolInvocations(message);
    for (const inv of invocations) {
      lines.push('');
      lines.push(`> Tool: ${inv.toolName ?? 'unknown'}`);
      lines.push(`> Input: \`${safeJson(inv.args)}\``);
      lines.push(`> Output: \`${safeJson(inv.result)}\``);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
