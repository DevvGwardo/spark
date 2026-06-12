import { logger } from './lib/logger';
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
  lines_added: number;
  lines_removed: number;
  original_created_at: string | null;
  archived_at: string | null;
  tags: string | null;
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
  const conversation: Conversation = {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    linesAdded: row.lines_added || 0,
    linesRemoved: row.lines_removed || 0,
  };

  if (typeof row.original_created_at === 'string') {
    conversation.originalCreatedAt = row.original_created_at;
  }

  if (typeof row.archived_at === 'string') {
    conversation.archivedAt = row.archived_at;
  }

  const tags = parseJson<string[]>(row.tags, []);
  conversation.tags = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];

  return conversation;
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

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    lines_added INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    original_created_at TEXT,
    archived_at TEXT,
    tags TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_active_list
    ON conversations (archived_at, pinned, updated_at);

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
`;

const SQL = {
  listConversations: `
    SELECT id, title, provider, model, system_prompt, created_at, updated_at, pinned, lines_added, lines_removed, original_created_at, archived_at, tags
    FROM conversations
    WHERE archived_at IS NULL
    ORDER BY pinned DESC, updated_at DESC
    LIMIT :limit OFFSET :offset
  `,
  listConversationsAll: `
    SELECT id, title, provider, model, system_prompt, created_at, updated_at, pinned, lines_added, lines_removed, original_created_at, archived_at, tags
    FROM conversations
    ORDER BY pinned DESC, updated_at DESC
    LIMIT :limit OFFSET :offset
  `,
  listConversationsArchived: `
    SELECT id, title, provider, model, system_prompt, created_at, updated_at, pinned, lines_added, lines_removed, original_created_at, archived_at, tags
    FROM conversations
    WHERE archived_at IS NOT NULL
    ORDER BY archived_at DESC
    LIMIT :limit OFFSET :offset
  `,
  countConversations: `
    SELECT COUNT(*) as total FROM conversations WHERE archived_at IS NULL
  `,
  countConversationsAll: `
    SELECT COUNT(*) as total FROM conversations
  `,
  countConversationsArchived: `
    SELECT COUNT(*) as total FROM conversations WHERE archived_at IS NOT NULL
  `,
  insertConversation: `
    INSERT INTO conversations (
      id, title, provider, model, system_prompt, created_at, updated_at, pinned, lines_added, lines_removed, original_created_at, archived_at, tags
    ) VALUES (
      :id, :title, :provider, :model, :systemPrompt, :createdAt, :updatedAt, :pinned, :linesAdded, :linesRemoved, :originalCreatedAt, :archivedAt, :tags
    )
  `,
  getConversation: `
    SELECT id, title, provider, model, system_prompt, created_at, updated_at, pinned, lines_added, lines_removed, original_created_at, archived_at, tags
    FROM conversations
    WHERE id = :id
  `,
  updateConversation: `
    UPDATE conversations
    SET
      title = :title,
      provider = :provider,
      model = :model,
      system_prompt = :systemPrompt,
      created_at = :createdAt,
      updated_at = :updatedAt,
      pinned = :pinned,
      lines_added = :linesAdded,
      lines_removed = :linesRemoved,
      original_created_at = :originalCreatedAt,
      archived_at = :archivedAt,
      tags = :tags
    WHERE id = :id
  `,
  deleteConversation: `
    DELETE FROM conversations
    WHERE id = :id
  `,
  listMessages: `
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
  `,
  saveMessage: `
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
    ON CONFLICT(id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      role = excluded.role,
      content = excluded.content,
      timestamp = excluded.timestamp,
      token_count = excluded.token_count,
      error = excluded.error,
      parts_json = excluded.parts_json,
      tool_invocations_json = excluded.tool_invocations_json
  `,
  getMessage: `
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
  `,
  updateMessage: `
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
  `,
  deleteMessagesByConversation: `
    DELETE FROM messages
    WHERE conversation_id = :conversationId
  `,
  getConversationFiles: `
    SELECT conversation_id, data_json
    FROM conversation_files
    WHERE conversation_id = :conversationId
  `,
  saveConversationFiles: `
    INSERT INTO conversation_files (conversation_id, data_json)
    VALUES (:conversationId, :dataJson)
    ON CONFLICT(conversation_id) DO UPDATE SET data_json = excluded.data_json
  `,
  deleteConversationFiles: `
    DELETE FROM conversation_files
    WHERE conversation_id = :conversationId
  `,
} as const;

type StmtCache = Record<keyof typeof SQL, ReturnType<DatabaseSync['prepare']>>;

function isStatementFinalized(error: unknown): boolean {
  return error instanceof Error && /finalized/i.test(error.message);
}

function createChatStore(dbPath = resolveDbPath()) {
  ensureParentDirectory(dbPath);

  let db: DatabaseSync;
  let stmts: StmtCache;

  function migrateColumns() {
    // Add lines_added/lines_removed columns if they don't exist (for existing databases)
    const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('lines_added')) {
      try {
        db.exec('ALTER TABLE conversations ADD COLUMN lines_added INTEGER NOT NULL DEFAULT 0');
      } catch (error) {
        logger.warn('[chat-store] Failed to add lines_added column: ' + String(error instanceof Error ? error.message : String(error)));
      }
    }
    if (!colNames.has('lines_removed')) {
      try {
        db.exec('ALTER TABLE conversations ADD COLUMN lines_removed INTEGER NOT NULL DEFAULT 0');
      } catch (error) {
        logger.warn('[chat-store] Failed to add lines_removed column: ' + String(error instanceof Error ? error.message : String(error)));
      }
    }
    if (!colNames.has('original_created_at')) {
      try {
        db.exec('ALTER TABLE conversations ADD COLUMN original_created_at TEXT');
      } catch (error) {
        logger.warn('[chat-store] Failed to add original_created_at column: ' + String(error instanceof Error ? error.message : String(error)));
      }
    }
    if (!colNames.has('archived_at')) {
      try {
        db.exec('ALTER TABLE conversations ADD COLUMN archived_at TEXT');
      } catch (error) {
        logger.warn('[chat-store] Failed to add archived_at column: ' + String(error instanceof Error ? error.message : String(error)));
      }
    }
    if (!colNames.has('tags')) {
      try {
        db.exec('ALTER TABLE conversations ADD COLUMN tags TEXT');
      } catch (error) {
        logger.warn('[chat-store] Failed to add tags column: ' + String(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  function openDb() {
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    migrateColumns();
    stmts = Object.fromEntries(
      Object.entries(SQL).map(([key, sql]) => [key, db.prepare(sql)]),
    ) as StmtCache;
  }

  function stmt<K extends keyof typeof SQL>(key: K): StmtCache[K] {
    return stmts[key];
  }

  /** Run a callback, auto-reconnecting once if statements have been finalized. */
  function run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (isStatementFinalized(error)) {
        logger.warn('[chat-store] Prepared statement finalized — reconnecting to database');
        openDb();
        return fn();
      }
      throw error;
    }
  }

  openDb();

  return {
    listConversations(
      limit = 50,
      offset = 0,
      options: { includeArchived?: boolean; archivedOnly?: boolean } = {},
    ): { conversations: Conversation[]; total: number } {
      return run(() => {
        const listKey = options.archivedOnly
          ? 'listConversationsArchived'
          : options.includeArchived
            ? 'listConversationsAll'
            : 'listConversations';
        const countKey = options.archivedOnly
          ? 'countConversationsArchived'
          : options.includeArchived
            ? 'countConversationsAll'
            : 'countConversations';
        const rows = stmt(listKey).all({ limit, offset }) as unknown as ConversationRow[];
        const countRow = stmt(countKey).get() as unknown as { total: number };
        return {
          conversations: rows.map(toConversation),
          total: countRow.total,
        };
      });
    },

    addConversation(conversation: Conversation) {
      run(() => stmt('insertConversation').run({
        id: conversation.id,
        title: conversation.title,
        provider: conversation.provider,
        model: conversation.model,
        systemPrompt: conversation.systemPrompt,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        pinned: conversation.pinned ? 1 : 0,
        linesAdded: conversation.linesAdded ?? 0,
        linesRemoved: conversation.linesRemoved ?? 0,
        originalCreatedAt: conversation.originalCreatedAt ?? null,
        archivedAt: conversation.archivedAt ?? null,
        tags: JSON.stringify(conversation.tags ?? []),
      }));
    },

    importConversation(conversation: Conversation, messages: Message[]): Conversation {
      return run(() => {
        db.exec('BEGIN');
        try {
          stmt('insertConversation').run({
            id: conversation.id,
            title: conversation.title,
            provider: conversation.provider,
            model: conversation.model,
            systemPrompt: conversation.systemPrompt,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            pinned: conversation.pinned ? 1 : 0,
            linesAdded: conversation.linesAdded ?? 0,
            linesRemoved: conversation.linesRemoved ?? 0,
            originalCreatedAt: conversation.originalCreatedAt ?? null,
            archivedAt: conversation.archivedAt ?? null,
            tags: JSON.stringify(conversation.tags ?? []),
          });

          for (const message of messages) {
            stmt('saveMessage').run({
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
          }

          db.exec('COMMIT');
          return conversation;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },

    updateConversation(id: string, fields: Partial<Conversation>): boolean {
      return run(() => {
        db.exec('BEGIN');
        try {
          const existing = stmt('getConversation').get({ id }) as unknown as ConversationRow | undefined;
          if (!existing) {
            db.exec('COMMIT');
            return false;
          }

          const next = {
            ...toConversation(existing),
            ...fields,
          };

          stmt('updateConversation').run({
            id,
            title: next.title,
            provider: next.provider,
            model: next.model,
            systemPrompt: next.systemPrompt,
            createdAt: next.createdAt,
            updatedAt: next.updatedAt,
            pinned: next.pinned ? 1 : 0,
            linesAdded: next.linesAdded ?? 0,
            linesRemoved: next.linesRemoved ?? 0,
            originalCreatedAt: next.originalCreatedAt ?? null,
            archivedAt: next.archivedAt ?? null,
            tags: JSON.stringify(next.tags ?? []),
          });
          db.exec('COMMIT');
          return true;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },

    deleteConversation(id: string) {
      run(() => stmt('deleteConversation').run({ id }));
    },

    listMessages(conversationId: string): Message[] {
      return run(() => (stmt('listMessages').all({ conversationId }) as unknown as MessageRow[]).map(toMessage));
    },

    addMessage(message: Message) {
      run(() => {
        db.exec('BEGIN');
        try {
          const existingConversation = stmt('getConversation').get({ id: message.conversationId }) as unknown as ConversationRow | undefined;
          if (!existingConversation) {
            throw new Error(`Conversation ${message.conversationId} not found`);
          }

          stmt('saveMessage').run({
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
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },

    updateMessage(id: string, fields: Partial<Message>): boolean {
      return run(() => {
        db.exec('BEGIN');
        try {
          const existing = stmt('getMessage').get({ id }) as unknown as MessageRow | undefined;
          if (!existing) {
            db.exec('COMMIT');
            return false;
          }

          const next = {
            ...toMessage(existing),
            ...fields,
          };

          stmt('updateMessage').run({
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
          db.exec('COMMIT');
          return true;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },

    deleteMessagesByConversation(conversationId: string) {
      run(() => stmt('deleteMessagesByConversation').run({ conversationId }));
    },

    getConversationFiles(conversationId: string): ConversationFiles | undefined {
      return run(() => {
        const row = stmt('getConversationFiles').get({ conversationId }) as unknown as ConversationFilesRow | undefined;
        if (!row) {
          return undefined;
        }

        return parseJson<ConversationFiles | undefined>(row.data_json, undefined);
      });
    },

    saveConversationFiles(data: ConversationFiles) {
      run(() => {
        db.exec('BEGIN');
        try {
          const existing = stmt('getConversation').get({ id: data.conversationId }) as unknown as ConversationRow | undefined;
          if (!existing) {
            throw new Error(`Conversation ${data.conversationId} not found`);
          }

          stmt('saveConversationFiles').run({
            conversationId: data.conversationId,
            dataJson: JSON.stringify(data),
          });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },

    deleteConversationFiles(conversationId: string) {
      run(() => stmt('deleteConversationFiles').run({ conversationId }));
    },

    close() {
      try {
        db.close();
      } catch (error) {
        logger.warn(`[chat-store] Error closing database: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;

// Shared store instance so server-side code (e.g. background hermes session
// continuation) writes to the same SQLite connection as the HTTP routes.
let sharedChatStore: ChatStore | null = null;
let sharedChatStorePath: string | null = null;
export function getChatStore(): ChatStore {
  // Re-create when the resolved path changes (tests point CLOUDCHAT_DB_PATH
  // at a fresh temp DB per test; in production the path never changes).
  const dbPath = resolveDbPath();
  // An in-memory DB (vitest default) must stay per-instance — sharing it
  // would leak rows across test servers.
  if (dbPath === ':memory:') {
    return createChatStore(dbPath);
  }
  if (!sharedChatStore || sharedChatStorePath !== dbPath) {
    sharedChatStore = createChatStore(dbPath);
    sharedChatStorePath = dbPath;
  }
  return sharedChatStore;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function registerChatStoreRoutes(app: express.Express) {
  const chatStore = getChatStore();

  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    // During app quit the pino transport worker may already be torn down, so a
    // log here can throw "the worker is ending". Never let that abort the DB
    // close (or surface as an uncaught exception).
    try { logger.info('[chat-store] Closing database connection'); } catch { /* logger already closed */ }
    chatStore.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.get('/functions/v1/chat-store/conversations', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
      const archivedOnly = req.query.archivedOnly === '1' || req.query.archivedOnly === 'true';
      const result = chatStore.listConversations(limit, offset, { includeArchived, archivedOnly });
      res.json({ conversations: result.conversations, total: result.total });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/functions/v1/chat-store/conversations', (req, res) => {
    try {
      const body = req.body as Conversation;
      if (!isNonEmptyString(body?.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }
      if (!isNonEmptyString(body?.title)) {
        res.status(400).json({ error: 'Missing or empty conversation title' });
        return;
      }

      chatStore.addConversation(body);
      res.status(201).json({ ok: true });
    } catch (error) {
      if (isConstraintError(error)) {
        res.status(409).json({ error: 'Conversation already exists' });
        return;
      }

      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/functions/v1/chat-store/import', (req, res) => {
    try {
      const body = req.body as { conversation?: Conversation; messages?: Message[] };
      const conversation = body?.conversation;
      const messages = body?.messages;

      if (!conversation || typeof conversation !== 'object') {
        res.status(400).json({ error: 'Missing "conversation" in request body' });
        return;
      }
      if (!isNonEmptyString(conversation.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }
      if (!isNonEmptyString(conversation.title)) {
        res.status(400).json({ error: 'Missing or empty conversation title' });
        return;
      }
      if (!Array.isArray(messages)) {
        res.status(400).json({ error: 'Missing "messages" array in request body' });
        return;
      }

      const imported = chatStore.importConversation(conversation, messages);
      res.status(201).json({ conversation: imported });
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
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }

      const found = chatStore.updateConversation(req.params.id, req.body as Partial<Conversation>);
      if (!found) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/functions/v1/chat-store/conversations/:id', (req, res) => {
    try {
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }

      chatStore.deleteConversation(req.params.id);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/functions/v1/chat-store/conversations/:id/messages', (req, res) => {
    try {
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }

      res.json({ messages: chatStore.listMessages(req.params.id) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/functions/v1/chat-store/messages', (req, res) => {
    try {
      const body = req.body as Message;
      if (!isNonEmptyString(body?.id)) {
        res.status(400).json({ error: 'Missing or empty message id' });
        return;
      }
      if (!isNonEmptyString(body?.conversationId)) {
        res.status(400).json({ error: 'Missing or empty conversationId' });
        return;
      }
      if (!isNonEmptyString(body?.role)) {
        res.status(400).json({ error: 'Missing or empty message role' });
        return;
      }

      chatStore.addMessage(body);
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
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty message id' });
        return;
      }

      const found = chatStore.updateMessage(req.params.id, req.body as Partial<Message>);
      if (!found) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/functions/v1/chat-store/conversations/:id/messages', (req, res) => {
    try {
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }

      chatStore.deleteMessagesByConversation(req.params.id);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/functions/v1/chat-store/conversations/:id/files', (req, res) => {
    try {
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }

      const files = chatStore.getConversationFiles(req.params.id);
      res.json({ conversationFiles: files ?? null });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/functions/v1/chat-store/conversations/:id/files', (req, res) => {
    try {
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }

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
      if (!isNonEmptyString(req.params.id)) {
        res.status(400).json({ error: 'Missing or empty conversation id' });
        return;
      }

      chatStore.deleteConversationFiles(req.params.id);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
