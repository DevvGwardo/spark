import { hermesFetch } from './core';

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
