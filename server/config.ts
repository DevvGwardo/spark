// ─── Centralized server configuration ────────────────────────────────────────
// Consolidates hardcoded constants scattered across the codebase.
// Where sensible, values can be overridden via environment variables.

// Body parsing
export const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '10mb';

// Streaming
export const STREAM_ACTIVITY_TIMEOUT_MS = Number(process.env.STREAM_ACTIVITY_TIMEOUT_MS) || 30_000;
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 60_000;
export const MAX_BUFFER_SIZE = 1_048_576; // 1MB

// Agent loop
export const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS) || 50;
export const MAX_CACHE_ENTRIES = 500;
export const MAX_FILE_SIZE = 1_048_576; // 1MB

// Process management
export const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS) || 120_000;
export const PROCESS_TIMEOUT_MS = Number(process.env.PROCESS_TIMEOUT_MS) || 120_000;

// Preview
export const MAX_CONCURRENT_PREVIEWS = Number(process.env.MAX_CONCURRENT_PREVIEWS) || 5;
export const PREVIEW_START_PORT = 3100;

// Chat store
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

// Output limits
export const MAX_COMMAND_OUTPUT_CHARS = 12_000;
