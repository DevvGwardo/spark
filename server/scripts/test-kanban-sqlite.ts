#!/usr/bin/env tsx
/**
 * Test: kanban routes against Hermes SQLite DB.
 * Exercises the same operations the Express API would do.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ─── Paths ──────────────────────────────────────────────────────────────────

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

const DB_PATH = path.join(resolveGlobalHermesHome(), 'kanban.db');
const KANBAN_LANES = ['backlog', 'ready', 'running', 'review', 'blocked', 'done'];

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function _normalizeStatus(value: string) {
  if (value === 'todo') return 'ready';
  if (value === 'in_progress' || value === 'doing') return 'running';
  return KANBAN_LANES.includes(value) ? value : 'backlog';
}

console.log(`\n📋 Kanban SQLite Integration Test`);
console.log(`   DB: ${DB_PATH}`);
console.log(`   resolveGlobalHermesHome: ${resolveGlobalHermesHome()}\n`);

// ─── 1. Verify DB exists and has tasks table ────────────────────────────────
console.log('1. DB schema check');
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all() as { name: string }[];
const hasTasksTable = tables.some((t) => t.name === 'tasks');
assert(hasTasksTable, 'tasks table exists');
if (!hasTasksTable) {
  console.log('   ❌ Cannot continue without tasks table');
  process.exit(1);
}

// ─── 2. List existing cards ─────────────────────────────────────────────────
console.log('\n2. List cards (no filter)');
const allCards = db
  .prepare('SELECT * FROM tasks ORDER BY COALESCE(updated_at, created_at) DESC')
  .all() as Record<string, unknown>[];
console.log(`   Total: ${allCards.length} cards`);
assert(allCards.length >= 4, `at least 4 cards in DB (got ${allCards.length})`);

// Verify card fields exist
const firstCard = allCards[0];
assert('id' in firstCard, 'card has id');
assert('title' in firstCard, 'card has title');
assert('status' in firstCard, 'card has status');
assert('created_at' in firstCard, 'card has created_at');

// ─── 3. Filter by status ────────────────────────────────────────────────────
console.log('3. Filter cards by status');
const doneCards = db
  .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC')
  .all('done') as Record<string, unknown>[];
console.log(`   done cards: ${doneCards.length}`);
assert(doneCards.length >= 4, 'at least 4 done cards');

const readyCards = db
  .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC')
  .all('ready') as Record<string, unknown>[];
console.log(`   ready cards: ${readyCards.length}`);
assert(readyCards.length >= 1, 'at least 1 ready card');

// ─── 4. Create a new card ───────────────────────────────────────────────────
console.log('\n4. Create card');
const now = Date.now();
const newId = 'test-' + randomUUID().slice(0, 8);
const bodyParts = ['## Spec', 'Test spec content', '', '## Acceptance Criteria', '- item 1', '- item 2'];
const body = bodyParts.join('\n');

db.prepare(
  `INSERT INTO tasks (id, title, body, assignee, status, created_by, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(newId, 'Test Card', body, 'nub', 'backlog', 'test', now, now);

const created = db
  .prepare('SELECT * FROM tasks WHERE id = ?')
  .get(newId) as Record<string, unknown>;
assert(!!created, 'card was created');
if (created) {
  assert(String(created.title) === 'Test Card', 'title matches');
  assert(String(created.assignee) === 'nub', 'assignee matches');
  assert(String(created.status) === 'backlog', 'status is backlog');
  assert(String(created.created_by) === 'test', 'created_by matches');
}

// ─── 5. Update a card ──────────────────────────────────────────────────────
console.log('\n5. Update card');
db.prepare(
  `UPDATE tasks SET status = ?, assignee = ?, updated_at = ? WHERE id = ?`,
).run('ready', 'test-user', Date.now(), newId);

const updated = db
  .prepare('SELECT * FROM tasks WHERE id = ?')
  .get(newId) as Record<string, unknown>;
assert(!!updated, 'card still exists after update');
if (updated) {
  assert(String(updated.status) === 'ready', 'status changed to ready');
  assert(String(updated.assignee) === 'test-user', 'assignee changed to test-user');
}

// ─── 6. Update body field ──────────────────────────────────────────────────
console.log('\n6. Update body (spec, acceptanceCriteria)');
const newBody = '## Spec\nUpdated spec\n\n## Acceptance Criteria\n- updated item 1';
db.prepare(`UPDATE tasks SET body = ?, updated_at = ? WHERE id = ?`).run(
  newBody,
  Date.now(),
  newId,
);
const bodyUpdated = db
  .prepare('SELECT body FROM tasks WHERE id = ?')
  .get(newId) as { body: string };
assert(bodyUpdated.body.includes('## Spec'), 'body has ## Spec section');
assert(bodyUpdated.body.includes('Updated spec'), 'body has updated content');

// ─── 7. Delete a card ──────────────────────────────────────────────────────
console.log('\n7. Delete card');
const deleteResult = db.prepare('DELETE FROM tasks WHERE id = ?').run(newId);
assert(deleteResult.changes === 1, 'card was deleted');

const deleted = db.prepare('SELECT * FROM tasks WHERE id = ?').get(newId);
assert(!deleted, 'card no longer exists');

// ─── 8. Verify JSON cards were migrated with correct statuses ──────────────
console.log('\n8. Verify JSON migration preserved data');
const jsonCards = db
  .prepare(
    "SELECT * FROM tasks WHERE id IN ('0fd7d2b3-45ed-4a36-87c6-be031ca81d0b', '3f9aad58-6aa0-4878-b3fb-e497f4120533')",
  )
  .all() as Record<string, unknown>[];

assert(jsonCards.length === 2, 'both JSON cards exist');
const jsonDone = jsonCards.find((c) => c.id === '0fd7d2b3-45ed-4a36-87c6-be031ca81d0b');
const jsonBlocked = jsonCards.find((c) => c.id === '3f9aad58-6aa0-4878-b3fb-e497f4120533');

if (jsonDone) assert(String(jsonDone.status) === 'done', 'analyze card is done');
if (jsonBlocked) assert(String(jsonBlocked.status) === 'ready', 'grok-cli card is ready (was blocked → normalized)');

// ─── 9. Verify hermets tools can see the same data ─────────────────────────
console.log('\n9. Cross-system visibility');
const cardFromSqlite = db
  .prepare('SELECT * FROM tasks WHERE id = ?')
  .get('t_d12e0ce4') as Record<string, unknown> | undefined;
assert(!!cardFromSqlite, 't_d12e0ce4 visible in SQLite');
if (cardFromSqlite) {
  assert(String(cardFromSqlite.title).includes('kanban-to-sqlite'), 'title matches');
  assert(String(cardFromSqlite.status) === 'done', 'status is done (kanban task lifecycle advanced)');
  assert(String(cardFromSqlite.assignee) === 'nub', 'assignee is nub');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

db.close();

// Exit with error code if any test failed
if (failed > 0) process.exit(1);
