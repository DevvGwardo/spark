import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';

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

const baseConversation = {
  title: 'Tag me',
  provider: 'openai',
  model: 'gpt-5.2',
  systemPrompt: 'You are a helpful assistant.',
  createdAt: '2026-03-12T10:00:00.000Z',
  updatedAt: '2026-03-12T10:00:00.000Z',
  pinned: false,
};

describe('chat store tags', () => {
  it('round-trips tags through the PATCH endpoint', async () => {
    const server = await createTestServer();

    try {
      const createResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseConversation, id: 'tag-1' }),
      });
      expect(createResponse.status).toBe(201);

      // New conversation should default to tags: []
      const initialList = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations`)
      ).json();
      const initial = initialList.conversations.find((c: { id: string }) => c.id === 'tag-1');
      expect(initial).toBeDefined();
      expect(initial.tags).toEqual([]);

      // PATCH with tags
      const patchResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/tag-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: ['prod', 'scratch'] }),
        },
      );
      expect(patchResponse.status).toBe(200);

      const afterPatch = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations`)
      ).json();
      const tagged = afterPatch.conversations.find((c: { id: string }) => c.id === 'tag-1');
      expect(tagged.tags).toEqual(['prod', 'scratch']);

      // PATCH clearing tags
      const clearResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/tag-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: [] }),
        },
      );
      expect(clearResponse.status).toBe(200);

      const afterClear = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations`)
      ).json();
      const cleared = afterClear.conversations.find((c: { id: string }) => c.id === 'tag-1');
      expect(cleared.tags).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('defaults tags to [] for legacy rows with null/invalid JSON in the column', async () => {
    // Point the store at a temp file DB so we can write invalid JSON directly.
    const path = await import('node:path');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudchat-tags-'));
    const dbPath = path.join(tmpDir, 'cloudchat.sqlite');
    process.env.CLOUDCHAT_DB_PATH = dbPath;

    try {
      const server = await createTestServer();
      try {
        const createResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...baseConversation, id: 'tag-legacy' }),
        });
        expect(createResponse.status).toBe(201);

        // Write garbage into the tags column to simulate corrupt/legacy data.
        const { DatabaseSync } = await import('node:sqlite');
        const raw = new DatabaseSync(dbPath);
        raw.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run('not-json', 'tag-legacy');
        raw.prepare('UPDATE conversations SET tags = NULL WHERE id = ?').run('tag-legacy');
        raw.close();
      } finally {
        await server.close();
      }

      // Reopen the server so it re-reads the DB file.
      const server2 = await createTestServer();
      try {
        const list = await (
          await fetch(`${server2.url}/functions/v1/chat-store/conversations`)
        ).json();
        const row = list.conversations.find((c: { id: string }) => c.id === 'tag-legacy');
        expect(row.tags).toEqual([]);
      } finally {
        await server2.close();
      }
    } finally {
      delete process.env.CLOUDCHAT_DB_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
