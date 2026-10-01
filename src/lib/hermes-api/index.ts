/**
 * Hermes bridge REST client, split by domain (hardening spec 6.5).
 *
 * Import from `@/lib/hermes-api`; this barrel re-exports every domain module.
 * The transport internals in `./core` (`hermesFetch`, `abortAfter`,
 * `coalesceHermesFetch`) are deliberately not re-exported.
 */
import { abortAfter, hermesFetch } from './core';

export { HermesApiError, HERMES_FETCH_TIMEOUT_MS } from './core';
export * from './approvals';
export * from './providers';
export * from './portal';
export * from './cron';
export * from './sessions';
export * from './workspace';

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

export async function fetchHermesWorkspaceUsage(): Promise<HermesUsageOverview> {
  return hermesFetch<HermesUsageOverview>('/workspace/usage');
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
