import { getApiBaseUrl } from './api';

// Client for CloudChat's authoritative cron-archive store (server-side SQLite).
// Archive state lives in CloudChat, not Hermes, so it is durable and shared
// across every CloudChat surface hitting this embedded server.

export interface CronArchiveEntry {
  jobId: string;
  archivedAt: string;
}

export async function fetchArchivedJobIds(): Promise<CronArchiveEntry[]> {
  const res = await fetch(`${getApiBaseUrl()}/api/cron-archive`);
  if (!res.ok) {
    throw new Error(`Failed to fetch archived jobs (${res.status})`);
  }
  const data = (await res.json()) as { archived?: CronArchiveEntry[] };
  return data.archived ?? [];
}

export async function archiveJobOnServer(jobId: string): Promise<CronArchiveEntry> {
  const res = await fetch(`${getApiBaseUrl()}/api/cron-archive/${encodeURIComponent(jobId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    throw new Error(`Failed to archive job (${res.status})`);
  }
  const data = (await res.json()) as { entry: CronArchiveEntry };
  return data.entry;
}

export async function restoreJobOnServer(jobId: string): Promise<void> {
  const res = await fetch(`${getApiBaseUrl()}/api/cron-archive/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`Failed to restore job (${res.status})`);
  }
}
