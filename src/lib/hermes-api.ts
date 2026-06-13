import { getApiBaseUrl } from './api';
import { getActiveProfile } from '@/stores/profiles-store';

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
  source?: string | null;
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
  integrations?: {
    cursor_composer?: CursorComposerBridgeStatus;
  };
}

export interface CursorComposerBridgeStatus {
  id: string;
  name: string;
  description?: string;
  connected: boolean;
  skills_ready: boolean;
  bridge_repo?: string;
  launchd_label?: string;
  bridge?: {
    reachable?: boolean;
    status?: string;
    health_url?: string;
    api_url?: string;
    detail?: string;
  };
  skills?: Record<string, boolean>;
  detail?: string;
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
      'X-Hermes-Profile': getActiveProfile(),
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

// ─── Providers ────────────────────────────────────────────────────────────

export interface HermesProviderInfo {
  id: string;
  name: string;
  base_url: string;
  is_aggregator: boolean;
  credentialed: boolean;
  models: string[];
}

export interface HermesProvidersResponse {
  providers: HermesProviderInfo[];
  defaultProvider: string;
  /** The agent's CLI-configured default model (config.yaml `model.default`). */
  defaultModel: string;
}

/**
 * Fetch the catalog of underlying providers (and their models) the Hermes
 * agent can route to. Used to populate the provider/model picker.
 */
export async function fetchHermesProviders(): Promise<HermesProvidersResponse> {
  const data = await hermesFetch<{
    data?: HermesProviderInfo[];
    default_provider?: string;
    default_model?: string;
  }>('/providers');
  return {
    providers: Array.isArray(data.data) ? data.data : [],
    defaultProvider: data.default_provider || 'openrouter',
    defaultModel: data.default_model || '',
  };
}

export async function fetchCursorComposerBridge(): Promise<CursorComposerBridgeStatus> {
  return hermesFetch<CursorComposerBridgeStatus>('/bridges/cursor-composer');
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

export interface SessionStatusCounts {
  active: number;
  completed: number;
  error: number;
  total: number;
}

export interface SessionsPage {
  sessions: HermesSession[];
  /** Total sessions matching the query, before pagination. */
  total: number;
  /** Aggregate status counts over the full matching set. */
  counts: SessionStatusCounts;
}

export interface FetchSessionsParams {
  limit?: number;
  offset?: number;
  q?: string;
}

export async function fetchSessions(params: FetchSessionsParams = {}): Promise<SessionsPage> {
  const search = new URLSearchParams();
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.offset != null) search.set('offset', String(params.offset));
  if (params.q && params.q.trim()) search.set('q', params.q.trim());
  const suffix = search.toString() ? `?${search.toString()}` : '';

  const data = await hermesFetch<{
    sessions?: HermesSession[];
    total?: number;
    counts?: Partial<SessionStatusCounts>;
  }>(`/sessions${suffix}`);

  const sessions = data.sessions ?? [];
  return {
    sessions,
    total: data.total ?? sessions.length,
    counts: {
      active: data.counts?.active ?? 0,
      completed: data.counts?.completed ?? 0,
      error: data.counts?.error ?? 0,
      total: data.counts?.total ?? data.total ?? sessions.length,
    },
  };
}

// Coalesce concurrent requests for the same session. The sidebar
// HermesChatsPanel and the main-area SessionHistoryChat both key off the same
// selectedSessionId and each fetch the detail on select — without this they
// fire two identical round-trips. Cleared the moment the request settles, so a
// later poll still gets fresh data (we dedupe duplicates, we don't cache).
const inflightSessionDetail = new Map<string, Promise<HermesSessionDetail>>();

export function getSession(sessionId: string): Promise<HermesSessionDetail> {
  const existing = inflightSessionDetail.get(sessionId);
  if (existing) return existing;

  const request = hermesFetch<HermesSessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`)
    .finally(() => {
      inflightSessionDetail.delete(sessionId);
    });
  inflightSessionDetail.set(sessionId, request);
  return request;
}

const inflightHermesFetch = new Map<string, Promise<unknown>>();

function coalesceHermesFetch<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflightHermesFetch.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = factory().finally(() => {
    inflightHermesFetch.delete(key);
  });
  inflightHermesFetch.set(key, request);
  return request;
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

// ─── Logs ───────────────────────────────────────────────────────────────

export type HermesLogFile = 'agent' | 'errors' | 'gateway';
export type HermesLogLevel = 'ALL' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface HermesLogEntry {
  ts: string | null;
  level: string;
  component: string;
  message: string;
  raw: string;
}

export interface HermesLogsResponse {
  file: HermesLogFile;
  entries: HermesLogEntry[];
  /** Distinct logger components found in the file, for the filter dropdown. */
  components: string[];
  available_files: HermesLogFile[];
  missing: boolean;
}

export interface FetchHermesLogsParams {
  file?: HermesLogFile;
  level?: HermesLogLevel;
  component?: string;
  lines?: number;
}

export function fetchHermesLogs(params: FetchHermesLogsParams = {}): Promise<HermesLogsResponse> {
  const query = new URLSearchParams();
  if (params.file) query.set('file', params.file);
  if (params.level) query.set('level', params.level);
  if (params.component) query.set('component', params.component);
  if (params.lines) query.set('lines', String(params.lines));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return coalesceHermesFetch(`fetchHermesLogs${suffix}`, () =>
    hermesFetch<HermesLogsResponse>(`/workspace/logs${suffix}`),
  );
}

// ─── System ─────────────────────────────────────────────────────────────

export interface HermesSystemStats {
  host: {
    os: string | null;
    arch: string | null;
    hostname: string | null;
    python_version: string | null;
    cpu_count: number | null;
    load_avg: number[] | null;
    memory_total: number | null;
    disk: { total: number; used: number; free: number } | null;
  };
  gateway: { port: number; reachable: boolean; status: number | null };
  hermes: { version: string | null };
  providers: { active: string | null; count: number };
}

export function fetchHermesSystem(): Promise<HermesSystemStats> {
  return coalesceHermesFetch('fetchHermesSystem', () =>
    hermesFetch<HermesSystemStats>('/workspace/system'),
  );
}

// ─── Webhooks ───────────────────────────────────────────────────────────

export interface HermesWebhook {
  name: string;
  description: string;
  events: string[];
  prompt: string;
  skills: string[];
  deliver: string;
  deliver_only: boolean;
  created_at: string;
  has_secret: boolean;
  secret_preview: string;
  /** Only present in the response to a create call (shown once). */
  secret?: string;
}

export interface CreateWebhookInput {
  name: string;
  description?: string;
  events?: string[];
  prompt?: string;
  skills?: string[];
  deliver?: string;
}

export function fetchHermesWebhooks(): Promise<HermesWebhook[]> {
  return coalesceHermesFetch('fetchHermesWebhooks', async () => {
    const data = await hermesFetch<{ subscriptions: HermesWebhook[] }>('/webhooks');
    return data.subscriptions ?? [];
  });
}

export async function createHermesWebhook(input: CreateWebhookInput): Promise<HermesWebhook> {
  const data = await hermesFetch<{ subscription: HermesWebhook }>('/webhooks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.subscription;
}

export async function deleteHermesWebhook(name: string): Promise<void> {
  await hermesFetch(`/webhooks/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ─── Pairing ────────────────────────────────────────────────────────────

export interface HermesPendingPairing {
  platform: string;
  code: string;
  user_id?: string;
  user_name?: string;
  created_at?: string;
}

export interface HermesApprovedPairing {
  platform: string;
  user_id: string;
  user_name?: string;
  approved_at?: string;
}

export interface HermesPairingState {
  pending: HermesPendingPairing[];
  approved: HermesApprovedPairing[];
}

export function fetchHermesPairing(): Promise<HermesPairingState> {
  return coalesceHermesFetch('fetchHermesPairing', () =>
    hermesFetch<HermesPairingState>('/pairing'),
  );
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

// ─── Slash commands ─────────────────────────────────────────────────────────

export interface HermesAgentCommand {
  name: string;
  description: string;
  category: string;
  usage: string;
  aliases: string[];
  kind: 'agent' | 'skill';
}

/** Catalog of slash commands the installed hermes-agent exposes to a chat
 *  client (built-ins + installed skills + plugin commands). */
export async function fetchHermesAgentCommands(): Promise<HermesAgentCommand[]> {
  const data = await hermesFetch<{ commands: HermesAgentCommand[] }>('/workspace/commands');
  return data.commands ?? [];
}

// ─── Saved providers (hermes-agent auth store) ──────────────────────────────

export interface HermesSavedProvider {
  id: string;
  name: string;
  label: string;
  auth_type: string;
  base_url: string;
  status: 'active' | 'configured' | 'error';
  detail: string;
  active: boolean;
  request_count: number;
}

/** Providers the user has saved/authenticated in their hermes-agent
 *  (~/.hermes/auth.json), with derived status. Read-only. */
export async function fetchHermesSavedProviders(): Promise<HermesSavedProvider[]> {
  const data = await hermesFetch<{ providers: HermesSavedProvider[] }>('/workspace/auth-providers');
  return data.providers ?? [];
}

export async function fetchHermesSkillDetail(skillId: string): Promise<HermesSkillDetail> {
  const params = new URLSearchParams({ id: skillId });
  const data = await hermesFetch<{ skill: HermesSkillDetail }>(`/workspace/skills/content?${params.toString()}`);
  return data.skill;
}

// ─── MCP servers (hermes-agent config.yaml) ─────────────────────────────────

/** An MCP server installed in the hermes-agent's config.yaml. Secrets are
 *  redacted by the bridge (env_keys lists names only). */
export interface HermesMcpServerInfo {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  env_keys: string[];
  tool_count: number;
  /** Non-null when this server came from the curated store catalog (removable). */
  catalog_id: string | null;
}

/** A curated, one-click-installable MCP server. */
export interface HermesMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  runtime: string;
  requires_param: { key: string; label: string; placeholder: string; default: string } | null;
  docs_url: string;
}

/** MCP servers currently installed for the hermes-agent (read from config.yaml). */
export async function fetchHermesMcpServers(): Promise<HermesMcpServerInfo[]> {
  const data = await hermesFetch<{ servers: HermesMcpServerInfo[] }>('/workspace/mcp-servers');
  return data.servers ?? [];
}

/** The curated catalog of MCP servers a user can install with one click. */
export async function fetchHermesMcpCatalog(): Promise<HermesMcpCatalogEntry[]> {
  const data = await hermesFetch<{ catalog: HermesMcpCatalogEntry[] }>('/workspace/mcp-catalog');
  return data.catalog ?? [];
}

/** Install a curated MCP server into the agent's config.yaml and reload it. */
export async function installHermesMcpServer(
  id: string,
  param?: string,
): Promise<{ ok: boolean; installed: string; reloaded: boolean }> {
  return hermesFetch('/workspace/mcp-servers/install', {
    method: 'POST',
    body: JSON.stringify(param ? { id, param } : { id }),
  });
}

/** Remove a store-installed MCP server (agent-managed servers stay read-only). */
export async function uninstallHermesMcpServer(
  name: string,
): Promise<{ ok: boolean; removed: string; reloaded: boolean }> {
  return hermesFetch(`/workspace/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ─── MCP live telemetry (dashboard) ─────────────────────────────────────────

/** Live connection status for one MCP server (from the agent's in-process MCP layer). */
export interface HermesMcpLiveStatus {
  name: string;
  transport: 'stdio' | 'http';
  tools: number;
  connected: boolean;
  disabled: boolean;
  status: 'connected' | 'connecting' | 'disabled' | 'failed' | 'configured' | string;
  error?: string;
}

/** A single recorded MCP tool call. */
export interface HermesMcpCall {
  server: string;
  tool: string;
  ts: number;
  latency_ms: number | null;
  ok: boolean;
  input: string;
  output: string;
}

/** Per-server tool-call metrics. ``buckets`` are [epochMinute, calls, errors]. */
export interface HermesMcpServerStats {
  calls: number;
  errors: number;
  avg_latency_ms: number | null;
  last_call_at: number | null;
  last_tool: string | null;
  last_error: string | null;
  recent: HermesMcpCall[];
  buckets: [number, number, number][];
}

/** Full live telemetry snapshot powering the MCP dashboard. */
export interface HermesMcpTelemetry {
  generated_at: number;
  tracking_since: number;
  status: HermesMcpLiveStatus[];
  tools: Record<string, string[]>;
  servers: Record<string, HermesMcpServerStats>;
  recent: HermesMcpCall[];
}

/** Fetch the live MCP telemetry snapshot (status + per-server metrics + activity). */
export async function fetchHermesMcpTelemetry(): Promise<HermesMcpTelemetry> {
  return hermesFetch<HermesMcpTelemetry>('/workspace/mcp-telemetry');
}

/** A single tailed MCP stderr log line for one server. */
export interface HermesMcpLogLine {
  ts: string | null;
  line: string;
  marker: boolean;
}

/** Tail a single MCP server's stderr log (most recent lines). */
export async function fetchHermesMcpServerLogs(
  name: string,
  limit = 200,
): Promise<HermesMcpLogLine[]> {
  const data = await hermesFetch<{ server: string; lines: HermesMcpLogLine[] }>(
    `/workspace/mcp-servers/${encodeURIComponent(name)}/logs?limit=${limit}`,
  );
  return data.lines ?? [];
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
