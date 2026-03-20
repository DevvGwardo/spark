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
  verification: VerificationProgress;

  setStreaming: (conversationId: string, streaming: boolean) => void;
  getActivity: (conversationId: string) => ConversationActivity | undefined;
  clearActivity: (conversationId: string) => void;
  setVerification: (v: VerificationProgress) => void;
}

const EMPTY_VERIFICATION: VerificationProgress = { active: false, progress: 0, stepLabel: '', stepDetail: '' };

export const useActivityStore = create<ActivityState>()((set, get) => ({
  activities: {},
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

  getActivity: (conversationId) => get().activities[conversationId],

  clearActivity: (conversationId) =>
    set((state) => {
      const { [conversationId]: _, ...rest } = state.activities;
      return { activities: rest };
    }),

  setVerification: (v) => set({ verification: v }),
}));
