import type { Express, Request, Response } from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sendJson } from '../lib/helpers';

// ─── Hermes SQLite kanban DB ────────────────────────────────────────────────
//
// The kanban DB is a shared resource — all profiles read/write the same SQLite
// database at ~/.hermes/kanban.db.  If HERMES_HOME points to a profile
// subdirectory (profiles/<name>) we resolve upward to the global home.

function resolveGlobalHermesHome(): string {
  const envHome = process.env.HERMES_HOME;
  if (!envHome) return path.join(os.homedir(), '.hermes');

  // If HERMES_HOME looks like a profile subdirectory
  // (<something>/.hermes/profiles/<name>), resolve upward to the global
  // ~/.hermes so the kanban DB is shared across all profiles.
  const parent = path.dirname(envHome);
  const grandparent = path.dirname(parent);
  if (path.basename(parent) === 'profiles' && path.basename(grandparent) === '.hermes') {
    return grandparent;
  }

  return envHome;
}

const DB_PATH = path.join(resolveGlobalHermesHome(), 'kanban.db');

const KANBAN_LANES = ['backlog', 'ready', 'running', 'review', 'blocked', 'done'] as const;
type KanbanLane = (typeof KANBAN_LANES)[number];

interface KanbanCard {
  id: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  assignedWorker: string | null;
  reviewer: string | null;
  status: KanbanLane;
  missionId: string | null;
  reportPath: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface ListFilters {
  status?: string | null;
  worker?: string | null;
}

interface CreateKanbanCardInput {
  title: string;
  spec?: string;
  acceptanceCriteria?: string[];
  assignedWorker?: string | null;
  reviewer?: string | null;
  status?: string | null;
  createdBy?: string | null;
  reportPath?: string | null;
}

type UpdateKanbanCardInput = Partial<Omit<CreateKanbanCardInput, 'createdBy'>>;

// ─── SQLite connection (singleton) ──────────────────────────────────────────

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    // Ensure parent dir exists
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

// ─── Body encoding/decoding ─────────────────────────────────────────────────
//
// CloudChat stores structured fields (spec, acceptanceCriteria, reviewer,
// missionId) that Hermes tasks don't have as dedicated columns. We pack them
// into the `body` text column with clear delimiters, then unpack on read.

function encodeBody(
  spec: string | undefined,
  acceptanceCriteria: string[] | undefined,
  reviewer: string | null | undefined,
  missionId: string | null | undefined,
): string {
  const parts: string[] = [];
  if (spec?.trim()) {
    parts.push('## Spec', spec.trim());
  }
  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    parts.push('## Acceptance Criteria');
    for (const c of acceptanceCriteria) {
      if (c.trim()) parts.push(`- ${c.trim()}`);
    }
  }
  if (reviewer?.trim()) {
    parts.push(`**Reviewer:** @${reviewer.trim()}`);
  }
  if (missionId?.trim()) {
    parts.push(`**Mission:** ${missionId.trim()}`);
  }
  return parts.join('\n\n');
}

