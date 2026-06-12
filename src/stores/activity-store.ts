import { create } from 'zustand';

interface ConversationActivity {
  streaming: boolean;
}

export interface VerificationProgress {
  active: boolean;
  progress: number;
  stepLabel: string;
  stepDetail: string;
}

interface ActivityState {
  activities: Record<string, ConversationActivity>;
  /** Conversations with a hermes run still active server-side (polled),
   * mapped to the run's server start time (epoch ms). Survives panel/window
   * close, unlike per-panel `activities`. */
  backgroundRuns: Record<string, number>;
  /** Local stream-start time (epoch ms) per conversation. Lives in the global
   * store so a panel close/reopen doesn't reset the elapsed timer — covers
   * runs the server doesn't report in backgroundRuns (loop/swarm) and the
   * poll-race window before backgroundRuns populates. */
  streamAnchors: Record<string, number>;
  verification: VerificationProgress;

  setStreaming: (conversationId: string, streaming: boolean) => void;
  markStreamAnchor: (conversationId: string, startedAt: number) => void;
  clearStreamAnchor: (conversationId: string) => void;
  setBackgroundRuns: (runs: Array<{ conversationId: string; startedAt: number }>) => void;
  clearBackgroundRun: (conversationId: string) => void;
  getActivity: (conversationId: string) => ConversationActivity | undefined;
  clearActivity: (conversationId: string) => void;
  setVerification: (v: VerificationProgress) => void;
}

const EMPTY_VERIFICATION: VerificationProgress = { active: false, progress: 0, stepLabel: '', stepDetail: '' };

export const useActivityStore = create<ActivityState>()((set, get) => ({
  activities: {},
  backgroundRuns: {},
  streamAnchors: {},
  verification: EMPTY_VERIFICATION,

  setStreaming: (conversationId, streaming) =>
    set((state) => ({
      activities: {
        ...state.activities,
        [conversationId]: {
          ...(state.activities[conversationId] || {}),
          streaming,
        },
      },
    })),

  setBackgroundRuns: (runs) =>
    set((state) => {
      const next: Record<string, number> = {};
      for (const run of runs) next[run.conversationId] = run.startedAt;
      const prevKeys = Object.keys(state.backgroundRuns);
      if (
        prevKeys.length === runs.length &&
        prevKeys.every((id) => next[id] === state.backgroundRuns[id])
      ) {
        return state;
      }
      return { backgroundRuns: next };
    }),

  clearBackgroundRun: (conversationId) =>
    set((state) => {
      if (!state.backgroundRuns[conversationId]) return state;
      const { [conversationId]: _dropped, ...rest } = state.backgroundRuns;
      return { backgroundRuns: rest };
    }),

  markStreamAnchor: (conversationId, startedAt) =>
    set((state) => ({
      streamAnchors: { ...state.streamAnchors, [conversationId]: startedAt },
    })),

  clearStreamAnchor: (conversationId) =>
    set((state) => {
      if (!state.streamAnchors[conversationId]) return state;
      const { [conversationId]: _dropped, ...rest } = state.streamAnchors;
      return { streamAnchors: rest };
    }),

  getActivity: (conversationId) => get().activities[conversationId],

  clearActivity: (conversationId) =>
    set((state) => {
      const { [conversationId]: _, ...rest } = state.activities;
      return { activities: rest };
    }),

  setVerification: (v) => set({ verification: v }),
}));
