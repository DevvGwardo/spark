import { create } from 'zustand';
import { getApiBaseUrl } from '@/lib/api';

export interface Profile {
  name: string;
  path: string;
  active: boolean;
  model?: string;
  provider?: string;
  skillCount: number;
  sessionCount: number;
  hasEnv: boolean;
}

interface ProfilesState {
  profiles: Profile[];
  activeProfile: string;
  loading: boolean;
  fetchProfiles: () => Promise<void>;
  activateProfile: (name: string) => Promise<void>;
  createProfile: (name: string, cloneFrom?: string) => Promise<void>;
  deleteProfile: (name: string) => Promise<void>;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const useProfilesStore = create<ProfilesState>()((set, get) => ({
  profiles: [],
  activeProfile: 'default',
  loading: false,

  fetchProfiles: async () => {
    set({ loading: true });
    try {
      const data = await apiFetch('/api/hermes/profiles');
      set({ profiles: data.profiles, activeProfile: data.activeProfile });
    } catch (e) {
      console.error('Failed to fetch profiles:', e);
    } finally {
      set({ loading: false });
    }
  },

  activateProfile: async (name) => {
    await apiFetch('/api/hermes/profiles/activate', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    await get().fetchProfiles();
  },

  createProfile: async (name, cloneFrom) => {
    await apiFetch('/api/hermes/profiles/create', {
      method: 'POST',
      body: JSON.stringify({ name, cloneFrom }),
    });
    await get().fetchProfiles();
  },

  deleteProfile: async (name) => {
    await apiFetch('/api/hermes/profiles/delete', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    await get().fetchProfiles();
  },
}));
