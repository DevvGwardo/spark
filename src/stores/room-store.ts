import { create } from 'zustand';
import { getApiBaseUrl } from '@/lib/api';

export interface Room {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMember {
  roomId: string;
  profileName: string;
  displayName: string;
  color: string;
  model: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  senderProfile: string;
  senderDisplayName: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  mentions: string[];
}

interface RoomWithMembers extends Room {
  members: RoomMember[];
}

interface RoomState {
  rooms: Room[];
  activeRoomId: string | null;
  activeRoom: RoomWithMembers | null;
  messages: RoomMessage[];
  loading: boolean;
  pendingAgents: Array<{ profileName: string; displayName: string }>;
  settingsRoomId: string | null;
  roomTeamIds: Record<string, string>;
  fetchRooms: () => Promise<void>;
  createRoom: (name: string) => Promise<Room>;
  fetchRoom: (id: string) => Promise<void>;
  addMember: (roomId: string, member: Omit<RoomMember, 'roomId'>) => Promise<void>;
  removeMember: (roomId: string, profileName: string) => Promise<void>;
  fetchMessages: (roomId: string, limit?: number, before?: string) => Promise<void>;
  postMessage: (roomId: string, content: string, sender: string, mentions?: string[], teamId?: string) => Promise<{ triggeredAgents: Array<{ profileName: string; displayName: string }> }>;
  addMessage: (roomId: string, message: RoomMessage) => void;
  setActiveRoomId: (id: string | null) => void;
  setRoomTeamId: (roomId: string, teamId: string) => void;
  clearActiveData: () => void;
  openRoomSettings: (roomId: string) => void;
  closeRoomSettings: () => void;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const useRoomStore = create<RoomState>()((set, get) => ({
  rooms: [],
  activeRoomId: null,
  activeRoom: null,
  messages: [],
  loading: false,
  pendingAgents: [],
  settingsRoomId: null,
  roomTeamIds: {},

  fetchRooms: async () => {
    set({ loading: true });
    try {
      const data = await apiFetch('/api/rooms');
      set({ rooms: data.rooms ?? [] });
    } catch (e) {
      console.error('Failed to fetch rooms:', e);
    } finally {
      set({ loading: false });
    }
  },

  createRoom: async (name) => {
    const data = await apiFetch('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const room = data.room ?? data;
    set((s) => ({ rooms: [...s.rooms, room] }));
    return room;
  },

  fetchRoom: async (id) => {
    set({ loading: true });
    try {
      const data = await apiFetch(`/api/rooms/${encodeURIComponent(id)}`);
      // Backend returns { room, members } - merge into RoomWithMembers
      set({ activeRoom: { ...data.room, members: data.members ?? [] } });
    } catch (e) {
      console.error('Failed to fetch room:', e);
    } finally {
      set({ loading: false });
    }
  },

  addMember: async (roomId, member) => {
    await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/members`, {
      method: 'POST',
      body: JSON.stringify(member),
    });
    const { activeRoom } = get();
    if (activeRoom && activeRoom.id === roomId) {
      const data = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}`);
      set({ activeRoom: { ...data.room, members: data.members ?? [] } });
    }
  },

  removeMember: async (roomId, profileName) => {
    await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(profileName)}`, {
      method: 'DELETE',
    });
    const { activeRoom } = get();
    if (activeRoom && activeRoom.id === roomId) {
      const data = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}`);
      set({ activeRoom: { ...data.room, members: data.members ?? [] } });
    }
  },

  fetchMessages: async (roomId, limit, before) => {
    set({ loading: true });
    try {
      let path = `/api/rooms/${encodeURIComponent(roomId)}/messages`;
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      if (before) params.set('before', before);
      const qs = params.toString();
      if (qs) path += `?${qs}`;
      const data = await apiFetch(path);
      const newMessages: RoomMessage[] = data.messages ?? [];
      set((s) => {
        // Clear pending agents whose assistant responses have arrived via polling
        const respondedProfiles = new Set(
          newMessages
            .filter((m) => m.role === 'assistant')
            .map((m) => m.senderProfile),
        );
        const stillPending = s.pendingAgents.filter(
          (a) => !respondedProfiles.has(a.profileName),
        );
        return { messages: newMessages, pendingAgents: stillPending };
      });
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    } finally {
      set({ loading: false });
    }
  },

  postMessage: async (roomId, content, sender, mentions, teamId) => {
    const data = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, sender, mentions, teamId }),
    });
    const message = data.message ?? data;
    const triggered: Array<{ profileName: string; displayName: string }> = data.triggeredAgents ?? [];
    // Atomically add message + pending agents so a poll can't split the update
    set((s) => ({
      messages: [...s.messages, message],
      pendingAgents: triggered.length > 0
        ? [...s.pendingAgents, ...triggered]
        : s.pendingAgents,
    }));
    return { triggeredAgents: triggered };
  },

  addMessage: (roomId, message) => {
    set((s) => {
      // Only add if it belongs to the active room
      if (s.activeRoomId !== roomId) return s;
      // Avoid duplicates
      if (s.messages.some((m) => m.id === message.id)) return s;
      // Remove this sender from pending agents
      const stillPending = s.pendingAgents.filter(
        (a) => a.displayName !== message.senderDisplayName && a.profileName !== message.senderProfile,
      );
      return { messages: [...s.messages, message], pendingAgents: stillPending };
    });
  },

  setActiveRoomId: (id) => set({ activeRoomId: id, messages: id ? get().messages : [] }),

  setRoomTeamId: (roomId, teamId) => {
    set((s) => ({ roomTeamIds: { ...s.roomTeamIds, [roomId]: teamId } }));
  },

  clearActiveData: () => set({
    activeRoomId: null,
    activeRoom: null,
    messages: [],
    pendingAgents: [],
  }),

  openRoomSettings: (roomId) => set({ settingsRoomId: roomId }),

  closeRoomSettings: () => set({ settingsRoomId: null }),
}));
