import { getApiBaseUrl } from './api';
import { getActiveProfile } from '@/stores/profiles-store';

const BRIDGE_BASE = '/api/hermes';

/** jsdom / older runtimes may lack AbortSignal.timeout — polyfill with AbortController. */
function abortAfter(ms: number): AbortSignal {
  const timeoutFn = (AbortSignal as typeof AbortSignal & {
    timeout?: (delay: number) => AbortSignal;
  }).timeout;
  if (typeof timeoutFn === 'function') {
    return timeoutFn(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Avoid keeping the process awake in Node if the request finishes early.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  return controller.signal;
}

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
  content?: string;
  parts?: any[];
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

/** Default client timeout for bridge ops. Long CLI jobs pass a longer signal. */
export const HERMES_FETCH_TIMEOUT_MS = 15_000;

async function hermesFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}${BRIDGE_BASE}${path}`, {
    ...options,
    signal: options?.signal ?? abortAfter(HERMES_FETCH_TIMEOUT_MS),
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
  /** Present on the synthetic CLI custom base_url row from /v1/providers. */
  default_model?: string;
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

// ─── Mixture of Agents ────────────────────────────────────────────────────

export interface MoaModelRef {
  provider: string;
  model: string;
}

export interface MoaPreset {
  name: string;
  enabled: boolean;
  reference_models: MoaModelRef[];
  aggregator: MoaModelRef;
  reference_temperature?: number | null;
  aggregator_temperature?: number | null;
  max_tokens?: number | null;
  reference_max_tokens?: number | null;
  fanout?: 'per_iteration' | 'user_turn';
}

export interface MoaConfig {
  default_preset: string;
  presets: Record<string, MoaPreset>;
  preset_names: string[];
}

export interface AcpApprovalRequest {
  approval_id: string;
  session_id: string;
  tool: string;
  kind?: string;
  summary?: string;
  excerpt?: string;
  options?: Array<{ option_id: string; name: string }>;
  /** Extended contract (bridge + server): shell command under approval. */
  command?: string;
  /** Working directory for the command. */
  cwd?: string;
  /** Human-readable reason for the approval request. */
  reason?: string;
  /** Fixed decision set the backend accepts for this request (server
   *  approval-engine and the enriched bridge payloads both emit it). */
  available_decisions?: string[];
}

/** The user's decision on an ACP permission request (once/session/always/deny). */
export type AcpApprovalDecision = 'allow_once' | 'allow_session' | 'allow_always' | 'deny';

/**
 * POST an ACP approval decision to the bridge. The bridge resolves the
 * hermes-agent's parked permission request and the agent resumes.
 */
export async function postAcpApproval(
  approvalId: string,
  optionId: AcpApprovalDecision,
): Promise<{ ok: boolean }> {
  return hermesFetch<{ ok: boolean }>(`/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    body: JSON.stringify({ option_id: optionId }),
  });
}

// ─── Server-side tool approvals (approval-engine) ───────────────────────────

/** Decision on a server-side tool approval (POST /api/hermes/approvals/:id). */
export type ServerApprovalDecision = 'approved' | 'approved_for_session' | 'denied';

/**
 * POST a server-side tool approval decision. The Express server resolves
 * parked approvals from its approval-engine; the contract mirrors the
 * bridge's ACP /v1/approvals/{id} flow so the client uses one endpoint for
 * both paths.
 */
