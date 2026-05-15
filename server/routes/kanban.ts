import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendJson } from '../lib/helpers';

// ─── Constants ─────────────────────────────────────────────────────────────

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

interface KanbanFile {
  cards: KanbanCard[];
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

// ─── Store path ─────────────────────────────────────────────────────────────

const HERMES_HOME = process.env.HERMES_HOME
  ?? path.join(os.homedir(), '.hermes');

const CLOUDCHAT_HOME = path.join(os.homedir(), '.cloudchat');

function getKanbanFilePath(): string {
  const primary = path.join(HERMES_HOME, 'kanban.json');
  if (fs.existsSync(path.dirname(primary))) return primary;
  // Fallback: create cloudchat dir if needed
  fs.mkdirSync(CLOUDCHAT_HOME, { recursive: true });
  return path.join(CLOUDCHAT_HOME, 'kanban.json');
}

// ─── File store helpers ─────────────────────────────────────────────────────

function ensureKanbanFile(): string {
  const filePath = getKanbanFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({ cards: [] }, null, 2) + '\n', 'utf-8');
  }
  return filePath;
}

function readKanbanFile(): KanbanFile {
  const filePath = ensureKanbanFile();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return { cards: [] };
    const parsed = JSON.parse(raw) as Partial<KanbanFile>;
    return { cards: Array.isArray(parsed.cards) ? parsed.cards.map(normalizeCard) : [] };
  } catch {
    return { cards: [] };
  }
}

function writeKanbanFile(data: KanbanFile): void {
  const filePath = ensureKanbanFile();
  fs.writeFileSync(
    filePath,
    JSON.stringify({ cards: data.cards.map(normalizeCard) }, null, 2) + '\n',
    'utf-8',
  );
}

// ─── Normalization helpers ──────────────────────────────────────────────────

function normalizeStatus(value: unknown): KanbanLane {
  if (value === 'todo') return 'ready';
  if (value === 'in_progress' || value === 'doing') return 'running';
  return KANBAN_LANES.includes(value as KanbanLane)
    ? (value as KanbanLane)
    : 'backlog';
}

function normalizeCriteria(value: unknown): string[] {
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

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCard(
  card: Partial<Omit<KanbanCard, 'status'>> & {
    id?: string;
    title?: string;
    status?: KanbanLane | string | null;
  },
): KanbanCard {
  const now = Date.now();
  return {
    id: typeof card.id === 'string' && card.id ? card.id : randomUUID(),
    title:
      typeof card.title === 'string' && card.title.trim()
        ? card.title.trim()
        : 'Untitled task',
    spec: typeof card.spec === 'string' ? card.spec : '',
    acceptanceCriteria: normalizeCriteria(card.acceptanceCriteria),
    assignedWorker: optionalString(card.assignedWorker),
    reviewer: optionalString(card.reviewer),
    status: normalizeStatus(card.status),
    missionId: optionalString(card.missionId),
    reportPath: optionalString(card.reportPath),
    createdBy:
      typeof card.createdBy === 'string' && card.createdBy
        ? card.createdBy
        : 'kanban',
    createdAt: typeof card.createdAt === 'number' ? card.createdAt : now,
    updatedAt: typeof card.updatedAt === 'number' ? card.updatedAt : now,
  };
}

// ─── CRUD operations ────────────────────────────────────────────────────────

function listKanbanCards(filters: ListFilters = {}): KanbanCard[] {
  let cards = readKanbanFile().cards;
  if (filters.status) {
    cards = cards.filter((card) => card.status === normalizeStatus(filters.status));
  }
  if (filters.worker) {
    cards = cards.filter(
      (card) => card.assignedWorker === filters.worker,
    );
  }
  return [...cards].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title),
  );
}

function createKanbanCard(input: CreateKanbanCardInput): KanbanCard {
  const file = readKanbanFile();
  const now = Date.now();
  const card = normalizeCard({
    id: randomUUID(),
    title: input.title,
    spec: input.spec,
    acceptanceCriteria: input.acceptanceCriteria,
    assignedWorker: input.assignedWorker,
    reviewer: input.reviewer,
    status: input.status ?? 'backlog',
    createdBy: input.createdBy ?? 'kanban',
    createdAt: now,
    updatedAt: now,
  });
  file.cards.push(card);
  writeKanbanFile(file);
  return card;
}

function updateKanbanCard(
  cardId: string,
  updates: UpdateKanbanCardInput,
): KanbanCard | null {
  const file = readKanbanFile();
  const index = file.cards.findIndex((card) => card.id === cardId);
  if (index === -1) return null;

  const current = normalizeCard(file.cards[index]);
  const next = normalizeCard({
    ...current,
    ...updates,
    id: current.id,
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    title: typeof updates.title === 'string' ? updates.title : current.title,
    updatedAt: Date.now(),
  });
  file.cards[index] = next;
  writeKanbanFile(file);
  return next;
}

function deleteKanbanCard(cardId: string): boolean {
  const file = readKanbanFile();
  const index = file.cards.findIndex((card) => card.id === cardId);
  if (index === -1) return false;
  file.cards.splice(index, 1);
  writeKanbanFile(file);
  return true;
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerKanbanRoutes(app: Express) {
  // GET /api/hermes/kanban — list cards with optional ?status= and ?worker= filters
  app.get('/api/hermes/kanban', (req: Request, res: Response) => {
    try {
      const status = (req.query.status as string | undefined) || null;
      const worker = (req.query.worker as string | undefined) || null;
      const cards = listKanbanCards({ status, worker });
      sendJson(res, 200, { cards, total: cards.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list kanban cards';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/kanban — create card
  app.post('/api/hermes/kanban', (req: Request, res: Response) => {
    try {
      const { title, spec, acceptanceCriteria, assignedWorker, reviewer, status, createdBy } = req.body;

      if (!title || typeof title !== 'string' || !title.trim()) {
        return sendJson(res, 400, { error: 'title is required and must be a non-empty string' });
      }

      if (status && !KANBAN_LANES.includes(status as KanbanLane)) {
        return sendJson(res, 400, {
          error: `Invalid status. Must be one of: ${KANBAN_LANES.join(', ')}`,
        });
      }

      const card = createKanbanCard({
        title: title.trim(),
        spec: typeof spec === 'string' ? spec : undefined,
        acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : undefined,
        assignedWorker: typeof assignedWorker === 'string' ? assignedWorker : null,
        reviewer: typeof reviewer === 'string' ? reviewer : null,
        status: typeof status === 'string' ? status : null,
        createdBy: typeof createdBy === 'string' ? createdBy : null,
      });

      sendJson(res, 201, { card });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create kanban card';
      sendJson(res, 500, { error: message });
    }
  });

  // PATCH /api/hermes/kanban/:id — update card fields
  app.patch('/api/hermes/kanban/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { title, spec, acceptanceCriteria, assignedWorker, reviewer, status, reportPath } = req.body;

      if (!id) {
        return sendJson(res, 400, { error: 'Card ID is required' });
      }

      if (status !== undefined && status !== null && !KANBAN_LANES.includes(status as KanbanLane)) {
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
      if (acceptanceCriteria !== undefined) updates.acceptanceCriteria = acceptanceCriteria;
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
      const message = error instanceof Error ? error.message : 'Failed to update kanban card';
      sendJson(res, 500, { error: message });
    }
  });

  // DELETE /api/hermes/kanban/:id — delete card
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
      const message = error instanceof Error ? error.message : 'Failed to delete kanban card';
      sendJson(res, 500, { error: message });
    }
  });
}