function decodeBody(body: string | null): {
  spec: string;
  acceptanceCriteria: string[];
  reviewer: string | null;
  missionId: string | null;
} {
  const spec = '';
  const acceptanceCriteria: string[] = [];
  let reviewer: string | null = null;
  let missionId: string | null = null;

  if (!body) return { spec, acceptanceCriteria, reviewer, missionId };

  // Parse reviewer/mission metadata from body
  const reviewerMatch = body.match(/\*\*Reviewer:\*\*\s*@?(\S+)/);
  if (reviewerMatch) reviewer = reviewerMatch[1];
  const missionMatch = body.match(/\*\*Mission:\*\*\s*(\S+)/);
  if (missionMatch) missionId = missionMatch[1];

  // Parse ## Spec section
  const specMatch = body.match(/## Spec\n([\s\S]*?)(?=\n## |\*\*|$)/);
  const parsedSpec = specMatch ? specMatch[1].trim() : '';

  // Parse ## Acceptance Criteria list
  const criteriaMatch = body.match(/## Acceptance Criteria\n([\s\S]*?)(?=\n## |\*\*|$)/);
  const parsedCriteria: string[] = [];
  if (criteriaMatch) {
    for (const line of criteriaMatch[1].split('\n')) {
      const trimmed = line.replace(/^-\s*/, '').trim();
      if (trimmed) parsedCriteria.push(trimmed);
    }
  }

  return {
    spec: parsedSpec,
    acceptanceCriteria: parsedCriteria,
    reviewer,
    missionId,
  };
}

// ─── Status normalization ───────────────────────────────────────────────────

function normalizeStatus(value: unknown): KanbanLane {
  if (value === 'todo') return 'ready';
  if (value === 'in_progress' || value === 'doing') return 'running';
  return KANBAN_LANES.includes(value as KanbanLane)
    ? (value as KanbanLane)
    : 'backlog';
}

function _normalizeCriteria(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

// ─── CRUD operations ────────────────────────────────────────────────────────

function rowToCard(row: Record<string, unknown>): KanbanCard {
  const bodyFields = decodeBody(row.body as string | null);
  return {
    id: String(row.id),
    title: String(row.title),
    spec: bodyFields.spec,
    acceptanceCriteria: bodyFields.acceptanceCriteria,
    assignedWorker: (row.assignee as string) || null,
    reviewer: bodyFields.reviewer,
    status: normalizeStatus(row.status),
    missionId: bodyFields.missionId,
    reportPath: (row.result as string) || null,
    createdBy: String(row.created_by || 'kanban'),
    createdAt: Number(row.created_at ?? Date.now()),
    updatedAt: Number(row.updated_at ?? row.created_at ?? Date.now()),
  };
}

function listKanbanCards(filters: ListFilters = {}): KanbanCard[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(normalizeStatus(filters.status));
  }
  if (filters.worker) {
    conditions.push('assignee = ?');
    params.push(filters.worker);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY COALESCE(updated_at, created_at) DESC`)
    .all(...params) as Record<string, unknown>[];

  return rows.map(rowToCard);
}

function createKanbanCard(input: CreateKanbanCardInput): KanbanCard {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const status = normalizeStatus(input.status ?? 'backlog');
  const body = encodeBody(input.spec, input.acceptanceCriteria, input.reviewer, null);

  db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title?.trim() || 'Untitled task',
    body || null,
    input.assignedWorker?.trim() || null,
    status,
    input.createdBy?.trim() || 'kanban',
    now,
    now,
  );

  return rowToCard({
    id,
    title: input.title?.trim() || 'Untitled task',
    body,
    assignee: input.assignedWorker?.trim() || null,
    status,
    created_by: input.createdBy?.trim() || 'kanban',
    created_at: now,
    updated_at: now,
    result: input.reportPath || null,
  });
}

function updateKanbanCard(
  cardId: string,
  updates: UpdateKanbanCardInput,
): KanbanCard | null {
  const db = getDb();

  // Fetch existing card
  const existing = db
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(cardId) as Record<string, unknown> | undefined;
  if (!existing) return null;

  const now = Date.now();
  const setClauses: string[] = ['updated_at = ?'];
  const setParams: unknown[] = [now];

  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    setParams.push(updates.title.trim());
  }

  if (updates.assignedWorker !== undefined) {
    setClauses.push('assignee = ?');
    setParams.push(updates.assignedWorker?.trim() || null);
  }

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    setParams.push(normalizeStatus(updates.status));
  }

  if (updates.reportPath !== undefined) {
    setClauses.push('result = ?');
    setParams.push(updates.reportPath);
  }

  // For spec/acceptanceCriteria/reviewer changes, rebuild the body
  if (updates.spec !== undefined || updates.acceptanceCriteria !== undefined || updates.reviewer !== undefined) {
    const decoded = decodeBody(existing.body as string | null);
    const newBody = encodeBody(
      updates.spec ?? decoded.spec,
      updates.acceptanceCriteria ?? decoded.acceptanceCriteria,
      updates.reviewer ?? decoded.reviewer,
      decoded.missionId,
    );
    setClauses.push('body = ?');
    setParams.push(newBody);
  }

  setParams.push(cardId);

  db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...setParams);

  // Return updated row
  const updated = db
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(cardId) as Record<string, unknown>;

  return rowToCard(updated);
}

function deleteKanbanCard(cardId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(cardId);
  return result.changes > 0;
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerKanbanRoutes(app: Express) {
  /**
   * GET /api/hermes/kanban — list cards
   * Query params: ?status=ready&worker=nub
   */
  app.get('/api/hermes/kanban', (req: Request, res: Response) => {
    try {
      const status = (req.query.status as string | undefined) || null;
      const worker = (req.query.worker as string | undefined) || null;
      const cards = listKanbanCards({ status, worker });
      sendJson(res, 200, { cards, total: cards.length });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to list kanban cards';
      sendJson(res, 500, { error: message });
    }
  });

  /**
   * POST /api/hermes/kanban — create a card
   * Body: { title, spec?, acceptanceCriteria?, assignedWorker?, reviewer?, status?, createdBy? }
   */
  app.post('/api/hermes/kanban', (req: Request, res: Response) => {
    try {
      const {
        title,
        spec,
        acceptanceCriteria,
        assignedWorker,
        reviewer,
        status,
        createdBy,
      } = req.body;

      if (!title || typeof title !== 'string' || !title.trim()) {
        return sendJson(res, 400, {
          error: 'title is required and must be a non-empty string',
        });
      }

      if (status && !KANBAN_LANES.includes(status as KanbanLane)) {
        return sendJson(res, 400, {
          error: `Invalid status. Must be one of: ${KANBAN_LANES.join(', ')}`,
        });
      }

      const card = createKanbanCard({
        title: title.trim(),
        spec: typeof spec === 'string' ? spec : undefined,
        acceptanceCriteria: Array.isArray(acceptanceCriteria)
          ? acceptanceCriteria
          : undefined,
        assignedWorker: typeof assignedWorker === 'string' ? assignedWorker : null,
        reviewer: typeof reviewer === 'string' ? reviewer : null,
        status: typeof status === 'string' ? status : null,
        createdBy: typeof createdBy === 'string' ? createdBy : null,
      });

      sendJson(res, 201, { card });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create kanban card';
      sendJson(res, 500, { error: message });
    }
  });

  /**
   * PATCH /api/hermes/kanban/:id — update card fields
   * Body: { title?, spec?, acceptanceCriteria?, assignedWorker?, reviewer?, status?, reportPath? }
   */
  app.patch('/api/hermes/kanban/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const {
        title,
        spec,
        acceptanceCriteria,
        assignedWorker,
        reviewer,
        status,
        reportPath,
      } = req.body;

      if (!id) {
        return sendJson(res, 400, { error: 'Card ID is required' });
      }

      if (
        status !== undefined &&
        status !== null &&
        !KANBAN_LANES.includes(status as KanbanLane)
      ) {
        return sendJson(res, 400, {
          error: `Invalid status. Must be one of: ${KANBAN_LANES.join(', ')}`,
        });
      }

      const updates: UpdateKanbanCardInput = {};
      if (title !== undefined) {
        if (typeof title !== 'string' || !title.trim()) {
          return sendJson(res, 400, { error: 'title must be a non-empty string' });
        }
        updates.title = title.trim();
      }
      if (spec !== undefined) updates.spec = String(spec);
      if (acceptanceCriteria !== undefined) {
        updates.acceptanceCriteria = acceptanceCriteria;
      }
      if (assignedWorker !== undefined) updates.assignedWorker = assignedWorker;
      if (reviewer !== undefined) updates.reviewer = reviewer;
      if (status !== undefined) updates.status = status;
      if (reportPath !== undefined) updates.reportPath = String(reportPath);

      const updated = updateKanbanCard(id, updates);
      if (!updated) {
        return sendJson(res, 404, { error: 'Card not found' });
      }

      sendJson(res, 200, { card: updated });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to update kanban card';
      sendJson(res, 500, { error: message });
    }
  });

  /**
   * DELETE /api/hermes/kanban/:id — delete a card
   */
  app.delete('/api/hermes/kanban/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        return sendJson(res, 400, { error: 'Card ID is required' });
      }

      const deleted = deleteKanbanCard(id);
      if (!deleted) {
        return sendJson(res, 404, { error: 'Card not found' });
      }

      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to delete kanban card';
      sendJson(res, 500, { error: message });
    }
  });

  /**
   * POST /api/hermes/kanban/link — create a parent→child dependency link
   * Body: { parent_id, child_id }
   */
  app.post('/api/hermes/kanban/link', (req: Request, res: Response) => {
    try {
      const { parent_id, child_id } = req.body;

      if (!parent_id || !child_id) {
        return sendJson(res, 400, { error: 'parent_id and child_id are required' });
      }
      if (parent_id === child_id) {
        return sendJson(res, 400, { error: 'Cannot link a card to itself' });
      }

      const db = getDb();

      // Ensure the links table exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS kanban_links (
          parent_id TEXT NOT NULL,
          child_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (parent_id, child_id),
          FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (child_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_kanban_links_parent ON kanban_links(parent_id);
        CREATE INDEX IF NOT EXISTS idx_kanban_links_child ON kanban_links(child_id);
      `);

      // Verify both cards exist
      const parent = db.prepare('SELECT id FROM tasks WHERE id = ?').get(parent_id);
      const child = db.prepare('SELECT id FROM tasks WHERE id = ?').get(child_id);
      if (!parent) return sendJson(res, 404, { error: 'Parent card not found' });
      if (!child) return sendJson(res, 404, { error: 'Child card not found' });

      // Insert link (ignore if already exists)
      db.prepare(
        'INSERT OR IGNORE INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)',
      ).run(parent_id, child_id, Date.now());

      // If parent isn't done, demote child from ready to backlog
      const parentStatus = db.prepare('SELECT status FROM tasks WHERE id = ?').get(parent_id) as { status: string } | undefined;
      if (parentStatus && parentStatus.status !== 'done') {
        const childStatus = db.prepare('SELECT status FROM tasks WHERE id = ?').get(child_id) as { status: string } | undefined;
        if (childStatus && childStatus.status === 'ready') {
          db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('backlog', Date.now(), child_id);
        }
      }

      sendJson(res, 201, { ok: true, parent_id, child_id });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to link cards';
      sendJson(res, 500, { error: message });
    }
  });

  /**
   * POST /api/hermes/kanban/:id/unblock — move a blocked task back to ready
   * and reset failure counters so the dispatcher will re-pick it.
   */
  app.post('/api/hermes/kanban/:id/unblock', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        return sendJson(res, 400, { error: 'Card ID is required' });
      }

      const db = getDb();
      const card = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(id) as { id: string; status: string } | undefined;

      if (!card) {
        return sendJson(res, 404, { error: 'Card not found' });
      }

      // Only unblock cards that are in blocked status
      if (card.status !== 'blocked') {
        return sendJson(res, 409, { error: `Card is not blocked (current status: ${card.status})` });
      }

      // Move to ready and clear the result/report
      db.prepare('UPDATE tasks SET status = ?, result = NULL, updated_at = ? WHERE id = ?')
        .run('ready', Date.now(), id);

      sendJson(res, 200, { ok: true, id, status: 'ready' });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to unblock card';
      sendJson(res, 500, { error: message });
    }
  });
}
