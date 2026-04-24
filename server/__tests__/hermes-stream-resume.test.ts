// @vitest-environment node
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetHermesStreamBuffersForTests,
  appendHermesStreamEvent,
  createHermesStreamBuffer,
  finishHermesStream,
} from '../lib/hermes';

async function createTestServer() {
  const { createApp } = await import('../index');
  const app = createApp();
  return await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function parseSseEventBlocks(raw: string): Array<{ id?: string; data: string }> {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const out: { id?: string; data: string } = { data: '' };
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('id:')) out.id = line.slice(3).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      out.data = dataLines.join('\n');
      return out;
    });
}

describe('Hermes SSE resume buffer', () => {
  beforeEach(() => {
    __resetHermesStreamBuffersForTests();
  });

  afterEach(() => {
    __resetHermesStreamBuffersForTests();
  });

  it('POST /api/hermes/chat/start mints a streamId and resumeToken', async () => {
    const server = await createTestServer();
    try {
      const response = await fetch(`${server.url}/api/hermes/chat/start`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await response.json() as { streamId: string; resumeToken: string };
      expect(typeof body.streamId).toBe('string');
      expect(body.streamId.length).toBeGreaterThan(0);
      expect(body.resumeToken).toBe(body.streamId);
    } finally {
      await server.close();
    }
  });

  it('replays only events after `since` when reconnecting', async () => {
    const server = await createTestServer();
    try {
      const entry = createHermesStreamBuffer();
      appendHermesStreamEvent(entry.id, { data: 'first' });
      const second = appendHermesStreamEvent(entry.id, { data: 'second' });
      appendHermesStreamEvent(entry.id, { data: 'third' });
      finishHermesStream(entry.id);

      expect(second).not.toBeNull();

      const response = await fetch(
        `${server.url}/api/hermes/chat/stream?id=${entry.id}&since=${second!.id}`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      const events = parseSseEventBlocks(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('third');
      expect(events[0].id).toBe(String(second!.id + 1));
    } finally {
      await server.close();
    }
  });

  it('returns 410 Gone for an unknown streamId', async () => {
    const server = await createTestServer();
    try {
      const response = await fetch(`${server.url}/api/hermes/chat/stream?id=does-not-exist`);
      expect(response.status).toBe(410);
      const body = await response.json() as { error: string };
      expect(body.error).toMatch(/unknown|expired/);
    } finally {
      await server.close();
    }
  });

  it('replays all buffered events when `since` is absent', async () => {
    const server = await createTestServer();
    try {
      const entry = createHermesStreamBuffer();
      appendHermesStreamEvent(entry.id, { data: 'a' });
      appendHermesStreamEvent(entry.id, { data: 'b' });
      finishHermesStream(entry.id);

      const response = await fetch(`${server.url}/api/hermes/chat/stream?id=${entry.id}`);
      expect(response.status).toBe(200);
      const events = parseSseEventBlocks(await response.text());
      expect(events.map((e) => e.data)).toEqual(['a', 'b']);
    } finally {
      await server.close();
    }
  });
});
