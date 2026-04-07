import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openclawMocks = vi.hoisted(() => ({
  runOpenClawTurn: vi.fn(),
}));

vi.mock('../openclaw', () => ({
  runOpenClawTurn: openclawMocks.runOpenClawTurn,
}));

async function createTestServer() {
  const { createApp } = await import('../index');
  const app = createApp();

  return await new Promise<{
    close: () => Promise<void>;
    url: string;
  }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

describe('translate route', () => {
  const actualFetch = global.fetch;

  beforeEach(() => {
    openclawMocks.runOpenClawTurn.mockReset();
    openclawMocks.runOpenClawTurn.mockResolvedValue({
      text: 'Title: Delivered, but not actually sent\n\nAfter the scheduled cron job runs, the UI shows delivered even though the message never arrived.',
      model: 'openclaw/default',
      durationMs: 42,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('routes OpenClaw translations through the OpenClaw chat turn', async () => {
    const server = await createTestServer();

    try {
      const response = await fetch(`${server.url}/functions/v1/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openclaw',
          model: 'default',
          text: 'Title: 已送达但实际上未送达\n\n定时任务执行后，状态显示 delivered。',
        }),
      });

      const body = await response.json();

      expect(response.ok).toBe(true);
      expect(body.translated).toContain('Title: Delivered, but not actually sent');
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'default',
          message: 'Title: 已送达但实际上未送达\n\n定时任务执行后，状态显示 delivered。',
          systemPrompt: expect.stringContaining('If the input begins with a "Title:" line, preserve that exact structure'),
        }),
      );
    } finally {
      await server.close();
    }
  });

  it('parses Hermes agent-loop SSE translations and uses the Hermes execution header', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.includes('/functions/v1/translate')) {
        return actualFetch(input, init);
      }

      expect((init?.headers as Record<string, string>)['X-Hermes-Execution-Mode']).toBe('agent-loop');

      return new Response([
        'data: {"choices":[{"delta":{"content":[{"type":"text","text":"Title: Delivered, but not actually sent"}]}}]}\n\n',
        'data: {"choices":[{"delta":{"content":[{"type":"text","text":"\\n\\nAfter the cron job finishes, the UI shows delivered even though the message never arrived."}]}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }));

    const server = await createTestServer();

    try {
      const response = await actualFetch(`${server.url}/functions/v1/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'hermes',
          api_key: 'or-key',
          model: 'meta-llama/llama-4-maverick',
          text: 'Title: 已送达但实际上未送达\n\n定时任务执行后，状态显示 delivered。',
        }),
      });

      const body = await response.json();

      expect(response.ok).toBe(true);
      expect(body.translated).toBe(
        'Title: Delivered, but not actually sent\n\nAfter the cron job finishes, the UI shows delivered even though the message never arrived.',
      );
    } finally {
      await server.close();
    }
  });
});
