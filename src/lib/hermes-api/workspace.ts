import { coalesceHermesFetch, hermesFetch } from './core';

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

export async function fetchCursorComposerBridge(): Promise<CursorComposerBridgeStatus> {
  return hermesFetch<CursorComposerBridgeStatus>('/bridges/cursor-composer');
}

export async function fetchHermesDashboardUrl(): Promise<{ ok: boolean; url: string | null; error?: string }> {
  return hermesFetch('/dashboard/url');
}

// ─── Workspace ─────────────────────────────────────────────────────────────

export async function fetchHermesWorkspaceOverview(): Promise<HermesWorkspaceOverview> {
  return hermesFetch<HermesWorkspaceOverview>('/workspace/overview');
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
