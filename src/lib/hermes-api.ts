import { getApiBaseUrl } from './api';

const BRIDGE_BASE = '/api/hermes';

export class HermesApiError extends Error {
  status: number;
  data: Record<string, unknown>;

  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HermesApiError';
    this.status = status;
    this.data = data;
  }
}

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

export interface HermesSession {
  id: string;
  created_at: string;
  updated_at: string | null;
  messages: number;
  model: string;
  status: 'active' | 'completed' | 'error' | string;
  toolsets: string[];
  repo: string | null;
  firstUserMessage: string;
}

export interface HermesSessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string;
}

export interface HermesSessionDetail extends HermesSession {
  chat?: HermesSessionMessage[];
  error?: string | null;
}

export interface HermesWorkspaceFileSummary {
  key: string;
  label: string;
  description: string;
  path: string;
  exists: boolean;
  size: number;
  modified_at: string | null;
  preview: string;
  version: string | null;
}

export interface HermesWorkspaceFile extends HermesWorkspaceFileSummary {
  content: string;
}

export interface HermesWorkspaceOverview {
  hermes_home: string;
  session_source: {
    kind: string;
    path: string;
    available: boolean;
  };
  cron_backend: string;
  counts: {
    tracked_sessions: number;
    messages: number;
    input_tokens: number;
    output_tokens: number;
    live_sessions: number;
    cron_jobs: number;
    skills: number;
  };
  last_session_started_at: string | null;
  files: HermesWorkspaceFileSummary[];
  top_models: Array<{
    model: string;
    session_count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>;
}

export interface HermesSkillSummary {
  id: string;
  name: string;
  summary: string;
  category: string;
  path: string;
  modified_at: string | null;
  line_count: number;
  size_bytes?: number;
  estimated_tokens?: number;
}

export interface HermesSkillDetail extends HermesSkillSummary {
  content: string;
}

export interface HubSkill {
  name: string;
  description: string;
  category: string;
  source: 'built-in' | 'optional' | 'community' | 'anthropic' | 'lobehub';
  installed: boolean;
}

export interface HermesUsageModelBreakdown {
  model: string;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface HermesUsageDay {
  day: string;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface HermesUsageOverview {
  state_db_available: boolean;
  session_count: number;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  first_session_started_at: string | null;
  last_session_started_at: string | null;
  top_models: HermesUsageModelBreakdown[];
  recent_days: HermesUsageDay[];
}

async function hermesFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}${BRIDGE_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  let data: Record<string, unknown> = {};
  try {
    data = await response.json();
  } catch {
    // Non-JSON response body
  }

  if (!response.ok) {
    const error =
      typeof data.error === 'string' && data.error
        ? data.error
        : `Server returned ${response.status}`;
    throw new HermesApiError(error, response.status, data);
  }

  return data as T;
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

// ─── Sessions ───────────────────────────────────────────────────────────────

export async function fetchSessions(): Promise<HermesSession[]> {
  const data = await hermesFetch<{ sessions: HermesSession[] }>('/sessions');
  return data.sessions ?? [];
}

export async function getSession(sessionId: string): Promise<HermesSessionDetail> {
  return hermesFetch<HermesSessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await hermesFetch(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

// ─── Workspace ─────────────────────────────────────────────────────────────

export async function fetchHermesWorkspaceOverview(): Promise<HermesWorkspaceOverview> {
  return hermesFetch<HermesWorkspaceOverview>('/workspace/overview');
}

export async function fetchHermesWorkspaceUsage(): Promise<HermesUsageOverview> {
  return hermesFetch<HermesUsageOverview>('/workspace/usage');
}

export async function fetchHermesWorkspaceFiles(): Promise<HermesWorkspaceFileSummary[]> {
  const data = await hermesFetch<{ files: HermesWorkspaceFileSummary[] }>('/workspace/files');
  return data.files ?? [];
}

export async function fetchHermesWorkspaceFile(fileKey: string): Promise<HermesWorkspaceFile> {
  const data = await hermesFetch<{ file: HermesWorkspaceFile }>(`/workspace/files/${encodeURIComponent(fileKey)}`);
  return data.file;
}

export async function updateHermesWorkspaceFile(
  fileKey: string,
  content: string,
  expectedVersion?: string | null,
): Promise<HermesWorkspaceFile> {
  const data = await hermesFetch<{ file: HermesWorkspaceFile }>(`/workspace/files/${encodeURIComponent(fileKey)}`, {
    method: 'PUT',
    body: JSON.stringify({
      content,
      expected_version: expectedVersion ?? null,
    }),
  });
  return data.file;
}

export async function fetchHermesSkills(): Promise<HermesSkillSummary[]> {
  const data = await hermesFetch<{ skills: HermesSkillSummary[] }>('/workspace/skills');
  return data.skills ?? [];
}

export async function fetchHermesSkillDetail(skillId: string): Promise<HermesSkillDetail> {
  const params = new URLSearchParams({ id: skillId });
  const data = await hermesFetch<{ skill: HermesSkillDetail }>(`/workspace/skills/content?${params.toString()}`);
  return data.skill;
}

export async function deleteHermesSkill(skillId: string): Promise<void> {
  await hermesFetch('/workspace/skills', {
    method: 'DELETE',
    body: JSON.stringify({ id: skillId }),
  });
}

export async function fetchSkillsHub(): Promise<HubSkill[]> {
  const data = await hermesFetch<{ skills: HubSkill[] }>('/workspace/skills/hub');
  return data.skills ?? [];
}

export async function installHubSkill(skillName: string): Promise<void> {
  await hermesFetch('/workspace/skills/hub/install', {
    method: 'POST',
    body: JSON.stringify({ name: skillName }),
  });
}
