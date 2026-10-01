/**
 * Hermes bridge REST client, split by domain (hardening spec 6.5).
 *
 * Import from `@/lib/hermes-api`; this barrel re-exports every domain module.
 * The transport internals in `./core` (`hermesFetch`, `abortAfter`,
 * `coalesceHermesFetch`) are deliberately not re-exported.
 */
import { hermesFetch } from './core';

export { HermesApiError, HERMES_FETCH_TIMEOUT_MS } from './core';
export * from './approvals';
export * from './providers';
export * from './portal';
export * from './cron';
export * from './sessions';
export * from './workspace';
export * from './usage';
export * from './skills';
export * from './mcp';
export * from './memory';
export * from './checkpoints';

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

export interface ComputerUseStatus {
  ok: boolean;
  installed: boolean;
  raw: string;
}

export async function fetchComputerUseStatus(): Promise<ComputerUseStatus> {
  return hermesFetch<ComputerUseStatus>('/computer-use/status');
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
