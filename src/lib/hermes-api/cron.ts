import { hermesFetch } from './core';

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  schedule_display?: string;
  prompt: string;
  status: 'active' | 'paused' | 'completed';
  state?: string;
  created_at: string;
  last_run?: string | null;
  next_run?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  conversation_id?: string | null;
  conversation_title?: string | null;
  origin_platform?: string | null;
}

// ─── Cron Jobs ──────────────────────────────────────────────────────────────

export async function fetchCronJobs(conversationId?: string | null): Promise<CronJob[]> {
  const params = new URLSearchParams();
  if (conversationId) {
    params.set('conversation_id', conversationId);
  }
  const suffix = params.toString() ? `/cron?${params.toString()}` : '/cron';
  const data = await hermesFetch<{ jobs: CronJob[] }>(suffix);
  return data.jobs ?? [];
}

export async function createCronJob(
  schedule: string,
  prompt: string,
  name?: string,
  options?: {
    conversationId?: string | null;
    conversationTitle?: string | null;
  },
): Promise<CronJob> {
  const data = await hermesFetch<{ job: CronJob }>('/cron', {
    method: 'POST',
    body: JSON.stringify({
      schedule,
      prompt,
      name,
      ...(options?.conversationId ? { conversation_id: options.conversationId } : {}),
      ...(options?.conversationTitle ? { conversation_title: options.conversationTitle } : {}),
    }),
  });
  return data.job;
}

export async function deleteCronJob(jobId: string): Promise<void> {
  await hermesFetch(`/cron/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}

export async function pauseCronJob(jobId: string): Promise<CronJob> {
  const data = await hermesFetch<{ job: CronJob }>(
    `/cron/${encodeURIComponent(jobId)}/pause`,
    { method: 'POST' },
  );
  return data.job;
}

export async function resumeCronJob(jobId: string): Promise<CronJob> {
  const data = await hermesFetch<{ job: CronJob }>(
    `/cron/${encodeURIComponent(jobId)}/resume`,
    { method: 'POST' },
  );
  return data.job;
}

export async function runCronJob(jobId: string): Promise<void> {
  await hermesFetch(`/cron/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
  });
}

export interface CronRun {
  run_id: string;
  job_id: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'success' | 'error';
  output: string | null;
  error: string | null;
  tool_log: string[];
  duration_ms: number | null;
}

export async function fetchCronRunHistory(jobId: string): Promise<CronRun[]> {
  const data = await hermesFetch<{ runs: CronRun[] }>(`/cron/${encodeURIComponent(jobId)}/history`);
  return data.runs ?? [];
}
