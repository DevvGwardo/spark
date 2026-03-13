import type express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Conversation,
  ConversationFiles,
  Message,
} from '../src/lib/db';

interface ConversationRow {
  id: string;
  title: string;
  provider: string;
  model: string;
  system_prompt: string;
  created_at: string;
  updated_at: string;
  pinned: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Message['role'];
  content: string;
  timestamp: string;
  token_count: number | null;
  error: string | null;
  parts_json: string | null;
  tool_invocations_json: string | null;
}

interface ConversationFilesRow {
  conversation_id: string;
  data_json: string;
}

function isConstraintError(error: unknown): error is Error {
  return error instanceof Error && /constraint/i.test(error.message);
}

function isNotFoundError(error: unknown): error is Error {
  return error instanceof Error && /not found/i.test(error.message);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
  };
}

function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
  };

  if (typeof row.token_count === 'number') {
    message.tokenCount = row.token_count;
  }

  if (typeof row.error === 'string') {
    message.error = row.error;
  }

  const parts = parseJson<unknown[] | undefined>(row.parts_json, undefined);
  if (parts) {
    message.parts = parts;
  }

  const toolInvocations = parseJson<unknown[] | undefined>(row.tool_invocations_json, undefined);
  if (toolInvocations) {
    message.toolInvocations = toolInvocations;
  }

  return message;
}

function resolveDbPath(): string {
  if (process.env.CLOUDCHAT_DB_PATH) {
    return process.env.CLOUDCHAT_DB_PATH;
  }

  if (process.env.VITEST) {
    return ':memory:';
  }

  if (process.env.CLOUDCHAT_USER_DATA_DIR) {
    return join(process.env.CLOUDCHAT_USER_DATA_DIR, 'cloudchat.sqlite');
  }

  return join(homedir(), '.cloudchat', 'cloudchat.sqlite');
}

