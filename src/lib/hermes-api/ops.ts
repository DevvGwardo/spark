import { hermesFetch } from './core';

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
