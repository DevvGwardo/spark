import { describe, expect, it } from 'vitest';
import {
  EXPORT_SCHEMA_VERSION,
  formatConversationJson,
  formatConversationMarkdown,
} from '@/lib/conversation-export';
import type { Conversation, Message } from '@/lib/db';

const conversation: Conversation = {
  id: 'conv-123',
  title: 'Testing the exporter',
  provider: 'hermes',
  model: 'claude-opus-4',
  systemPrompt: 'Be helpful.',
  createdAt: '2026-04-23T10:00:00.000Z',
  updatedAt: '2026-04-23T10:05:00.000Z',
};

const imageDataUri = 'data:image/png;base64,' + 'A'.repeat(100) + '==';

const messages: Message[] = [
  {
    id: 'm1',
    conversationId: 'conv-123',
    role: 'user',
    content: 'Hello, can you look at this screenshot? ' + imageDataUri,
    timestamp: '2026-04-23T10:00:00.000Z',
  },
  {
    id: 'm2',
    conversationId: 'conv-123',
    role: 'assistant',
    content: 'Let me check the file for you.',
    timestamp: '2026-04-23T10:01:00.000Z',
    toolInvocations: [
      {
        toolCallId: 't1',
        toolName: 'read_file',
        state: 'result',
        args: { path: 'src/index.ts' },
        result: { content: 'export const x = 1;' },
      },
    ],
  },
  {
    id: 'm3',
    conversationId: 'conv-123',
    role: 'assistant',
    content: 'All done.',
    timestamp: '2026-04-23T10:02:00.000Z',
  },
];

describe('formatConversationJson', () => {
  it('produces a schemaVersion 1 payload that round-trips through JSON.parse', () => {
    const raw = formatConversationJson(conversation, messages);
    const parsed = JSON.parse(raw);

    expect(parsed.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(typeof parsed.exportedAt).toBe('string');
    expect(parsed.conversation).toEqual(conversation);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[1].toolInvocations[0].toolName).toBe('read_file');
    expect(parsed.messages[1].toolInvocations[0].args).toEqual({ path: 'src/index.ts' });
  });

  it('strips data-URI images from message content with a byte count placeholder', () => {
    const raw = formatConversationJson(conversation, messages);
    const parsed = JSON.parse(raw);

    expect(parsed.messages[0].content).not.toContain('data:image');
    expect(parsed.messages[0].content).toMatch(/\[image omitted, \d+ bytes\]/);
  });
});

describe('formatConversationMarkdown', () => {
  it('includes title, meta line, and role headers per the spec template', () => {
    const md = formatConversationMarkdown(conversation, messages);

    expect(md).toContain('# Testing the exporter');
    expect(md).toContain('_hermes · claude-opus-4 · 2026-04-23T10:00:00.000Z_');
    expect(md).toContain('## user');
    expect(md).toContain('## assistant');
  });

  it('renders tool invocations in the Tool/Input/Output block format', () => {
    const md = formatConversationMarkdown(conversation, messages);

    expect(md).toContain('> Tool: read_file');
    expect(md).toContain('> Input: `{"path":"src/index.ts"}`');
    expect(md).toContain('> Output: `{"content":"export const x = 1;"}`');
  });

  it('replaces data-URI images in message content with an omitted placeholder', () => {
    const md = formatConversationMarkdown(conversation, messages);

    expect(md).not.toContain('data:image');
    expect(md).toMatch(/\[image omitted, \d+ bytes\]/);
  });

  it('handles image parts that carry a data URI in the image field', () => {
    const withImagePart: Message[] = [
      {
        id: 'mi',
        conversationId: 'conv-123',
        role: 'user',
        content: '',
        timestamp: '2026-04-23T10:00:00.000Z',
        parts: [
          { type: 'text', text: 'Check this out' },
          { type: 'image', image: imageDataUri },
        ],
      },
    ];

    const md = formatConversationMarkdown(conversation, withImagePart);
    expect(md).not.toContain('data:image');
    expect(md).toMatch(/\[image omitted, \d+ bytes\]/);
    expect(md).toContain('Check this out');
  });
});
