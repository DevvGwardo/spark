import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCompactionSummaryMessage,
  requestCompaction,
  COMPACTION_SUMMARY_PREFIX,
} from '@/lib/compaction-client';

const MESSAGES = [
  { role: 'user', content: 'add a find bar to the mini browser' },
  { role: 'assistant', content: 'done, wired through IPC' },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('requestCompaction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the conversation and returns the summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ summary: '  goal: add find bar  ', tokensBefore: 1200, tokensAfter: 40, threshold: 0.95 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestCompaction({
      provider: 'anthropic',
      model: 'some-model',
      apiKey: 'sk-test',
      messages: MESSAGES,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/functions/v1/compact');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual(MESSAGES);
    expect(body.provider).toBe('anthropic');
    expect(body.model).toBe('some-model');
    expect(body.api_key).toBe('sk-test');

    expect(result.summary).toBe('goal: add find bar');
    expect(result.tokensBefore).toBe(1200);
    expect(result.tokensAfter).toBe(40);
    expect(result.threshold).toBe(0.95);
  });

  it('omits api_key and threshold when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ summary: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    await requestCompaction({ provider: 'openai', model: 'm', messages: MESSAGES });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('api_key');
    expect(body).not.toHaveProperty('threshold');
  });

  it('passes threshold through when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ summary: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    await requestCompaction({ provider: 'openai', model: 'm', messages: MESSAGES, threshold: 0.8 });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.threshold).toBe(0.8);
  });

  it("throws the server's error message on a failed request", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'Provider API error: nope' }, 502)),
    );

    await expect(
      requestCompaction({ provider: 'openai', model: 'm', messages: MESSAGES }),
    ).rejects.toThrow('Provider API error: nope');
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 504 })),
    );

    await expect(
      requestCompaction({ provider: 'openai', model: 'm', messages: MESSAGES }),
    ).rejects.toThrow('Compaction failed (504)');
  });

  it('rejects an empty summary rather than blanking the history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ summary: '   ' })));

    await expect(
      requestCompaction({ provider: 'openai', model: 'm', messages: MESSAGES }),
    ).rejects.toThrow('Compaction returned an empty summary');
  });

  it('treats missing numeric fields as zero instead of NaN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ summary: 'ok' })));

    const result = await requestCompaction({ provider: 'openai', model: 'm', messages: MESSAGES });
    expect(result.tokensBefore).toBe(0);
    expect(result.tokensAfter).toBe(0);
    expect(result.threshold).toBe(0);
  });
});

describe('buildCompactionSummaryMessage', () => {
  it('wraps the summary in a single user message', () => {
    const message = buildCompactionSummaryMessage('  goal: ship it  ');
    expect(message.role).toBe('user');
    expect(message.content).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(message.content).toContain('goal: ship it');
    // Trimmed, not padded with the caller's whitespace.
    expect(message.content.endsWith('goal: ship it')).toBe(true);
  });
});
