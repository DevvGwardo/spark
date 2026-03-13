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

describe('chat store routes', () => {
  it('persists conversations, messages, and conversation files', async () => {
    const server = await createTestServer();
    const conversation = {
      id: 'conv-1',
      title: 'First thread',
      provider: 'openai',
      model: 'gpt-5.2',
      systemPrompt: 'You are a helpful assistant.',
      createdAt: '2026-03-12T10:00:00.000Z',
      updatedAt: '2026-03-12T10:00:00.000Z',
      pinned: false,
    };
    const message = {
      id: 'msg-1',
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
      timestamp: '2026-03-12T10:01:00.000Z',
      parts: [{ type: 'text', text: 'hello' }],
    };
    const conversationFiles = {
      conversationId: conversation.id,
      changeset: {
        activeRepo: null,
        isRepoMode: false,
        changes: {},
        repoFileTree: [],
      },
      preview: {
        files: [],
        activeFileId: null,
        projectType: 'react',
      },
      repoFileCache: {
        'src/App.tsx': 'export default function App() {}',
      },
    };

    try {
      const createConversationResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(conversation),
      });
      expect(createConversationResponse.status).toBe(201);

      const createMessageResponse = await fetch(`${server.url}/functions/v1/chat-store/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });
      expect(createMessageResponse.status).toBe(201);

      const saveFilesResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/${conversation.id}/files`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(conversationFiles),
        },
      );
      expect(saveFilesResponse.status).toBe(204);

      const conversationsResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations`);
      const conversationsBody = await conversationsResponse.json();
      expect(conversationsResponse.ok).toBe(true);
      expect(conversationsBody.conversations).toHaveLength(1);
      expect(conversationsBody.conversations[0]).toMatchObject(conversation);

      const messagesResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/${conversation.id}/messages`,
      );
      const messagesBody = await messagesResponse.json();
      expect(messagesResponse.ok).toBe(true);
      expect(messagesBody.messages).toEqual([message]);

      const filesResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/${conversation.id}/files`,
      );
      const filesBody = await filesResponse.json();
      expect(filesResponse.ok).toBe(true);
      expect(filesBody.conversationFiles).toEqual(conversationFiles);
    } finally {
      await server.close();
    }
  });

  it('updates and deletes persisted chat records', async () => {
    const server = await createTestServer();

    try {
      await fetch(`${server.url}/functions/v1/chat-store/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'conv-2',
          title: 'Original title',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
          systemPrompt: 'System prompt',
          createdAt: '2026-03-12T11:00:00.000Z',
          updatedAt: '2026-03-12T11:00:00.000Z',
          pinned: false,
        }),
      });

      await fetch(`${server.url}/functions/v1/chat-store/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'msg-2',
          conversationId: 'conv-2',
          role: 'assistant',
          content: 'draft',
          timestamp: '2026-03-12T11:01:00.000Z',
          toolInvocations: [{ toolName: 'read_repo_file', state: 'result' }],
        }),
      });

      const updateConversationResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/conv-2`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: 'Renamed thread',
            pinned: true,
            updatedAt: '2026-03-12T11:05:00.000Z',
          }),
        },
      );
      expect(updateConversationResponse.status).toBe(204);

      const updateMessageResponse = await fetch(
        `${server.url}/functions/v1/chat-store/messages/msg-2`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: 'final answer',
            error: 'none',
          }),
        },
      );
      expect(updateMessageResponse.status).toBe(204);

      const messagesResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations/conv-2/messages`);
      const messagesBody = await messagesResponse.json();
      expect(messagesBody.messages[0]).toMatchObject({
        id: 'msg-2',
        content: 'final answer',
        error: 'none',
      });

      const deleteConversationResponse = await fetch(
        `${server.url}/functions/v1/chat-store/conversations/conv-2`,
        {
          method: 'DELETE',
        },
      );
      expect(deleteConversationResponse.status).toBe(204);

      const conversationsResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations`);
      const conversationsBody = await conversationsResponse.json();
      expect(conversationsBody.conversations).toEqual([]);

      const deletedMessagesResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations/conv-2/messages`);
      const deletedMessagesBody = await deletedMessagesResponse.json();
      expect(deletedMessagesBody.messages).toEqual([]);

      const deletedFilesResponse = await fetch(`${server.url}/functions/v1/chat-store/conversations/conv-2/files`);
      expect(deletedFilesResponse.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
