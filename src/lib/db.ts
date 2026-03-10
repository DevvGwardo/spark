export interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  tokenCount?: number;
  error?: string;
  /** Structured message parts (text, reasoning, tool-invocation) from AI SDK */
  parts?: unknown[];
  /** Tool invocations associated with this message */
  toolInvocations?: unknown[];
}

/** Persisted file state for a conversation (changesets + preview files). */
export interface ConversationFiles {
  conversationId: string;
  changeset: {
    activeRepo: { owner: string; name: string; defaultBranch: string; fullName: string } | null;
    isRepoMode: boolean;
    changes: Record<string, { path: string; action: 'create' | 'edit' | 'delete'; content: string; originalContent?: string; staged?: boolean }>;
    repoFileTree: string[];
  };
  preview: {
    files: Array<{ id: string; filename: string; content: string; type: string; timestamp: string }>;
    activeFileId: string | null;
    projectType: string;
    isOpen?: boolean;
    activeView?: string;
  };
}

const DB_NAME = 'cloudchat';

const REQUIRED_STORES = ['conversations', 'messages', 'conversationFiles'];

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

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const probe = indexedDB.open(DB_NAME);
    probe.onsuccess = () => {
      const probeDb = probe.result;
      const needsUpgrade = REQUIRED_STORES.some(
        (s) => !probeDb.objectStoreNames.contains(s)
      );
      const currentVersion = probeDb.version;
      probeDb.close();

      if (!needsUpgrade) {
        const req = indexedDB.open(DB_NAME, currentVersion);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        return;
      }

      const req = indexedDB.open(DB_NAME, currentVersion + 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
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

async function getTx(storeName: string, mode: IDBTransactionMode) {
  const db = await openDB();
  const transaction = db.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const complete = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
  return { store, complete };
}

export const db = {
  conversations: {
    async getAll(): Promise<Conversation[]> {
      const { store, complete } = await getTx('conversations', 'readonly');
      const all = await reqToPromise<Conversation[]>(store.getAll());
      await complete;
      return all.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    },
    async add(conv: Conversation): Promise<void> {
      const { store, complete } = await getTx('conversations', 'readwrite');
      store.add(conv);
      await complete;
    },
    async update(id: string, fields: Partial<Conversation>): Promise<void> {
      const { store, complete } = await getTx('conversations', 'readwrite');
      const existing = await reqToPromise<Conversation>(store.get(id));
      if (existing) {
        store.put({ ...existing, ...fields });
      }
      await complete;
    },
    async delete(id: string): Promise<void> {
      const { store, complete } = await getTx('conversations', 'readwrite');
      store.delete(id);
      await complete;
    },
  },
  messages: {
    async getByConversation(conversationId: string): Promise<Message[]> {
      const { store, complete } = await getTx('messages', 'readonly');
      const index = store.index('conversationId');
      const all = await reqToPromise<Message[]>(index.getAll(conversationId));
      await complete;
      return all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    },
    async add(msg: Message): Promise<void> {
      const { store, complete } = await getTx('messages', 'readwrite');
      store.add(msg);
      await complete;
    },
    async update(id: string, fields: Partial<Message>): Promise<void> {
      const { store, complete } = await getTx('messages', 'readwrite');
      const existing = await reqToPromise<Message>(store.get(id));
      if (existing) {
        store.put({ ...existing, ...fields });
      }
      await complete;
    },
    async deleteByConversation(conversationId: string): Promise<void> {
      const { store, complete } = await getTx('messages', 'readwrite');
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
      const { store, complete } = await getTx('conversationFiles', 'readonly');
      const result = await reqToPromise<ConversationFiles | undefined>(store.get(conversationId));
      await complete;
      return result;
    },
    async save(data: ConversationFiles): Promise<void> {
      const { store, complete } = await getTx('conversationFiles', 'readwrite');
      store.put(data);
      await complete;
    },
    async delete(conversationId: string): Promise<void> {
      const { store, complete } = await getTx('conversationFiles', 'readwrite');
      store.delete(conversationId);
      await complete;
    },
  },
};
