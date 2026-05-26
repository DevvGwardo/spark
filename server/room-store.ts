import { logger } from './lib/logger';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface Room {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMember {
  roomId: string;
  profileName: string;
  displayName: string;
  color: string;
  model: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  senderProfile: string;
  senderDisplayName: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  mentions: string[];
}

interface RoomRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface RoomMemberRow {
  room_id: string;
  profile_name: string;
  display_name: string;
  color: string;
  model: string;
}

interface RoomMessageRow {
  id: string;
  room_id: string;
  sender_profile: string;
  sender_display_name: string;
  role: string;
  content: string;
  timestamp: string;
  mentions: string;
}

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRoomMember(row: RoomMemberRow): RoomMember {
  return {
    roomId: row.room_id,
    profileName: row.profile_name,
    displayName: row.display_name,
    color: row.color,
    model: row.model,
  };
}

function toRoomMessage(row: RoomMessageRow): RoomMessage {
  const parsed = parseJson<string[]>(row.mentions, []);
  return {
    id: row.id,
    roomId: row.room_id,
    senderProfile: row.sender_profile,
    senderDisplayName: row.sender_display_name,
    role: row.role as RoomMessage['role'],
    content: row.content,
    timestamp: row.timestamp,
    mentions: Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [],
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function resolveDbPath(): string {
  if (process.env.CLOUDCHAT_DB_PATH) {
    const dir = dirname(process.env.CLOUDCHAT_DB_PATH);
    return join(dir, 'room-store.sqlite');
  }

  if (process.env.VITEST) {
    return ':memory:';
  }

  if (process.env.CLOUDCHAT_USER_DATA_DIR) {
    return join(process.env.CLOUDCHAT_USER_DATA_DIR, 'room-store.sqlite');
  }

  return join(homedir(), '.cloudchat', 'room-store.sqlite');
}

function ensureParentDirectory(dbPath: string) {
  if (dbPath === ':memory:') {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    profile_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#888',
    model TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (room_id, profile_name)
  );

  CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_profile TEXT NOT NULL,
    sender_display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    mentions TEXT NOT NULL DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_room_messages_room_id
    ON room_messages (room_id);

  CREATE INDEX IF NOT EXISTS idx_room_messages_room_timestamp
    ON room_messages (room_id, timestamp);
`;

const SQL = {
  insertRoom: `
    INSERT INTO rooms (id, name, created_at, updated_at)
    VALUES (:id, :name, :createdAt, :updatedAt)
  `,
  getRoom: `
    SELECT id, name, created_at, updated_at
    FROM rooms
    WHERE id = :id
  `,
  listRooms: `
    SELECT id, name, created_at, updated_at
    FROM rooms
    ORDER BY updated_at DESC
  `,
  updateRoom: `
    UPDATE rooms
    SET name = :name, updated_at = :updatedAt
    WHERE id = :id
  `,
  deleteRoom: `
    DELETE FROM rooms
    WHERE id = :id
  `,
  insertMember: `
    INSERT INTO room_members (room_id, profile_name, display_name, color, model)
    VALUES (:roomId, :profileName, :displayName, :color, :model)
  `,
  deleteMember: `
    DELETE FROM room_members
    WHERE room_id = :roomId AND profile_name = :profileName
  `,
  getMembers: `
    SELECT room_id, profile_name, display_name, color, model
    FROM room_members
    WHERE room_id = :roomId
    ORDER BY profile_name ASC
  `,
  insertMessage: `
    INSERT INTO room_messages (id, room_id, sender_profile, sender_display_name, role, content, timestamp, mentions)
    VALUES (:id, :roomId, :senderProfile, :senderDisplayName, :role, :content, :timestamp, :mentions)
  `,
  getMessages: `
    SELECT id, room_id, sender_profile, sender_display_name, role, content, timestamp, mentions
    FROM room_messages
    WHERE room_id = :roomId
    ORDER BY timestamp DESC
    LIMIT :limit
  `,
  getMessagesBefore: `
    SELECT id, room_id, sender_profile, sender_display_name, role, content, timestamp, mentions
    FROM room_messages
    WHERE room_id = :roomId AND timestamp < :before
    ORDER BY timestamp DESC
    LIMIT :limit
  `,
} as const;

type StmtCache = Record<keyof typeof SQL, ReturnType<DatabaseSync['prepare']>>;

function isStatementFinalized(error: unknown): boolean {
  return error instanceof Error && /finalized/i.test(error.message);
}

export function isConstraintError(error: unknown): error is Error {
  return error instanceof Error && /constraint/i.test(error.message);
}

export function createRoomStore(dbPath = resolveDbPath()) {
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
        logger.warn('[room-store] Prepared statement finalized — reconnecting to database');
        openDb();
        return fn();
      }
      throw error;
    }
  }

  openDb();

  return {
    createRoom(name: string): Room {
      const now = new Date().toISOString();
      const room: Room = {
        id: randomUUID(),
        name,
        createdAt: now,
        updatedAt: now,
      };
      run(() => stmt('insertRoom').run({
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      }));
      return room;
    },

    getRoom(id: string): Room | undefined {
      return run(() => {
        const row = stmt('getRoom').get({ id }) as unknown as RoomRow | undefined;
        return row ? toRoom(row) : undefined;
      });
    },

    listRooms(): Room[] {
      return run(() => (stmt('listRooms').all() as unknown as RoomRow[]).map(toRoom));
    },

    updateRoom(id: string, fields: Partial<Pick<Room, 'name'>>): boolean {
      return run(() => {
        const existing = stmt('getRoom').get({ id }) as unknown as RoomRow | undefined;
        if (!existing) {
          return false;
        }
        stmt('updateRoom').run({
          id,
          name: fields.name ?? existing.name,
          updatedAt: new Date().toISOString(),
        });
        return true;
      });
    },

    deleteRoom(id: string): void {
      run(() => stmt('deleteRoom').run({ id }));
    },

    addMember(roomId: string, member: Omit<RoomMember, 'roomId'>): void {
      run(() => stmt('insertMember').run({
        roomId,
        profileName: member.profileName,
        displayName: member.displayName,
        color: member.color || '#888',
        model: member.model || '',
      }));
    },

    removeMember(roomId: string, profileName: string): void {
      run(() => stmt('deleteMember').run({ roomId, profileName }));
    },

    getMembers(roomId: string): RoomMember[] {
      return run(() => (stmt('getMembers').all({ roomId }) as unknown as RoomMemberRow[]).map(toRoomMember));
    },

    postMessage(msg: Omit<RoomMessage, 'id' | 'timestamp'>): RoomMessage {
      const message: RoomMessage = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        ...msg,
        mentions: msg.mentions ?? [],
      };
      run(() => stmt('insertMessage').run({
        id: message.id,
        roomId: message.roomId,
        senderProfile: message.senderProfile,
        senderDisplayName: message.senderDisplayName,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        mentions: JSON.stringify(message.mentions),
      }));
      return message;
    },

    getMessages(roomId: string, limit = 50, before?: string): RoomMessage[] {
      return run(() => {
        const rows = before
          ? stmt('getMessagesBefore').all({ roomId, before, limit }) as unknown as RoomMessageRow[]
          : stmt('getMessages').all({ roomId, limit }) as unknown as RoomMessageRow[];
        return rows.map(toRoomMessage).reverse();
      });
    },

    close() {
      try {
        db.close();
      } catch (error) {
        logger.warn(`[room-store] Error closing database: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export type RoomStore = ReturnType<typeof createRoomStore>;
