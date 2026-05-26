// @vitest-environment node
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';

async function createTestServer() {
  const { createApp } = await import('../index');
  const app = createApp();
  return new Promise<{ close: () => Promise<void>; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r, rj) => server.close((e) => (e ? rj(e) : r()))),
      });
    });
  });
}

describe('chat route validation', () => {
  it('health endpoint returns 200 and ok=true', async () => {
    const server = await createTestServer();
    try {
      const r = await fetch(`${server.url}/functions/v1/health`);
      expect(r.status).toBe(200);
      const body = await r.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('chat endpoint rejects missing provider', async () => {
    const server = await createTestServer();
    try {
      const r = await fetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: string };
      expect(body.error).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('chat endpoint rejects missing messages', async () => {
    const server = await createTestServer();
    try {
      const r = await fetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: string };
      expect(body.error).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
