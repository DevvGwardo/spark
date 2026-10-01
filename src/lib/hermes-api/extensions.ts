import { hermesFetch } from './core';

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
