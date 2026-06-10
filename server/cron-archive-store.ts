import { logger } from './lib/logger';
import type express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ─── Authoritative scheduled-deployment archive ──────────────────────────────
//
// Hermes owns cron execution but has no "archive" concept. CloudChat models
// archive the same way it already models conversation archive (chat-store.ts):
// a nullable `archived_at` timestamp. Storing it in CloudChat's own SQLite makes
// archive durable and shared across every CloudChat surface (web, Electron,
// mobile) hitting this embedded server — without touching the Hermes repo.

interface CronArchiveRow {
  job_id: string;
  archived_at: string;
}

export interface CronArchiveEntry {
  jobId: string;
  archivedAt: string;
}

function resolveDbPath(): string {
  if (process.env.CLOUDCHAT_CRON_ARCHIVE_DB_PATH) {
    return process.env.CLOUDCHAT_CRON_ARCHIVE_DB_PATH;
  }
  if (process.env.VITEST) {
    return ':memory:';
  }
  if (process.env.CLOUDCHAT_USER_DATA_DIR) {
    return join(process.env.CLOUDCHAT_USER_DATA_DIR, 'cron-archive.sqlite');
  }
  return join(homedir(), '.cloudchat', 'cron-archive.sqlite');
}

function ensureParentDirectory(dbPath: string) {
  if (dbPath === ':memory:') {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cron_archive (
    job_id TEXT PRIMARY KEY,
    archived_at TEXT NOT NULL
  );
`;

export function createCronArchiveStore(dbPath = resolveDbPath()) {
  ensureParentDirectory(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare(SCHEMA_SQL).run();

  const selectAll = db.prepare('SELECT job_id, archived_at FROM cron_archive ORDER BY archived_at DESC');
  const selectOne = db.prepare('SELECT job_id, archived_at FROM cron_archive WHERE job_id = :jobId');
  const insertIfAbsent = db.prepare(
    'INSERT INTO cron_archive (job_id, archived_at) VALUES (:jobId, :archivedAt) ' +
      'ON CONFLICT(job_id) DO NOTHING',
  );
  const remove = db.prepare('DELETE FROM cron_archive WHERE job_id = :jobId');

  return {
    list(): CronArchiveEntry[] {
      const rows = selectAll.all() as unknown as CronArchiveRow[];
      return rows.map((row) => ({ jobId: row.job_id, archivedAt: row.archived_at }));
    },
    // Idempotent: archiving an already-archived job keeps the original timestamp
    // (mirrors Codex's `Some(true) if archived_at.is_none()` guard).
    archive(jobId: string, archivedAt: string): CronArchiveEntry {
      insertIfAbsent.run({ jobId, archivedAt });
      const row = selectOne.get({ jobId }) as unknown as CronArchiveRow | undefined;
      return { jobId, archivedAt: row?.archived_at ?? archivedAt };
    },
    restore(jobId: string): void {
      remove.run({ jobId });
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function registerCronArchiveRoutes(app: express.Express) {
  const store = createCronArchiveStore();

  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try { logger.info('[cron-archive] Closing database connection'); } catch { /* logger already closed */ }
    store.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.get('/api/cron-archive', (_req, res) => {
    try {
      res.json({ archived: store.list() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/cron-archive/:jobId', (req, res) => {
    try {
      const jobId = req.params.jobId;
      if (!isNonEmptyString(jobId)) {
        res.status(400).json({ error: 'Missing or empty job id' });
        return;
      }
      const archivedAt = isNonEmptyString(req.body?.archivedAt)
        ? req.body.archivedAt
        : new Date().toISOString();
      res.status(201).json({ entry: store.archive(jobId, archivedAt) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/cron-archive/:jobId', (req, res) => {
    try {
      const jobId = req.params.jobId;
      if (!isNonEmptyString(jobId)) {
        res.status(400).json({ error: 'Missing or empty job id' });
        return;
      }
      store.restore(jobId);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
