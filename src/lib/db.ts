import { getApiBaseUrl } from '@/lib/api';
import type { PullRequestRecord } from '@/lib/pull-request';

export interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  parentConversationId?: string;
  forkPointMessageId?: string;
  forkNumber?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  tokenCount?: number;
  error?: string;
  parts?: unknown[];
  toolInvocations?: unknown[];
}

export interface ConversationFiles {
  conversationId: string;
  changeset: {
    activeRepo: {
      owner: string;
      name: string;
      defaultBranch: string;
      fullName: string;
      permissions?: {
        pull?: boolean;
        push?: boolean;
        admin?: boolean;
      };
      baseOwner?: string;
      baseName?: string;
      baseFullName?: string;
      localPath?: string | null;
      issue?: {
        number: number;
        title: string;
        body?: string | null;
        url: string;
        state: string;
        labels: string[];
        updatedAt: string;
      } | null;
    } | null;
    isRepoMode: boolean;
    pullRequest?: PullRequestRecord | null;
    changes: Record<string, { path: string; action: 'create' | 'edit' | 'delete'; content: string; originalContent?: string; staged?: boolean }>;
    repoFileTree: string[];
    repoFileCache?: Record<string, string>;
    selectedRepoFilePath?: string | null;
  };
  preview: {
    files: Array<{ id: string; filename: string; content: string; type: string; timestamp: string }>;
    activeFileId: string | null;
    projectType: string;
    isOpen?: boolean;
    activeView?: string;
  };
  repoFileCache?: Record<string, string>;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type BackendMode = 'unknown' | 'server' | 'legacy';

const DB_NAME = 'cloudchat';
const REQUIRED_STORES = ['conversations', 'messages', 'conversationFiles'];

let backendMode: BackendMode = 'unknown';
let migrationPromise: Promise<void> | null = null;

function isFallbackableServerError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof HttpError && [404, 405, 500, 501, 503].includes(error.status));
}

function createStoresIfNeeded(db: IDBDatabase) {
  if (!db.objectStoreNames.contains('conversations')) {
    const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
    convStore.createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains('messages')) {
    const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
    msgStore.createIndex('conversationId', 'conversationId');
    msgStore.createIndex('timestamp', 'timestamp');
  }
  if (!db.objectStoreNames.contains('conversationFiles')) {
    db.createObjectStore('conversationFiles', { keyPath: 'conversationId' });
  }
}

function openLegacyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const probe = indexedDB.open(DB_NAME);
    probe.onsuccess = () => {
      const probeDb = probe.result;
      const needsUpgrade = REQUIRED_STORES.some((storeName) => !probeDb.objectStoreNames.contains(storeName));
      const currentVersion = probeDb.version;
      probeDb.close();

      if (!needsUpgrade) {
        const request = indexedDB.open(DB_NAME, currentVersion);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        return;
      }

      const request = indexedDB.open(DB_NAME, currentVersion + 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        createStoresIfNeeded((event.target as IDBOpenDBRequest).result);
      };
    };

    probe.onerror = () => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        createStoresIfNeeded((event.target as IDBOpenDBRequest).result);
      };
    };
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getLegacyTx(storeName: string, mode: IDBTransactionMode) {
  const db = await openLegacyDb();
  const transaction = db.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const complete = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
  return { store, complete };
}

