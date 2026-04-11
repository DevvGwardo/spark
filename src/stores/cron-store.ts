import { create } from 'zustand';
import {
  fetchCronJobs as apiFetchCronJobs,
  createCronJob as apiCreateCronJob,
  deleteCronJob as apiDeleteCronJob,
  pauseCronJob as apiPauseCronJob,
  resumeCronJob as apiResumeCronJob,
  runCronJob as apiRunCronJob,
  fetchCronRunHistory as apiFetchCronRunHistory,
  type CronJob,
  type CronRun,
} from '@/lib/hermes-api';

export type { CronJob, CronRun };

interface CronState {
  jobs: CronJob[];
  runHistory: Record<string, CronRun[]>;
  loading: boolean;
  error: string | null;
  scopedConversationId: string | null;
  fetchJobs: (conversationId?: string | null) => Promise<void>;
  createJob: (
    schedule: string,
    prompt: string,
    name?: string,
    options?: { conversationId?: string | null; conversationTitle?: string | null },
  ) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  pauseJob: (id: string) => Promise<void>;
  resumeJob: (id: string) => Promise<void>;
  runJob: (id: string) => Promise<void>;
  fetchRunHistory: (jobId: string) => Promise<void>;
}

export const useCronStore = create<CronState>()((set, get) => ({
  jobs: [],
  runHistory: {},
  loading: false,
  error: null,
  scopedConversationId: null,

  fetchJobs: async (conversationId) => {
    set({ loading: true, error: null, scopedConversationId: conversationId ?? null });
    try {
      const jobs = await apiFetchCronJobs(conversationId);
      set({ jobs, loading: false, scopedConversationId: conversationId ?? null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to fetch cron jobs', loading: false });
    }
  },

  createJob: async (schedule, prompt, name, options) => {
    set({ error: null });
    try {
      await apiCreateCronJob(schedule, prompt, name, options);
      await get().fetchJobs(get().scopedConversationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create job';
      set({ error: msg });
      throw err;
    }
  },

  deleteJob: async (id) => {
    set({ error: null });
    try {
      await apiDeleteCronJob(id);
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete job' });
    }
  },

  pauseJob: async (id) => {
    set({ error: null });
    try {
      const updated = await apiPauseCronJob(id);
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? updated : j)) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to pause job' });
    }
  },

  resumeJob: async (id) => {
    set({ error: null });
    try {
      const updated = await apiResumeCronJob(id);
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? updated : j)) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to resume job' });
    }
  },

  runJob: async (id) => {
    set({ error: null });
    try {
      await apiRunCronJob(id);
      await get().fetchJobs(get().scopedConversationId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to run job' });
    }
  },

  fetchRunHistory: async (jobId) => {
    try {
      const runs = await apiFetchCronRunHistory(jobId);
      set((s) => ({ runHistory: { ...s.runHistory, [jobId]: runs } }));
    } catch (err) {
      // Silently fail — run history is supplementary
      console.error('Failed to fetch run history:', err);
    }
  },
}));
