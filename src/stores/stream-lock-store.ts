import { create } from 'zustand';

// Only one panel at a time may stream against a given Hermes profile. The bridge
// resolves every request back to the same `hermes_home` (skills/, state.db,
// working dir) per profile, so two concurrent agent loops on the same profile
// corrupt each other's tool results and push the model into a retry loop.
//
// This store tracks which panel currently "owns" the active profile's stream.
// useChat acquires on stream-start and releases on stream-end/unmount.
interface StreamLockState {
  locks: Record<string, string>; // profile -> panelId

  acquire: (profile: string, panelId: string) => boolean;
  release: (profile: string, panelId: string) => void;
}

export const useStreamLockStore = create<StreamLockState>()((set, get) => ({
  locks: {},

  acquire: (profile, panelId) => {
    const current = get().locks[profile];
    if (current && current !== panelId) return false;
    if (current === panelId) return true;
    set((state) => ({ locks: { ...state.locks, [profile]: panelId } }));
    return true;
  },

  release: (profile, panelId) =>
    set((state) => {
      if (state.locks[profile] !== panelId) return state;
      const { [profile]: _dropped, ...rest } = state.locks;
      return { locks: rest };
    }),
}));