const legacyDb = {
  conversations: {
    async getAll(): Promise<Conversation[]> {
      const { store, complete } = await getLegacyTx('conversations', 'readonly');
      const all = await reqToPromise<Conversation[]>(store.getAll());
      await complete;
      return all.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    },
    async add(conversation: Conversation): Promise<void> {
      const { store, complete } = await getLegacyTx('conversations', 'readwrite');
      store.add(conversation);
      await complete;
    },
    async update(id: string, fields: Partial<Conversation>): Promise<void> {
      const { store, complete } = await getLegacyTx('conversations', 'readwrite');
      const existing = await reqToPromise<Conversation>(store.get(id));
      if (existing) {
        store.put({ ...existing, ...fields });
      }
      await complete;
    },
    async delete(id: string): Promise<void> {
      const { store, complete } = await getLegacyTx('conversations', 'readwrite');
      store.delete(id);
      await complete;
    },
  },
  messages: {
    async getByConversation(conversationId: string): Promise<Message[]> {
      const { store, complete } = await getLegacyTx('messages', 'readonly');
      const index = store.index('conversationId');
      const all = await reqToPromise<Message[]>(index.getAll(conversationId));
      await complete;
      return all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    },
    async add(message: Message): Promise<void> {
      const { store, complete } = await getLegacyTx('messages', 'readwrite');
      store.add(message);
      await complete;
    },
    async update(id: string, fields: Partial<Message>): Promise<void> {
      const { store, complete } = await getLegacyTx('messages', 'readwrite');
      const existing = await reqToPromise<Message>(store.get(id));
      if (existing) {
        store.put({ ...existing, ...fields });
      }
      await complete;
    },
    async deleteByConversation(conversationId: string): Promise<void> {
      const { store, complete } = await getLegacyTx('messages', 'readwrite');
      const index = store.index('conversationId');
      const keys = await reqToPromise<IDBValidKey[]>(index.getAllKeys(conversationId));
      for (const key of keys) {
        store.delete(key);
      }
      await complete;
    },
  },
  conversationFiles: {
    async get(conversationId: string): Promise<ConversationFiles | undefined> {
      const { store, complete } = await getLegacyTx('conversationFiles', 'readonly');
      const result = await reqToPromise<ConversationFiles | undefined>(store.get(conversationId));
      await complete;
      return result;
    },
    async save(data: ConversationFiles): Promise<void> {
      const { store, complete } = await getLegacyTx('conversationFiles', 'readwrite');
      store.put(data);
      await complete;
    },
    async delete(conversationId: string): Promise<void> {
      const { store, complete } = await getLegacyTx('conversationFiles', 'readwrite');
      store.delete(conversationId);
      await complete;
    },
  },
};

async function requestServer<T>(
  path: string,
  init?: RequestInit,
  options?: { allowNotFound?: boolean; expectJson?: boolean },
): Promise<T | undefined> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 404 && options?.allowNotFound) {
    return undefined;
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const data = await response.json() as { error?: string };
      if (typeof data.error === 'string' && data.error.trim().length > 0) {
        message = data.error;
      }
    } catch {
      const text = await response.text().catch(() => '');
      if (text.trim().length > 0) {
        message = text;
      }
    }

    throw new HttpError(message, response.status);
  }

  if (options?.expectJson === false || response.status === 204) {
    return undefined;
  }

  return response.json() as Promise<T>;
}

const serverDb = {
  conversations: {
    async getAll(): Promise<Conversation[]> {
      const response = await requestServer<{ conversations: Conversation[] }>(
        '/functions/v1/chat-store/conversations',
      );
      return response?.conversations ?? [];
    },
    async add(conversation: Conversation): Promise<void> {
      await requestServer('/functions/v1/chat-store/conversations', {
        method: 'POST',
        body: JSON.stringify(conversation),
      }, { expectJson: false });
    },
    async update(id: string, fields: Partial<Conversation>): Promise<void> {
      await requestServer(`/functions/v1/chat-store/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      }, { expectJson: false });
    },
    async delete(id: string): Promise<void> {
      await requestServer(`/functions/v1/chat-store/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }, { expectJson: false });
    },
  },
  messages: {
    async getByConversation(conversationId: string): Promise<Message[]> {
      const response = await requestServer<{ messages: Message[] }>(
        `/functions/v1/chat-store/conversations/${encodeURIComponent(conversationId)}/messages`,
      );
      return response?.messages ?? [];
    },
    async add(message: Message): Promise<void> {
      await requestServer('/functions/v1/chat-store/messages', {
        method: 'POST',
        body: JSON.stringify(message),
      }, { expectJson: false });
    },
    async update(id: string, fields: Partial<Message>): Promise<void> {
      await requestServer(`/functions/v1/chat-store/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      }, { expectJson: false });
    },
    async deleteByConversation(conversationId: string): Promise<void> {
      await requestServer(`/functions/v1/chat-store/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'DELETE',
      }, { expectJson: false });
    },
  },
  conversationFiles: {
    async get(conversationId: string): Promise<ConversationFiles | undefined> {
      const response = await requestServer<{ conversationFiles: ConversationFiles | null }>(
        `/functions/v1/chat-store/conversations/${encodeURIComponent(conversationId)}/files`,
        undefined,
        { allowNotFound: true },
      );
      return response?.conversationFiles ?? undefined;
    },
    async save(data: ConversationFiles): Promise<void> {
      await requestServer(`/functions/v1/chat-store/conversations/${encodeURIComponent(data.conversationId)}/files`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }, { expectJson: false });
    },
    async delete(conversationId: string): Promise<void> {
      await requestServer(`/functions/v1/chat-store/conversations/${encodeURIComponent(conversationId)}/files`, {
        method: 'DELETE',
      }, { expectJson: false });
    },
  },
};

