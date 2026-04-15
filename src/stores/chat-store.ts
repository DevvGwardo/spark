import { create } from 'zustand';
import { db, type Conversation } from '@/lib/db';

interface ChatState {
  planMode: boolean;
  setPlanMode: (enabled: boolean) => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  searchQuery: string;

  loadConversations: () => Promise<void>;
  createConversation: (provider: string, model: string, systemPrompt: string) => Promise<string>;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  pinConversation: (id: string, pinned: boolean) => Promise<void>;
  deleteOldConversations: (olderThanDays: number) => Promise<number>;
  setSearchQuery: (q: string) => void;
  clearActiveConversation: () => void;

  // Fork/Rewind
  rewindConversation: (conversationId: string, messageId: string) => Promise<string | null>;
  getForks: (parentId: string) => Promise<Conversation[]>;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  planMode: false,
  setPlanMode: (enabled) => set({ planMode: enabled }),
  conversations: [],
  activeConversationId: null,
  searchQuery: '',

  loadConversations: async () => {
    const conversations = await db.conversations.getAll();
    set({ conversations });
  },

  createConversation: async (provider, model, systemPrompt) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      title: 'New conversation',
      provider,
      model,
      systemPrompt,
      createdAt: now,
      updatedAt: now,
    };
    await db.conversations.add(conversation);
    await get().loadConversations();
    return id;
  },

  selectConversation: (id) => {
    set({ activeConversationId: id });
  },

  deleteConversation: async (id) => {
    await db.messages.deleteByConversation(id);
    await db.conversationFiles.delete(id);
    await db.conversations.delete(id);
    const { activeConversationId } = get();
    if (activeConversationId === id) {
      set({ activeConversationId: null });
    }
    await get().loadConversations();
  },

  renameConversation: async (id, title) => {
    await db.conversations.update(id, { title, updatedAt: new Date().toISOString() });
    await get().loadConversations();
  },

  pinConversation: async (id, pinned) => {
    await db.conversations.update(id, { pinned });
    await get().loadConversations();
  },

  deleteOldConversations: async (olderThanDays) => {
    const cutoff = Date.now() - olderThanDays * 86400000;
    const { conversations, activeConversationId } = get();
    const toDelete = conversations.filter((c) => {
      if (c.pinned) return false;
      const ts = new Date(c.updatedAt || c.createdAt).getTime();
      return ts < cutoff;
    });
    for (const c of toDelete) {
      await db.messages.deleteByConversation(c.id);
      await db.conversationFiles.delete(c.id);
      await db.conversations.delete(c.id);
    }
    if (toDelete.some((c) => c.id === activeConversationId)) {
      set({ activeConversationId: null });
    }
    await get().loadConversations();
    return toDelete.length;
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
  clearActiveConversation: () => set({ activeConversationId: null }),

  // Fork/Rewind
  rewindConversation: async (conversationId, messageId) => {
    try {
      // Load the original conversation
      const conversations = get().conversations;
      const original = conversations.find((c) => c.id === conversationId);
      if (!original) return null;

      // Load messages up to and including the fork point
      const allMessages = await db.messages.getByConversation(conversationId);
      const forkIndex = allMessages.findIndex((m) => m.id === messageId);
      if (forkIndex === -1) return null;
      const messagesUpToFork = allMessages.slice(0, forkIndex + 1);

      // Determine fork number
      const existingForks = conversations.filter((c) => c.parentConversationId === conversationId);
      const forkNumber = existingForks.length + 1;
      const forkTitle = `${original.title} (fork${forkNumber > 1 ? ` ${forkNumber}` : ''})`;

      // Create forked conversation
      const forkId = crypto.randomUUID();
      const now = new Date().toISOString();
      const forkedConversation: Conversation = {
        id: forkId,
        title: forkTitle,
        provider: original.provider,
        model: original.model,
        systemPrompt: original.systemPrompt,
        createdAt: now,
        updatedAt: now,
        parentConversationId: conversationId,
        forkPointMessageId: messageId,
        forkNumber,
      };
      await db.conversations.add(forkedConversation);

      // Copy messages up to fork point
      for (const msg of messagesUpToFork) {
        await db.messages.add({
          ...msg,
          id: crypto.randomUUID(),
          conversationId: forkId,
        });
      }

      // Copy conversation files state
      const files = await db.conversationFiles.get(conversationId);
      if (files) {
        await db.conversationFiles.save({
          ...files,
          conversationId: forkId,
        });
      }

      // Reload conversations list
      await get().loadConversations();

      return forkId;
    } catch (e) {
      console.error('Failed to rewind conversation:', e);
      return null;
    }
  },

  getForks: async (parentId) => {
    const conversations = get().conversations;
    return conversations
      .filter((c) => c.parentConversationId === parentId)
      .sort((a, b) => (a.forkNumber ?? 0) - (b.forkNumber ?? 0));
  },
}));
