import { create } from 'zustand';
import { db, type Conversation } from '@/lib/db';

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  searchQuery: string;

  loadConversations: () => Promise<void>;
  createConversation: (provider: string, model: string, systemPrompt: string) => Promise<string>;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
  clearActiveConversation: () => void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
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
    set({ activeConversationId: id });
    return id;
  },

  selectConversation: (id) => {
    set({ activeConversationId: id });
  },

  deleteConversation: async (id) => {
    await db.messages.deleteByConversation(id);
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

  setSearchQuery: (q) => set({ searchQuery: q }),
  clearActiveConversation: () => set({ activeConversationId: null }),
}));