async function detectBackendMode(): Promise<Exclude<BackendMode, 'unknown'>> {
  if (backendMode !== 'unknown') {
    return backendMode;
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}/functions/v1/health`);
    backendMode = response.ok ? 'server' : 'legacy';
  } catch {
    backendMode = 'legacy';
  }

  return backendMode;
}

async function ensureServerMigration(): Promise<void> {
  if (migrationPromise) {
    return migrationPromise;
  }

  migrationPromise = (async () => {
    if (typeof indexedDB === 'undefined') {
      return;
    }

    const serverConversations = await serverDb.conversations.getAll();
    if (serverConversations.length > 0) {
      return;
    }

    const legacyConversations = await legacyDb.conversations.getAll();
    if (legacyConversations.length === 0) {
      return;
    }

    for (const conversation of legacyConversations) {
      await serverDb.conversations.add(conversation);
    }

    for (const conversation of legacyConversations) {
      const messages = await legacyDb.messages.getByConversation(conversation.id);
      for (const message of messages) {
        await serverDb.messages.add(message);
      }

      const conversationFiles = await legacyDb.conversationFiles.get(conversation.id);
      if (conversationFiles) {
        await serverDb.conversationFiles.save(conversationFiles);
      }
    }
  })().catch((error) => {
    migrationPromise = null;
    throw error;
  });

  return migrationPromise;
}

async function withBackend<T>(
  serverOperation: () => Promise<T>,
  legacyOperation: () => Promise<T>,
): Promise<T> {
  const backend = await detectBackendMode();
  if (backend === 'legacy') {
    return legacyOperation();
  }

  try {
    await ensureServerMigration();
    return await serverOperation();
  } catch (error) {
    if (!isFallbackableServerError(error)) {
      throw error;
    }

    backendMode = 'legacy';
    return legacyOperation();
  }
}

export const db = {
  conversations: {
    async getAll(): Promise<Conversation[]> {
      return withBackend(
        () => serverDb.conversations.getAll(),
        () => legacyDb.conversations.getAll(),
      );
    },
    async add(conversation: Conversation): Promise<void> {
      return withBackend(
        () => serverDb.conversations.add(conversation),
        () => legacyDb.conversations.add(conversation),
      );
    },
    async update(id: string, fields: Partial<Conversation>): Promise<void> {
      return withBackend(
        () => serverDb.conversations.update(id, fields),
        () => legacyDb.conversations.update(id, fields),
      );
    },
    async delete(id: string): Promise<void> {
      return withBackend(
        () => serverDb.conversations.delete(id),
        () => legacyDb.conversations.delete(id),
      );
    },
  },
  messages: {
    async getByConversation(conversationId: string): Promise<Message[]> {
      return withBackend(
        () => serverDb.messages.getByConversation(conversationId),
        () => legacyDb.messages.getByConversation(conversationId),
      );
    },
    async add(message: Message): Promise<void> {
      return withBackend(
        () => serverDb.messages.add(message),
        () => legacyDb.messages.add(message),
      );
    },
    async update(id: string, fields: Partial<Message>): Promise<void> {
      return withBackend(
        () => serverDb.messages.update(id, fields),
        () => legacyDb.messages.update(id, fields),
      );
    },
    async deleteByConversation(conversationId: string): Promise<void> {
      return withBackend(
        () => serverDb.messages.deleteByConversation(conversationId),
        () => legacyDb.messages.deleteByConversation(conversationId),
      );
    },
  },
  conversationFiles: {
    async get(conversationId: string): Promise<ConversationFiles | undefined> {
      return withBackend(
        () => serverDb.conversationFiles.get(conversationId),
        () => legacyDb.conversationFiles.get(conversationId),
      );
    },
    async save(data: ConversationFiles): Promise<void> {
      return withBackend(
        () => serverDb.conversationFiles.save(data),
        () => legacyDb.conversationFiles.save(data),
      );
    },
    async delete(conversationId: string): Promise<void> {
      return withBackend(
        () => serverDb.conversationFiles.delete(conversationId),
        () => legacyDb.conversationFiles.delete(conversationId),
      );
    },
  },
};