export async function postServerApproval(
  approvalId: string,
  decision: ServerApprovalDecision,
  reason?: string,
): Promise<{ ok: boolean; approval_id: string; decision: string }> {
  return hermesFetch<{ ok: boolean; approval_id: string; decision: string }>(
    `/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
    },
  );
}

export async function fetchMoaConfig(): Promise<MoaConfig> {
  const data = await hermesFetch<{
    default_preset?: string;
    presets?: Record<string, MoaPreset>;
    preset_names?: string[];
  }>('/moa');
  return {
    default_preset: data.default_preset || 'default',
    presets: data.presets && typeof data.presets === 'object' ? data.presets : {},
    preset_names: Array.isArray(data.preset_names) ? data.preset_names : [],
  };
}

export async function updateMoaConfig(body: {
  default_preset?: string;
  presets?: Record<string, MoaPreset | Record<string, unknown>>;
  preset?: MoaPreset & { delete?: boolean };
}): Promise<MoaConfig> {
  const data = await hermesFetch<{
    default_preset?: string;
    presets?: Record<string, MoaPreset>;
    preset_names?: string[];
  }>('/moa', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return {
    default_preset: data.default_preset || 'default',
    presets: data.presets && typeof data.presets === 'object' ? data.presets : {},
    preset_names: Array.isArray(data.preset_names) ? data.preset_names : [],
  };
}

export async function fetchCursorComposerBridge(): Promise<CursorComposerBridgeStatus> {
  return hermesFetch<CursorComposerBridgeStatus>('/bridges/cursor-composer');
}

// ─── Ops: fallback, checkpoints, memory, curator, goals, insights ─────────

export interface FallbackProvider {
  provider: string;
  model: string;
  base_url?: string;
}

export async function fetchFallbackProviders(): Promise<FallbackProvider[]> {
  const data = await hermesFetch<{ providers?: FallbackProvider[] }>('/fallback');
  return Array.isArray(data.providers) ? data.providers : [];
}

export async function updateFallbackProviders(providers: FallbackProvider[]): Promise<FallbackProvider[]> {
  const data = await hermesFetch<{ providers?: FallbackProvider[] }>('/fallback', {
    method: 'PUT',
    body: JSON.stringify({ providers }),
  });
  return Array.isArray(data.providers) ? data.providers : [];
}

export interface CheckpointProject {
  workdir: string;
  commits: number;
  last_touch: string;
  state: string;
}

export interface CheckpointEntry {
  index: number;
  path: string;
  label: string;
  mtime?: string | null;
  short_hash?: string | null;
  files_changed?: number;
}

export interface CheckpointsStatus {
  available: boolean;
  base_path: string;
  exists: boolean;
  total_size: string | null;
  store_size: string | null;
  projects: CheckpointProject[];
  cli_ok: boolean;
  error?: string | null;
  raw_summary?: string | null;
  entries?: CheckpointEntry[];
  workdir?: string | null;
  entries_error?: string | null;
}

export async function fetchCheckpoints(workdir?: string): Promise<CheckpointsStatus> {
  const suffix = workdir ? `?workdir=${encodeURIComponent(workdir)}` : '';
  return hermesFetch<CheckpointsStatus>(`/checkpoints${suffix}`);
}

export interface DelegationLiveManifest {
  object?: string;
  delegation_id: string;
  started?: string;
  completed?: string;
  task_count?: number;
  tasks?: Array<{
    index: number;
    goal?: string;
    log?: string;
    status?: string;
  }>;
}

export interface DelegationLiveTail {
  object?: string;
  delegation_id: string;
  task_index: number;
  offset: number;
  next_offset: number;
  done: boolean;
  text: string;
  lines: string[];
  size?: number;
}

export async function fetchDelegationLiveLatest(): Promise<DelegationLiveManifest> {
  return hermesFetch<DelegationLiveManifest>('/delegation/live/latest');
}

export async function fetchDelegationLiveManifest(
  delegationId: string,
): Promise<DelegationLiveManifest> {
  return hermesFetch<DelegationLiveManifest>(
    `/delegation/live/${encodeURIComponent(delegationId)}`,
  );
}

export async function fetchDelegationLiveTail(
  delegationId: string,
  taskIndex: number,
  offset = 0,
): Promise<DelegationLiveTail> {
  return hermesFetch<DelegationLiveTail>(
    `/delegation/live/${encodeURIComponent(delegationId)}/task/${taskIndex}?offset=${offset}`,
  );
}

export async function pruneCheckpoints(): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/checkpoints/prune', { method: 'POST', body: '{}' });
}

export interface CheckpointRestoreResult {
  ok: boolean;
  index?: number;
  workdir?: string;
  restored_to?: string;
  reason?: string;
  hash?: string;
  error?: string;
}

export async function restoreCheckpoint(
  index: number,
  workdir?: string,
): Promise<CheckpointRestoreResult> {
  return hermesFetch<CheckpointRestoreResult>('/checkpoints/restore', {
    method: 'POST',
    body: JSON.stringify({
      index,
      ...(workdir ? { workdir } : {}),
    }),
  });
}

export interface MemoryStatus {
  ok: boolean;
  provider: string | null;
  plugin_available: boolean | null;
  builtin: boolean;
  raw: string;
}

export async function fetchMemoryStatus(): Promise<MemoryStatus> {
  return hermesFetch<MemoryStatus>('/memory/status');
}

export interface CuratorStatus {
  ok: boolean;
  enabled: boolean | null;
  last_run: string | null;
  runs: number | null;
  raw: string;
}

export async function fetchCuratorStatus(): Promise<CuratorStatus> {
  return hermesFetch<CuratorStatus>('/curator/status');
}

export async function runCurator(): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/curator/run', { method: 'POST', body: '{}' });
}

export interface ComputerUseStatus {
  ok: boolean;
  installed: boolean;
  raw: string;
}

export async function fetchComputerUseStatus(): Promise<ComputerUseStatus> {
  return hermesFetch<ComputerUseStatus>('/computer-use/status');
}

export interface SkillBundle {
  name: string;
  slug?: string;
  path: string;
  skills: string[];
  description?: string | null;
  instruction?: string | null;
}

export async function fetchSkillBundles(): Promise<{ bundles: SkillBundle[]; directory: string }> {
  const data = await hermesFetch<{ bundles?: SkillBundle[]; directory?: string }>('/bundles');
  return {
    bundles: Array.isArray(data.bundles) ? data.bundles : [],
    directory: data.directory || '',
  };
}

export async function fetchSkillBundle(name: string): Promise<{
  ok: boolean;
  bundle: SkillBundle | null;
  error?: string;
}> {
  return hermesFetch(`/bundles/${encodeURIComponent(name)}`);
}

export async function createSkillBundle(body: {
  name: string;
  skills: string[];
  description?: string;
  instruction?: string;
  force?: boolean;
}): Promise<{
  ok: boolean;
  name: string;
  skills: string[];
  bundles: SkillBundle[];
  bundle: SkillBundle | null;
  output?: string;
  error?: string;
}> {
  return hermesFetch('/bundles/create', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deleteSkillBundle(name: string): Promise<{
  ok: boolean;
  name: string;
  bundles: SkillBundle[];
  output?: string;
  error?: string;
}> {
  return hermesFetch('/bundles/delete', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function reloadSkillBundles(): Promise<{
  ok: boolean;
  bundles: SkillBundle[];
  directory?: string;
  output?: string;
  error?: string;
}> {
  return hermesFetch('/bundles/reload', { method: 'POST', body: '{}' });
}

export async function fetchHermesDashboardUrl(): Promise<{ ok: boolean; url: string | null; error?: string }> {
  return hermesFetch('/dashboard/url');
}

export interface GoalsConfig {
  max_turns: number;
  enabled: boolean;
}

export async function fetchGoalsConfig(): Promise<GoalsConfig> {
  const data = await hermesFetch<Partial<GoalsConfig>>('/goals');
  return {
    max_turns: typeof data.max_turns === 'number' ? data.max_turns : 20,
    enabled: data.enabled !== false,
  };
}

export async function updateGoalsConfig(body: Partial<GoalsConfig>): Promise<GoalsConfig> {
  const data = await hermesFetch<Partial<GoalsConfig>>('/goals', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return {
    max_turns: typeof data.max_turns === 'number' ? data.max_turns : 20,
    enabled: data.enabled !== false,
  };
}

export async function fetchInsights(days = 7): Promise<{ ok: boolean; days: number; report: string }> {
  return hermesFetch(`/insights?days=${days}`, {
    signal: abortAfter(60_000),
  });
}

// ─── Journey / learning graph ─────────────────────────────────────────────

export interface JourneyNode {
  id: string;
  label?: string;
  kind?: string;
  timestamp?: number;
  category?: string;
  useCount?: number;
  state?: string;
  createdBy?: string | null;
  pinned?: boolean;
}

export interface JourneyGraph {
  ok: boolean;
  node_count: number;
  edge_count: number;
  nodes: JourneyNode[];
  edges: Array<Record<string, unknown>>;
  error?: string | null;
}

export async function fetchJourneyGraph(): Promise<JourneyGraph> {
  return hermesFetch<JourneyGraph>('/journey');
}

// ─── Computer use install / doctor ────────────────────────────────────────

export async function installComputerUse(): Promise<{
  ok: boolean;
  output: string;
  status: ComputerUseStatus;
}> {
  return hermesFetch('/computer-use/install', { method: 'POST', body: '{}' });
}

export async function doctorComputerUse(): Promise<{
  ok: boolean;
  report: string;
  status: ComputerUseStatus;
}> {
  return hermesFetch('/computer-use/doctor');
}

// ─── Plugins / hooks / LSP ────────────────────────────────────────────────

export interface HermesPlugin {
  name: string;
  status: string;
  enabled: boolean;
  version: string | null;
  description: string | null;
  source: string | null;
}

export interface PluginsStatus {
  ok: boolean;
  cli_ok?: boolean;
  total: number;
  enabled_count: number;
  plugins: HermesPlugin[];
  error?: string | null;
}

export async function fetchPluginsStatus(limit = 120): Promise<PluginsStatus> {
  const data = await hermesFetch<PluginsStatus>(`/plugins?limit=${limit}`);
  return {
    ...data,
    plugins: Array.isArray(data.plugins) ? data.plugins : [],
    total: data.total ?? 0,
    enabled_count: data.enabled_count ?? 0,
  };
}

export async function enablePlugin(
  name: string,
  options?: { allowToolOverride?: boolean },
): Promise<PluginsStatus & { output?: string }> {
  return hermesFetch('/plugins/enable', {
    method: 'POST',
    body: JSON.stringify({
      name,
      allow_tool_override: options?.allowToolOverride === true,
    }),
  });
}

export async function disablePlugin(name: string): Promise<PluginsStatus & { output?: string }> {
  return hermesFetch('/plugins/disable', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export interface HermesHook {
  event: string;
  command: string;
  timeout_s: number;
  allowed: boolean;
  status_hint?: string | null;
  approved_at?: string | null;
  warning?: string | null;
}

export interface HooksStatus {
  ok: boolean;
  total: number;
  issue_hints: number;
  hooks: HermesHook[];
  error?: string | null;
}

export async function fetchHooksStatus(): Promise<HooksStatus> {
  const data = await hermesFetch<HooksStatus>('/hooks');
  return {
    ...data,
    hooks: Array.isArray(data.hooks) ? data.hooks : [],
    total: data.total ?? 0,
    issue_hints: data.issue_hints ?? 0,
  };
}

export interface HooksDoctorReport {
  ok: boolean;
  issue_count: number;
  entries: Array<{
    event: string;
    command: string;
    checks: string[];
    warning?: string;
  }>;
  hooks: HermesHook[];
  report: string;
  error?: string | null;
}

export async function doctorHooks(): Promise<HooksDoctorReport> {
  return hermesFetch<HooksDoctorReport>('/hooks/doctor');
}

export interface LspRegistryEntry {
  server_id: string;
  binary_status: string;
  description: string;
  extensions: string[];
}

export interface LspStatus {
  ok: boolean;
  enabled: boolean | null;
  wait_mode?: string | null;
  wait_timeout?: number | null;
  active_clients: number;
  installed_count: number;
  missing_count: number;
  registry: LspRegistryEntry[];
  raw?: string | null;
  error?: string | null;
}

export async function fetchLspStatus(): Promise<LspStatus> {
  const data = await hermesFetch<LspStatus>('/lsp/status');
  return {
    ...data,
    registry: Array.isArray(data.registry) ? data.registry : [],
    active_clients: data.active_clients ?? 0,
    installed_count: data.installed_count ?? 0,
    missing_count: data.missing_count ?? 0,
  };
}

// ─── Pets ─────────────────────────────────────────────────────────────────

export interface PetsStatus {
  ok: boolean;
  configured: boolean;
  config: { name: string | null; scale?: number; enabled: boolean };
  show: string | null;
  raw: string;
  gallery_hint: string;
}

export interface PetGalleryEntry {
  id: string;
  label: string;
  kind: string;
}

export async function fetchPetsStatus(): Promise<PetsStatus> {
  return hermesFetch<PetsStatus>('/pets');
}

export async function fetchPetsGallery(limit = 40): Promise<PetGalleryEntry[]> {
  const data = await hermesFetch<{ pets?: PetGalleryEntry[] }>(`/pets/gallery?limit=${limit}`);
  return Array.isArray(data.pets) ? data.pets : [];
}

export async function selectPet(petId: string): Promise<{ ok: boolean; status: PetsStatus }> {
  return hermesFetch('/pets/select', {
    method: 'POST',
    body: JSON.stringify({ pet_id: petId }),
  });
}

// ─── Hermes projects (multi-folder workspaces) ────────────────────────────

export interface HermesProjectFolder {
  path: string;
  label?: string | null;
  is_primary: boolean;
  added_at?: number;
}

export interface HermesProject {
  id: string | null;
  slug: string;
  name: string;
  description?: string | null;
  board_slug?: string | null;
  primary_path?: string | null;
  archived?: boolean;
  active?: boolean;
  folder_count?: number;
  folders: HermesProjectFolder[];
}

export interface HermesProjectsList {
  ok: boolean;
  projects: HermesProject[];
  active_id?: string | null;
  active_slug?: string | null;
  source?: string;
  error?: string | null;
}

export async function fetchHermesProjects(includeArchived = false): Promise<HermesProjectsList> {
  const suffix = includeArchived ? '?all=1' : '';
  return hermesFetch<HermesProjectsList>(`/projects${suffix}`);
}

export async function activateHermesProject(project: string): Promise<HermesProjectsList & { output?: string }> {
  return hermesFetch('/projects/use', {
    method: 'POST',
    body: JSON.stringify({ project }),
  });
}

export async function createHermesProject(body: {
  name: string;
  primary_folder?: string;
  use?: boolean;
}): Promise<HermesProjectsList & { created_slug?: string | null; output?: string }> {
  return hermesFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function bindHermesProjectBoard(body: {
  project: string;
  board?: string;
}): Promise<HermesProjectsList & { board_slug?: string | null; output?: string }> {
  return hermesFetch('/projects/bind-board', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─── Security audit / secrets managers ────────────────────────────────────

export interface SecurityAuditFinding {
  package: string;
  version: string;
  ecosystem: string;
  source: string;
  vuln_id: string;
  severity: string;
  summary: string;
  fixed_versions: string[];
}

export interface SecurityAuditReport {
  ok: boolean;
  exit_code?: number;
  total_components_scanned: number;
  finding_count: number;
  severity_counts: Record<string, number>;
  findings: SecurityAuditFinding[];
  summary?: string;
  error?: string | null;
}

export async function fetchSecurityAudit(options?: { skipVenv?: boolean }): Promise<SecurityAuditReport> {
  const params = options?.skipVenv ? '?skip_venv=1' : '';
  const data = await hermesFetch<SecurityAuditReport>(`/security/audit${params}`);
  return {
    ...data,
    findings: Array.isArray(data.findings) ? data.findings : [],
    severity_counts: data.severity_counts ?? {},
    total_components_scanned: data.total_components_scanned ?? 0,
    finding_count: data.finding_count ?? 0,
  };
}

export interface SecretsProviderStatus {
  id: string;
  label: string;
  cli_ok: boolean;
  enabled: boolean;
  configured: boolean;
  token_in_env: boolean;
  binary: string;
  reference_count?: number | null;
  project_configured?: boolean | null;
}

export interface SecretsStatus {
  ok: boolean;
  any_enabled: boolean;
  any_configured: boolean;
  providers: SecretsProviderStatus[];
}

export async function fetchSecretsStatus(): Promise<SecretsStatus> {
  const data = await hermesFetch<SecretsStatus>('/secrets/status');
  return {
    ...data,
    providers: Array.isArray(data.providers) ? data.providers : [],
    any_enabled: !!data.any_enabled,
    any_configured: !!data.any_configured,
  };
}

// ─── OpenClaw migration ───────────────────────────────────────────────────

export async function clawMigrate(options: {
  dry_run?: boolean;
  migrate_secrets?: boolean;
  yes?: boolean;
}): Promise<{ ok: boolean; dry_run: boolean; report: string }> {
  return hermesFetch('/claw/migrate', {
    method: 'POST',
    body: JSON.stringify({
      dry_run: options.dry_run !== false,
      migrate_secrets: !!options.migrate_secrets,
      yes: !!options.yes,
    }),
  });
}

// ─── Gateway capabilities (/v1/runs foundation) ───────────────────────────

export interface GatewayCapabilities {
  reachable: boolean;
  base_url: string;
  features: Record<string, unknown>;
  run_submission?: boolean;
  session_fork?: boolean;
  skills_api?: boolean;
  recommended_transport: 'runs' | 'bridge' | string;
  error?: string;
}

export async function fetchGatewayCapabilities(): Promise<GatewayCapabilities> {
  return hermesFetch<GatewayCapabilities>('/gateway/capabilities');
}

// ─── Kanban swarm ─────────────────────────────────────────────────────────

export async function createKanbanSwarm(input: {
  goal: string;
  workers?: string[];
  verifier?: string;
  synthesizer?: string;
}): Promise<{ ok: boolean; output?: string; error?: string; result?: unknown }> {
  return hermesFetch('/kanban/swarm', {
    method: 'POST',
    body: JSON.stringify(input),
  });
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

/** Resolve a Hermes session for `/resume` — exact id, prefix match, or most recent. */
export async function resolveHermesSessionForResume(spec?: string): Promise<HermesSessionDetail> {
  const trimmed = spec?.trim() ?? '';
  if (trimmed) {
    try {
      return await getSession(trimmed);
    } catch {
      const { sessions } = await fetchSessions({ limit: 50, q: trimmed });
      const match =
        sessions.find((s) => s.id === trimmed) ??
        sessions.find((s) => s.id.startsWith(trimmed));
      if (!match) {
        throw new Error(`No Hermes session found matching "${trimmed}"`);
      }
      return getSession(match.id);
    }
  }

  const { sessions } = await fetchSessions({ limit: 1 });
  const recent = sessions[0];
  if (!recent) {
    throw new Error('No Hermes sessions available to resume.');
  }
  return getSession(recent.id);
}

export function hermesSessionTitle(session: Pick<HermesSession, 'id' | 'firstUserMessage'>): string {
  return session.firstUserMessage?.trim().length
    ? session.firstUserMessage.trim()
    : `Session ${session.id.slice(0, 8)}`;
}

export interface ForkHermesSessionResult {
  object: string;
  session: HermesSession & {
    parent_session_id?: string;
    title?: string;
  };
}

export async function forkHermesSession(
  sessionId: string,
  options?: { title?: string },
): Promise<ForkHermesSessionResult> {
  const body: Record<string, string> = {};
  const title = options?.title?.trim();
  if (title) body.title = title;
  return hermesFetch<ForkHermesSessionResult>(
    `/sessions/${encodeURIComponent(sessionId)}/fork`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

// ─── Workspace ─────────────────────────────────────────────────────────────

export async function fetchHermesWorkspaceOverview(): Promise<HermesWorkspaceOverview> {
  return hermesFetch<HermesWorkspaceOverview>('/workspace/overview');
}

export async function fetchHermesWorkspaceUsage(): Promise<HermesUsageOverview> {
  return hermesFetch<HermesUsageOverview>('/workspace/usage');
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

// ─── Auth credential pool (hermes auth) ───────────────────────────────────

export interface AuthPoolCredential {
  index: number;
  id: string | null;
  label: string;
  auth_type: string;
  source: string;
  masked_key: string;
  exhausted: boolean;
  active: boolean;
  priority: number;
  request_count: number;
  last_status: string | null;
  last_error_code: number | null;
  last_error_message: string | null;
  status_hint?: string | null;
}

export interface AuthPoolProvider {
  provider: string;
  credential_count: number;
  active_provider: boolean;
  logged_in: boolean | null;
  status_error: string | null;
  credentials: AuthPoolCredential[];
}

export interface AuthPoolStatus {
  ok: boolean;
  cli_ok: boolean;
  active_provider: string | null;
  providers: AuthPoolProvider[];
  error?: string | null;
}

export async function fetchAuthPool(): Promise<AuthPoolStatus> {
  return hermesFetch<AuthPoolStatus>('/auth/pool');
}

export async function resetAuthPoolProvider(provider: string): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/auth/pool/reset', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export async function removeAuthPoolCredential(
  provider: string,
  target: string | number,
): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/auth/pool/remove', {
    method: 'POST',
    body: JSON.stringify({ provider, target: String(target) }),
  });
}

export async function addAuthPoolApiKey(
  provider: string,
  apiKey: string,
  label?: string,
): Promise<{ ok: boolean; output: string }> {
  return hermesFetch('/auth/pool/add', {
    method: 'POST',
    body: JSON.stringify({ provider, api_key: apiKey, ...(label ? { label } : {}) }),
  });
}

// ─── Nous Portal (hermes portal) ────────────────────────────────────────────

export interface PortalToolGatewayRow {
  label: string;
  status_text: string;
  via_nous: boolean;
  active: boolean;
  configured: boolean;
  provider: string | null;
  partner?: string;
}

export interface PortalInfo {
  ok: boolean;
  cli_ok?: boolean;
  logged_in: boolean;
  logged_out: boolean;
  portal_url: string | null;
  inference_base_url: string | null;
  signup_url: string | null;
  model_hint: string | null;
  using_nous_provider: boolean;
  tool_gateway: PortalToolGatewayRow[];
  docs_url: string | null;
  error?: string | null;
}

export interface PortalToolsCatalog {
  ok: boolean;
  cli_ok?: boolean;
  tools: PortalToolGatewayRow[];
  nous_auth_present: boolean;
  subscription_url: string;
  docs_url: string;
  error?: string | null;
}

export interface PortalOpenUrls {
  ok: boolean;
  portal_url: string;
  subscription_url: string;
  login_url: string;
  docs_url: string;
  logged_in: boolean;
  login_hint: string;
}

export interface PortalOAuthStart {
  ok: boolean;
  session_id?: string;
  user_code?: string;
  verification_url?: string;
  expires_in?: number;
  poll_interval?: number;
  already_logged_in?: boolean;
  logged_in?: boolean;
  imported_shared_state?: boolean;
  error?: string;
}

export interface PortalOAuthPoll {
  ok: boolean;
  session_id: string;
  status: 'pending' | 'complete' | 'error' | 'expired' | 'not_found';
  poll_interval?: number;
  logged_in?: boolean;
  error?: string;
}

export async function fetchPortalInfo(): Promise<PortalInfo> {
  return hermesFetch<PortalInfo>('/portal/info');
}

export async function fetchPortalTools(): Promise<PortalToolsCatalog> {
  return hermesFetch<PortalToolsCatalog>('/portal/tools');
}

export async function fetchPortalOpenUrls(): Promise<PortalOpenUrls> {
  return hermesFetch<PortalOpenUrls>('/portal/open-url');
}

export async function startPortalOAuth(): Promise<PortalOAuthStart> {
  return hermesFetch<PortalOAuthStart>('/portal/oauth/start', { method: 'POST' });
}

export async function pollPortalOAuth(sessionId: string): Promise<PortalOAuthPoll> {
  return hermesFetch<PortalOAuthPoll>(
    `/portal/oauth/poll/${encodeURIComponent(sessionId)}`,
  );
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

/** One entry in the searchable MCP tool index (from the agent registry). */
export interface HermesMcpToolIndexEntry {
  server: string;
  name: string;
  description: string;
}

/** Context threshold above which we warn that MCP tools may bloat agent context. */
export const MCP_TOOL_CONTEXT_THRESHOLD = 40;

/** Fetch flattened MCP tools (name + description) for the searchable index. */
export async function fetchHermesMcpToolIndex(): Promise<{
  tools: HermesMcpToolIndexEntry[];
  total: number;
}> {
  const data = await hermesFetch<{ tools?: HermesMcpToolIndexEntry[]; total?: number }>(
    '/workspace/mcp-tool-index',
  );
  const tools = data.tools ?? [];
  return { tools, total: data.total ?? tools.length };
}

/** Hermes progressive tool disclosure config (`tools.tool_search` in config.yaml). */
export interface ToolSearchConfig {
  /** `auto` defers when over threshold; `on` always defers; `off` disables. */
  enabled: 'auto' | 'on' | 'off';
  /** Convenience mirror of enabled !== 'off'. */
  defer: boolean;
  threshold_pct: number;
  search_default_limit: number;
  max_search_limit: number;
}

export async function fetchToolSearchConfig(): Promise<ToolSearchConfig> {
  const data = await hermesFetch<Partial<ToolSearchConfig>>('/tool-search');
  return {
    enabled: (data.enabled as ToolSearchConfig['enabled']) ?? 'auto',
    defer: data.defer ?? data.enabled !== 'off',
    threshold_pct: data.threshold_pct ?? 10,
    search_default_limit: data.search_default_limit ?? 5,
    max_search_limit: data.max_search_limit ?? 20,
  };
}

export async function updateToolSearchConfig(
  body: Partial<Pick<ToolSearchConfig, 'defer' | 'enabled' | 'threshold_pct'>>,
): Promise<ToolSearchConfig> {
  const data = await hermesFetch<Partial<ToolSearchConfig>>('/tool-search', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return {
    enabled: (data.enabled as ToolSearchConfig['enabled']) ?? 'auto',
    defer: data.defer ?? data.enabled !== 'off',
    threshold_pct: data.threshold_pct ?? 10,
    search_default_limit: data.search_default_limit ?? 5,
    max_search_limit: data.max_search_limit ?? 20,
  };
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
