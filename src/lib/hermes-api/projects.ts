import { hermesFetch } from './core';

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
