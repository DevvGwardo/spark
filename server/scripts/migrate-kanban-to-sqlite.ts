#!/usr/bin/env tsx
/**
 * migrate-kanban-to-sqlite.ts
 *
 * One-shot script: import cards from the old `kanban.json` file into
 * Hermes Agent's shared SQLite kanban DB (`~/.hermes/kanban.db`).
 *
 * Run: npx tsx server/scripts/migrate-kanban-to-sqlite.ts
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ─── Resolve global hermes home ────────────────────────────────────────────
function resolveGlobalHermesHome(): string {
  const envHome = process.env.HERMES_HOME;
  if (!envHome) return path.join(os.homedir(), '.hermes');
  const parent = path.dirname(envHome);
  const grandparent = path.dirname(parent);
  if (path.basename(parent) === 'profiles' && path.basename(grandparent) === '.hermes') {
    return grandparent;
  }
  return envHome;
}

const JSON_PATH = path.join(resolveGlobalHermesHome(), 'kanban.json');
const DB_PATH = path.join(resolveGlobalHermesHome(), 'kanban.db');

// ─── Types ──────────────────────────────────────────────────────────────────

interface JsonCard {
  id: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  assignedWorker: string | null;
  reviewer: string | null;
  status: string;
  missionId: string | null;
  reportPath: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface JsonFile {
  cards: JsonCard[];
}

// ─── Body encoding (mirrors kanban.ts encodeBody) ───────────────────────────

const KANBAN_LANES = ['backlog', 'ready', 'running', 'review', 'blocked', 'done'];

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log(`[migrate] Source: ${JSON_PATH}`);
  console.log(`[migrate] Target: ${DB_PATH}`);

  // Check JSON exists
  if (!fs.existsSync(JSON_PATH)) {
    console.log('[migrate] No kanban.json found — nothing to migrate.');
    return;
  }

  // Read JSON
  const raw = fs.readFileSync(JSON_PATH, 'utf-8').trim();
  if (!raw) {
    console.log('[migrate] kanban.json is empty — nothing to migrate.');
    return;
  }

  let jsonFile: JsonFile;
  try {
    jsonFile = JSON.parse(raw) as JsonFile;
  } catch (e) {
    console.error('[migrate] Failed to parse kanban.json:', e);
    process.exit(1);
  }

  if (!Array.isArray(jsonFile.cards) || jsonFile.cards.length === 0) {
    console.log('[migrate] No cards in kanban.json — nothing to migrate.');
    return;
  }

  // Open SQLite
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Check what IDs already exist to avoid duplicates
  const existingIds = new Set(
    db
      .prepare('SELECT id FROM tasks')
      .all()
      .map((row: unknown) => String((row as Record<string, unknown>).id)),
  );

  // Count existing cards with matching IDs
  const alreadyMigrated = jsonFile.cards.filter((c) => existingIds.has(c.id));
  const toInsert = jsonFile.cards.filter((c) => !existingIds.has(c.id));

  if (alreadyMigrated.length > 0) {
    console.log(
      `[migrate] ${alreadyMigrated.length} card(s) already in SQLite (skipping).`,
    );
  }

  if (toInsert.length === 0) {
    console.log('[migrate] All cards already migrated. Nothing to do.');
    db.close();
    return;
  }

  // Normalize status
  function normalizeStatus(value: string): string {
    if (value === 'todo') return 'ready';
    if (value === 'in_progress' || value === 'doing') return 'running';
    return KANBAN_LANES.includes(value) ? value : 'backlog';
  }

  // Build body from JSON fields
  function encodeBody(card: JsonCard): string | null {
    const parts: string[] = [];
    if (card.spec?.trim()) {
      parts.push('## Spec', card.spec.trim());
    }
    if (
      Array.isArray(card.acceptanceCriteria) &&
      card.acceptanceCriteria.length > 0
    ) {
      parts.push('## Acceptance Criteria');
      for (const c of card.acceptanceCriteria) {
        if (c.trim()) parts.push(`- ${c.trim()}`);
      }
    }
    if (card.reviewer?.trim()) {
      parts.push(`**Reviewer:** @${card.reviewer.trim()}`);
    }
    if (card.missionId?.trim()) {
      parts.push(`**Mission:** ${card.missionId.trim()}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  const insert = db.prepare(`
    INSERT INTO tasks (id, title, body, assignee, status, created_by, created_at, updated_at, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((cards: JsonCard[]) => {
    for (const card of cards) {
      insert.run(
        card.id,
        card.title?.trim() || 'Untitled task',
        encodeBody(card),
        card.assignedWorker?.trim() || null,
        normalizeStatus(card.status),
        card.createdBy?.trim() || 'kanban',
        card.createdAt || Date.now(),
        card.updatedAt || card.createdAt || Date.now(),
        card.reportPath || null,
      );
    }
  });

  insertMany(toInsert);

  console.log(`[migrate] ✓ Migrated ${toInsert.length} card(s) to SQLite.`);
  console.log(`[migrate] Summary:`);
  for (const card of toInsert) {
    console.log(
      `  - ${card.status.padEnd(8)} ${card.title.slice(0, 60)}${
        card.title.length > 60 ? '...' : ''
      }`,
    );
  }

  db.close();
  console.log('[migrate] Done.');
}

main();
