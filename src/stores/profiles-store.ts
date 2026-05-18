import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getApiBaseUrl } from '@/lib/api';
import { useSettingsStore } from '@/stores/settings-store';

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

export interface ProfileDetail {
  name: string;
  path: string;
  provider: string;
  model: string;
  configYaml: string;
  hasEnv: boolean;
  envKeys: string[];
  skillCount: number;
  sessionCount: number;
  skills: string[];
}

interface ProfilesState {
  profiles: Profile[];
  activeProfile: string;
  selectedProfile: string | null;
  profileDetail: ProfileDetail | null;
  detailLoading: boolean;
  loading: boolean;
  fetchProfiles: () => Promise<void>;
  activateProfile: (name: string) => Promise<void>;
  createProfile: (name: string, cloneFrom?: string) => Promise<void>;
  deleteProfile: (name: string) => Promise<void>;
  fetchProfileDetail: (name: string) => Promise<void>;
  getProfilesForRoomSelection: () => Profile[];
}

// The active profile is stored client-side and sent to the server on every
// Hermes-related request via X-Hermes-Profile. This keeps each window
// independent and ensures CloudChat never writes to any shared file that the
// hermes CLI might read.
export function getActiveProfile(): string {
  return useProfilesStore.getState().activeProfile || 'default';
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Hermes-Profile': getActiveProfile(),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const useProfilesStore = create<ProfilesState>()(
  persist(
    (set, get) => ({
      profiles: [],
      activeProfile: 'default',
      selectedProfile: null,
      profileDetail: null,
      detailLoading: false,
      loading: false,

      fetchProfiles: async () => {
        set({ loading: true });
        try {
          const data = await apiFetch('/api/hermes/profiles');
          set({ profiles: data.profiles });
          // Sync the active profile's provider into settings store
          const activeName = get().activeProfile;
          const active = data.profiles.find((p: Profile) => p.name === activeName);
          if (active?.provider) {
            useSettingsStore.getState().setActiveProvider(active.provider);
            if (active.model) {
              useSettingsStore.getState().updateProviderConfig(active.provider, { model: active.model });
            }
          }
        } catch (e) {
          console.error('Failed to fetch profiles:', e);
        } finally {
          set({ loading: false });
        }
      },

      activateProfile: async (name) => {
        set({ activeProfile: name });
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
        if (name === get().activeProfile) {
          throw new Error('Cannot delete the active profile — switch to another profile first');
        }
        await apiFetch('/api/hermes/profiles/delete', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        await get().fetchProfiles();
      },

      fetchProfileDetail: async (name: string) => {
        set({ detailLoading: true, selectedProfile: name });
        try {
          const data = await apiFetch(`/api/hermes/profiles/${encodeURIComponent(name)}/detail`);
          set({ profileDetail: data, detailLoading: false });
        } catch (e) {
          console.error('Failed to fetch profile detail:', e);
          set({ detailLoading: false, profileDetail: null });
        }
      },

      getProfilesForRoomSelection: () => {
        return get().profiles.filter((p) => !p.name.startsWith('session-'));
      },
    }),
    {
      name: 'cloudchat-active-profile',
      partialize: (state) => ({ activeProfile: state.activeProfile }),
    },
  ),
);
