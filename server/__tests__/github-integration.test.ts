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

describe('github integration route', () => {
  it('rejects requests without action', async () => {
    const server = await createTestServer();
    try {
      const r = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: string };
      expect(body.error).toBeDefined();
      expect(body.error).toContain('PAT');
    } finally {
      await server.close();
    }
  });

  it('rejects repo listing without valid PAT', async () => {
    const server = await createTestServer();
    try {
      const r = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list-repos', github_pat: 'invalid-token' }),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: string };
      expect(body.error).toContain('PAT');
    } finally {
      await server.close();
    }
  });

  it('requires github_pat for repo listing', async () => {
    const server = await createTestServer();
    try {
      const r = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list-repos' }),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: string };
      expect(body.error).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
