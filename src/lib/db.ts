export interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  tokenCount?: number;
  error?: string;
}

const DB_NAME = 'cloudchat';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const probe = indexedDB.open(DB_NAME);
    probe.onsuccess = () => {
      const db = probe.result;
      const needsUpgrade =
        !db.objectStoreNames.contains('conversations') ||
        !db.objectStoreNames.contains('messages');
      const currentVersion = db.version;
      db.close();

      if (!needsUpgrade) {
        // Re-open at same version (no upgrade needed)
        const req = indexedDB.open(DB_NAME, currentVersion);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        return;
      }

      // Bump version to trigger onupgradeneeded
      const req = indexedDB.open(DB_NAME, currentVersion + 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
        const upgradedDb = (event.target as IDBOpenDBRequest).result;
        if (!upgradedDb.objectStoreNames.contains('conversations')) {
          const convStore = upgradedDb.createObjectStore('conversations', { keyPath: 'id' });
          convStore.createIndex('updatedAt', 'updatedAt');
        }
        if (!upgradedDb.objectStoreNames.contains('messages')) {
          const msgStore = upgradedDb.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('conversationId', 'conversationId');
          msgStore.createIndex('timestamp', 'timestamp');
        }
      };
    };
    probe.onerror = () => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('conversations')) {
          const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
          convStore.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('conversationId', 'conversationId');
          msgStore.createIndex('timestamp', 'timestamp');
        }
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
      return all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
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
};