function ensureParentDirectory(dbPath: string) {
  if (dbPath === ':memory:') {
    return;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
}

function createChatStore(dbPath = resolveDbPath()) {
  ensureParentDirectory(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      token_count INTEGER,
      error TEXT,
      parts_json TEXT,
      tool_invocations_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      ON messages (conversation_id);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
      ON messages (conversation_id, timestamp);

    CREATE TABLE IF NOT EXISTS conversation_files (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      data_json TEXT NOT NULL
    );
  `);

  const listConversationsStmt = db.prepare(`
    SELECT id, title, provider, model, system_prompt, created_at, updated_at, pinned
    FROM conversations
    ORDER BY pinned DESC, updated_at DESC
  `);
  const insertConversationStmt = db.prepare(`
    INSERT INTO conversations (
      id, title, provider, model, system_prompt, created_at, updated_at, pinned
    ) VALUES (
      :id, :title, :provider, :model, :systemPrompt, :createdAt, :updatedAt, :pinned
    )
  `);
  const getConversationStmt = db.prepare(`
    SELECT id, title, provider, model, system_prompt, created_at, updated_at, pinned
    FROM conversations
    WHERE id = :id
  `);
  const updateConversationStmt = db.prepare(`
    UPDATE conversations
    SET
      title = :title,
      provider = :provider,
      model = :model,
      system_prompt = :systemPrompt,
      created_at = :createdAt,
      updated_at = :updatedAt,
      pinned = :pinned
    WHERE id = :id
  `);
  const deleteConversationStmt = db.prepare(`
    DELETE FROM conversations
    WHERE id = :id
  `);

  const listMessagesStmt = db.prepare(`
    SELECT
      id,
      conversation_id,
      role,
      content,
      timestamp,
      token_count,
      error,
      parts_json,
      tool_invocations_json
    FROM messages
    WHERE conversation_id = :conversationId
    ORDER BY timestamp ASC
  `);
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      id,
      conversation_id,
      role,
      content,
      timestamp,
      token_count,
      error,
      parts_json,
      tool_invocations_json
    ) VALUES (
      :id,
      :conversationId,
      :role,
      :content,
      :timestamp,
      :tokenCount,
      :error,
      :partsJson,
      :toolInvocationsJson
    )
  `);
  const getMessageStmt = db.prepare(`
    SELECT
      id,
      conversation_id,
      role,
      content,
      timestamp,
      token_count,
      error,
      parts_json,
      tool_invocations_json
    FROM messages
    WHERE id = :id
  `);
  const updateMessageStmt = db.prepare(`
    UPDATE messages
    SET
      conversation_id = :conversationId,
      role = :role,
      content = :content,
      timestamp = :timestamp,
      token_count = :tokenCount,
      error = :error,
      parts_json = :partsJson,
      tool_invocations_json = :toolInvocationsJson
    WHERE id = :id
  `);
  const deleteMessagesByConversationStmt = db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = :conversationId
  `);

  const getConversationFilesStmt = db.prepare(`
    SELECT conversation_id, data_json
    FROM conversation_files
    WHERE conversation_id = :conversationId
  `);
  const saveConversationFilesStmt = db.prepare(`
    INSERT INTO conversation_files (conversation_id, data_json)
    VALUES (:conversationId, :dataJson)
    ON CONFLICT(conversation_id) DO UPDATE SET data_json = excluded.data_json
  `);
  const deleteConversationFilesStmt = db.prepare(`
    DELETE FROM conversation_files
    WHERE conversation_id = :conversationId
  `);

  return {
    listConversations(): Conversation[] {
      return (listConversationsStmt.all() as ConversationRow[]).map(toConversation);
    },

    addConversation(conversation: Conversation) {
      insertConversationStmt.run({
        id: conversation.id,
        title: conversation.title,
        provider: conversation.provider,
        model: conversation.model,
        systemPrompt: conversation.systemPrompt,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        pinned: conversation.pinned ? 1 : 0,
      });
    },

    updateConversation(id: string, fields: Partial<Conversation>) {
      const existing = getConversationStmt.get({ id }) as ConversationRow | undefined;
      if (!existing) {
        return;
      }

      const next = {
        ...toConversation(existing),
        ...fields,
      };

      updateConversationStmt.run({
        id,
        title: next.title,
        provider: next.provider,
        model: next.model,
        systemPrompt: next.systemPrompt,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
        pinned: next.pinned ? 1 : 0,
      });
    },

    deleteConversation(id: string) {
      deleteConversationStmt.run({ id });
    },

    listMessages(conversationId: string): Message[] {
      return (listMessagesStmt.all({ conversationId }) as MessageRow[]).map(toMessage);
    },

    addMessage(message: Message) {
      insertMessageStmt.run({
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        tokenCount: typeof message.tokenCount === 'number' ? message.tokenCount : null,
        error: message.error ?? null,
        partsJson: message.parts ? JSON.stringify(message.parts) : null,
        toolInvocationsJson: message.toolInvocations ? JSON.stringify(message.toolInvocations) : null,
      });
    },

    updateMessage(id: string, fields: Partial<Message>) {
      const existing = getMessageStmt.get({ id }) as MessageRow | undefined;
      if (!existing) {
        return;
      }

      const next = {
        ...toMessage(existing),
        ...fields,
      };

      updateMessageStmt.run({
        id,
        conversationId: next.conversationId,
        role: next.role,
        content: next.content,
        timestamp: next.timestamp,
        tokenCount: typeof next.tokenCount === 'number' ? next.tokenCount : null,
        error: next.error ?? null,
        partsJson: next.parts ? JSON.stringify(next.parts) : null,
        toolInvocationsJson: next.toolInvocations ? JSON.stringify(next.toolInvocations) : null,
      });
    },

    deleteMessagesByConversation(conversationId: string) {
      deleteMessagesByConversationStmt.run({ conversationId });
    },

    getConversationFiles(conversationId: string): ConversationFiles | undefined {
      const row = getConversationFilesStmt.get({ conversationId }) as ConversationFilesRow | undefined;
      if (!row) {
        return undefined;
      }

      return parseJson<ConversationFiles | undefined>(row.data_json, undefined);
    },

    saveConversationFiles(data: ConversationFiles) {
      const existing = getConversationStmt.get({ id: data.conversationId }) as ConversationRow | undefined;
      if (!existing) {
        throw new Error(`Conversation ${data.conversationId} not found`);
      }

      saveConversationFilesStmt.run({
        conversationId: data.conversationId,
        dataJson: JSON.stringify(data),
      });
    },

    deleteConversationFiles(conversationId: string) {
      deleteConversationFilesStmt.run({ conversationId });
    },
  };
}

export function registerChatStoreRoutes(app: express.Express) {
  const chatStore = createChatStore();

  app.get('/functions/v1/chat-store/conversations', (_req, res) => {
    res.json({ conversations: chatStore.listConversations() });
  });

  app.post('/functions/v1/chat-store/conversations', (req, res) => {
    try {
      chatStore.addConversation(req.body as Conversation);
      res.status(201).json({ ok: true });
    } catch (error) {
      if (isConstraintError(error)) {
        res.status(409).json({ error: 'Conversation already exists' });
        return;
      }

      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch('/functions/v1/chat-store/conversations/:id', (req, res) => {
    try {
      chatStore.updateConversation(req.params.id, req.body as Partial<Conversation>);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/functions/v1/chat-store/conversations/:id', (req, res) => {
    try {
      chatStore.deleteConversation(req.params.id);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/functions/v1/chat-store/conversations/:id/messages', (req, res) => {
    res.json({ messages: chatStore.listMessages(req.params.id) });
  });

  app.post('/functions/v1/chat-store/messages', (req, res) => {
    try {
      chatStore.addMessage(req.body as Message);
      res.status(201).json({ ok: true });
    } catch (error) {
      if (isConstraintError(error)) {
        res.status(409).json({ error: 'Message already exists' });
        return;
      }

      if (isNotFoundError(error)) {
        res.status(404).json({ error: error.message });
        return;
      }

      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch('/functions/v1/chat-store/messages/:id', (req, res) => {
    try {
      chatStore.updateMessage(req.params.id, req.body as Partial<Message>);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/functions/v1/chat-store/conversations/:id/messages', (req, res) => {
    try {
      chatStore.deleteMessagesByConversation(req.params.id);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/functions/v1/chat-store/conversations/:id/files', (req, res) => {
    try {
      const files = chatStore.getConversationFiles(req.params.id);
      if (!files) {
        res.status(404).json({ error: 'Conversation files not found' });
        return;
      }

      res.json({ conversationFiles: files });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/functions/v1/chat-store/conversations/:id/files', (req, res) => {
    try {
      const payload = req.body as ConversationFiles;
      chatStore.saveConversationFiles({
        ...payload,
        conversationId: req.params.id,
      });
      res.status(204).end();
    } catch (error) {
      if (isNotFoundError(error)) {
        res.status(404).json({ error: error.message });
        return;
      }

      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/functions/v1/chat-store/conversations/:id/files', (req, res) => {
    try {
      chatStore.deleteConversationFiles(req.params.id);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
