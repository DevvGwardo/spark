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
  title: 'Archive me',
  provider: 'openai',
  model: 'gpt-5.2',
  systemPrompt: 'You are a helpful assistant.',
  createdAt: '2026-03-12T10:00:00.000Z',
  updatedAt: '2026-03-12T10:00:00.000Z',
  pinned: false,
};

describe('chat store archive', () => {
  it('hides archived conversations from the default list and exposes them under archivedOnly', async () => {
    const server = await createTestServer();

    try {
      for (const id of ['arc-1', 'arc-2']) {
        const response = await fetch(`${server.url}/functions/v1/chat-store/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...baseConversation, id }),
        });
        expect(response.status).toBe(201);
      }

      const archiveResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/arc-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archivedAt: '2026-03-13T09:00:00.000Z' }),
        },
      );
      expect(archiveResponse.status).toBe(200);

      const defaultList = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations`)
      ).json();
      expect(defaultList.conversations.map((c: { id: string }) => c.id)).toEqual(['arc-2']);
      expect(defaultList.total).toBe(1);

      const archivedOnlyList = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations?archivedOnly=1`)
      ).json();
      expect(archivedOnlyList.conversations).toHaveLength(1);
      expect(archivedOnlyList.conversations[0]).toMatchObject({
        id: 'arc-1',
        archivedAt: '2026-03-13T09:00:00.000Z',
      });

      const includeArchivedList = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations?includeArchived=1`)
      ).json();
      expect(includeArchivedList.conversations.map((c: { id: string }) => c.id).sort()).toEqual([
        'arc-1',
        'arc-2',
      ]);

      const unarchiveResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/arc-1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archivedAt: null }),
        },
      );
      expect(unarchiveResponse.status).toBe(200);

      const afterUnarchive = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations`)
      ).json();
      expect(afterUnarchive.conversations.map((c: { id: string }) => c.id).sort()).toEqual([
        'arc-1',
        'arc-2',
      ]);

      const afterUnarchiveArchived = await (
        await fetch(`${server.url}/functions/v1/chat-store/conversations?archivedOnly=1`)
      ).json();
      expect(afterUnarchiveArchived.conversations).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
