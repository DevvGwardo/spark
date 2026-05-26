import { logger } from './lib/logger';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TeamContextEntry {
  id: string;
  teamId: string;
  type: 'finding' | 'decision' | 'artifact' | 'question' | 'handoff';
  content: string;
  author: string;
  importance: number;
  tags: string[];
  timestamp: number;
}

interface TeamContextRow {
  id: string;
  team_id: string;
  type: string;
  content: string;
  author: string;
  importance: number;
  tags: string;
  timestamp: number;
}

function toEntry(row: TeamContextRow): TeamContextEntry {
  const parsed = parseJson<string[]>(row.tags, []);
  return {
    id: row.id,
    teamId: row.team_id,
    type: row.type as TeamContextEntry['type'],
    content: row.content,
    author: row.author,
    importance: row.importance,
    tags: Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [],
    timestamp: row.timestamp,
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ─── DB Path ────────────────────────────────────────────────────────────────

function resolveDbPath(): string {
  if (process.env.CLOUDCHAT_DB_PATH) {
    const dir = dirname(process.env.CLOUDCHAT_DB_PATH);
    return join(dir, 'team-context-store.sqlite');
  }

  if (process.env.VITEST) {
    return ':memory:';
  }

  if (process.env.CLOUDCHAT_USER_DATA_DIR) {
    return join(process.env.CLOUDCHAT_USER_DATA_DIR, 'team-context-store.sqlite');
  }

  return join(homedir(), '.cloudchat', 'team-context-store.sqlite');
}

function ensureParentDirectory(dbPath: string) {
  if (dbPath === ':memory:') return;
  mkdirSync(dirname(dbPath), { recursive: true });
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS team_context_entries (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('finding', 'decision', 'artifact', 'question', 'handoff')),
    content TEXT NOT NULL,
    author TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 2 CHECK(importance >= 1 AND importance <= 3),
    tags TEXT NOT NULL DEFAULT '[]',
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_team_context_team_id
    ON team_context_entries (team_id);

  CREATE INDEX IF NOT EXISTS idx_team_context_type
    ON team_context_entries (team_id, type);
`;

const SQL = {
  insertEntry: `
    INSERT INTO team_context_entries (id, team_id, type, content, author, importance, tags, timestamp)
    VALUES (:id, :teamId, :type, :content, :author, :importance, :tags, :timestamp)
  `,
  queryEntries: `
    SELECT id, team_id, type, content, author, importance, tags, timestamp
    FROM team_context_entries
    WHERE team_id = :teamId
    ORDER BY timestamp DESC
  `,
  queryEntriesFiltered: `
    SELECT id, team_id, type, content, author, importance, tags, timestamp
    FROM team_context_entries
    WHERE team_id = :teamId
      AND (:type IS NULL OR type = :type)
      AND (:author IS NULL OR author = :author)
    ORDER BY timestamp DESC
  `,
  queryEntriesRecent: `
    SELECT id, team_id, type, content, author, importance, tags, timestamp
    FROM team_context_entries
    WHERE team_id = :teamId
    ORDER BY timestamp DESC
    LIMIT 20
  `,
  updateEntryType: `
    UPDATE team_context_entries
    SET type = :type
    WHERE id = :id AND team_id = :teamId AND type = 'question'
  `,
} as const;

type StmtCache = Record<keyof typeof SQL, ReturnType<DatabaseSync['prepare']>>;

function isStatementFinalized(error: unknown): boolean {
  return error instanceof Error && /finalized/i.test(error.message);
}

// ─── Store Factory ─────────────────────────────────────────────────────────

export function createTeamContextStore(dbPath = resolveDbPath()) {
  ensureParentDirectory(dbPath);

  let db: DatabaseSync;
  let stmts: StmtCache;

  function openDb() {
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    stmts = Object.fromEntries(
      Object.entries(SQL).map(([key, sql]) => [key, db.prepare(sql)]),
    ) as StmtCache;
  }

  function stmt<K extends keyof typeof SQL>(key: K): StmtCache[K] {
    return stmts[key];
  }

  function run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (isStatementFinalized(error)) {
        logger.warn('[team-context-store] Prepared statement finalized — reconnecting to database');
        openDb();
        return fn();
      }
      throw error;
    }
  }

  openDb();

  return {
    /**
     * Publish a new entry to the team context.
     */
    publish(teamId: string, entry: Omit<TeamContextEntry, 'id' | 'timestamp' | 'teamId'>): TeamContextEntry {
      const now = Date.now();
      const record: TeamContextEntry = {
        ...entry,
        id: randomUUID(),
        teamId,
        timestamp: now,
      };
      run(() => stmt('insertEntry').run({
        id: record.id,
        teamId: record.teamId,
        type: record.type,
        content: record.content,
        author: record.author,
        importance: record.importance,
        tags: JSON.stringify(record.tags),
        timestamp: record.timestamp,
      }));
      return record;
    },

    /**
     * Query entries by teamId with optional type/tag/author filters.
     * type and author are pushed to SQL WHERE; tag filtered in JS.
     */
    query(
      teamId: string,
      filters?: { type?: string; tag?: string; author?: string },
    ): TeamContextEntry[] {
      return run(() => {
        const useFiltered = filters?.type || filters?.author;
        if (useFiltered) {
          const rows = stmt('queryEntriesFiltered').all({
            teamId,
            type: filters?.type ?? null,
            author: filters?.author ?? null,
          }) as unknown as TeamContextRow[];
          let entries = rows.map(toEntry);
          if (filters?.tag) {
            entries = entries.filter((e) => e.tags.includes(filters.tag!));
          }
          return entries;
        }

        const rows = stmt('queryEntries').all({ teamId }) as unknown as TeamContextRow[];
        let entries = rows.map(toEntry);
        if (filters?.tag) {
          entries = entries.filter((e) => e.tags.includes(filters.tag!));
        }
        return entries;
      });
    },

    /**
     * Resolve a question by updating its type from 'question' to 'finding'.
     */
    resolve(teamId: string, entryId: string): boolean {
      return run(() => {
        const result = stmt('updateEntryType').run({
          id: entryId,
          teamId,
          type: 'finding',
        });
        return (result as { changes: number }).changes > 0;
      });
    },

    /**
     * Summarize the most recent entries as a text digest.
     */
    summarize(teamId: string): string {
      const entries = run(() => {
        return (stmt('queryEntriesRecent').all({ teamId }) as unknown as TeamContextRow[])
          .map(toEntry);
      });

      if (entries.length === 0) return 'No shared context entries yet.';

      const lines = entries.map((e) => {
        const tagStr = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
        const stars = '★'.repeat(e.importance);
        return `[${e.type}] ${stars}${tagStr} @${e.author}: ${e.content.slice(0, 200)}`;
      });

      return `Recent team context (${entries.length} entries):\n${lines.join('\n')}`;
    },

    close() {
      try {
        db.close();
      } catch (error) {
        logger.warn(`[team-context-store] Error closing database: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export type TeamContextStore = ReturnType<typeof createTeamContextStore>;
