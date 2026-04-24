import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatConversationJson } from '@/lib/conversation-export';
import { importConversationJson, type Conversation, type Message } from '@/lib/db';

const conversation: Conversation = {
  id: 'original-conv-id',
  title: 'Imported thread',
  provider: 'hermes',
  model: 'claude-opus-4',
  systemPrompt: 'Be helpful.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:05:00.000Z',
};

const messages: Message[] = [
  {
    id: 'm-orig-1',
    conversationId: 'original-conv-id',
    role: 'user',
    content: 'Hello',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'm-orig-2',
    conversationId: 'original-conv-id',
    role: 'assistant',
    content: 'Hi there',
    timestamp: '2026-01-01T00:01:00.000Z',
  },
];

function makeFile(contents: string): File {
  const file = new File([contents], 'conversation.json', { type: 'application/json' });
  // jsdom's File lacks the standard async .text() method (a 2020 Web API);
  // patch it so production code paths work under test.
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', {
      value: async () => contents,
      configurable: true,
    });
  }
  return file;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('importConversationJson', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/functions/v1/health')) {
        return jsonResponse(200, { ok: true });
      }
      if (url.endsWith('/functions/v1/chat-store/conversations')) {
        // ensureServerMigration probes for existing conversations
        return jsonResponse(200, { conversations: [{ id: 'placeholder', title: '', provider: '', model: '', systemPrompt: '', createdAt: '', updatedAt: '' }], total: 1 });
      }
      if (url.endsWith('/functions/v1/chat-store/import')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        return jsonResponse(201, { conversation: body?.conversation });
      }
      return jsonResponse(404, { error: 'not found' });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a formatConversationJson export into a new Conversation with a fresh id', async () => {
    const file = makeFile(formatConversationJson(conversation, messages));
    const result = await importConversationJson(file);

    expect(result).toBeDefined();
    expect(result.id).not.toBe(conversation.id);
    expect(result.title).toBe(conversation.title);
    expect(result.originalCreatedAt).toBe(conversation.createdAt);

    const importCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/functions/v1/chat-store/import'));
    expect(importCall).toBeDefined();
    const payload = JSON.parse(String((importCall![1] as RequestInit).body));
    expect(payload.conversation.id).not.toBe(conversation.id);
    expect(payload.conversation.originalCreatedAt).toBe(conversation.createdAt);
    expect(payload.messages).toHaveLength(messages.length);
    for (const msg of payload.messages) {
      expect(msg.conversationId).toBe(payload.conversation.id);
      expect([messages[0].id, messages[1].id]).not.toContain(msg.id);
    }
  });

  it('rejects unknown schemaVersion with a clear error', async () => {
    const file = makeFile(JSON.stringify({ schemaVersion: 999, conversation, messages }));
    await expect(importConversationJson(file)).rejects.toThrow(/schemaVersion/i);
  });

  it('throws when the conversation field is missing', async () => {
    const file = makeFile(JSON.stringify({ schemaVersion: 1, messages: [] }));
    await expect(importConversationJson(file)).rejects.toThrow(/conversation/i);
  });

  it('throws when the messages array is missing', async () => {
    const file = makeFile(JSON.stringify({ schemaVersion: 1, conversation }));
    await expect(importConversationJson(file)).rejects.toThrow(/messages/i);
  });

  it('throws on invalid JSON', async () => {
    const file = makeFile('{not json');
    await expect(importConversationJson(file)).rejects.toThrow(/JSON/);
  });
});
