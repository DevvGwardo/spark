// Shared helpers for parsing tool-activity payloads and keying tool
// invocations. Kept in one module so every consumer agrees on the same
// fallbacks (divergent local copies previously produced mismatched keys when
// deduping the same invocation).

interface ToolInvocationLike {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
}

/**
 * Parse a tool activity's raw input string into an args object. Valid JSON
 * objects pass through; anything else (including non-object JSON) falls back
 * to `{ input: trimmed }` so callers still get the raw payload.
 */
export function parseToolActivityInput(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { input: trimmed };
  } catch {
    return { input: trimmed };
  }
}

/**
 * Stable dedup key for a tool invocation. Prefers the toolCallId when present
 * (streamed parts carry it), then falls back to a path/filename/batch digest
 * so partial-call and result parts of the same invocation still collide.
 */
export function getToolInvocationKey(
  invocation: ToolInvocationLike,
  fallbackIndex: number,
): string {
  if (invocation.toolCallId) {
    return invocation.toolCallId;
  }

  const args = invocation.args ?? {};
  const target = getToolPathArg(args);
  const batchPaths = Array.isArray(args?.changes)
    ? (args.changes as Array<unknown>)
        .map((change) =>
          change && typeof change === 'object'
            ? `${typeof (change as { action?: unknown }).action === 'string' ? (change as { action: string }).action : ''}:${typeof (change as { path?: unknown }).path === 'string' ? (change as { path: string }).path : getToolPathArg((change as Record<string, unknown>)) ?? ''}`
            : '',
        )
        .join('|')
    : '';

  // Distinguish calls that carry no path (terminal / search / web) by their
  // actual payload instead of collapsing them all to `tool:::` — otherwise
  // the positional fallbackIndex differs per list and the same logical call
  // hashes differently in parts vs toolInvocations vs persisted snapshots.
  const extra = !target
    ? ['command', 'query', 'pattern', 'url', 'code', 'input']
        .map((k) => {
          const v = (args as Record<string, unknown>)[k];
          return typeof v === 'string' && v.trim() ? `${k}=${v.trim().slice(0, 80)}` : '';
        })
        .filter(Boolean)
        .join('|')
    : '';

  return `${invocation.toolName}:${target ?? ''}:${batchPaths || extra || fallbackIndex}`;
}

/** Alias-aware path extraction — ACP/hermes tools use `file_path`, `file`,
 *  `pattern` (search) and `command` (terminal) where the repo SDK uses `path`.
 *  Every display path must go through here or `read: ?` regressions return. */
export function getToolPathArg(args: Record<string, unknown> | undefined | null): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const keys = ['path', 'file_path', 'filePath', 'filepath', 'filename', 'file', 'target', 'targetPath'];
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Search-style tools carry the human target under pattern/query.
  for (const key of ['pattern', 'query']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  for (const key of ['url', 'command']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  return undefined;
}

/** Canonical tool family for matching running vs completed events across the
 *  ACP-title namespace (`read`, `search`) and the SDK namespace
 *  (`read_repo_file`, `read_file`). Without this, completions never match
 *  their running row and spinners stick forever.
 *
 *  hermes titles embed the target (`read: /abs/path`, `search: pattern`,
 *  `terminal: npm test`) and the bridge forwards the title as the tool
 *  name — strip the `: …` suffix before mapping. */
export function normalizeToolName(tool: string): string {
  const raw = (tool || '').toLowerCase();
  const head = raw.split(':')[0].trim();
  const t = head || raw;
  if (['read', 'file', 'files', 'read_file', 'read_repo_file'].includes(t)) return 'read_file';
  if (['search', 'search_files', 'web_search'].includes(t)) return t === 'web_search' ? 'web_search' : 'search_files';
  if (['terminal', 'run_command', 'shell', 'code_execution', 'execute_python'].includes(t)) return 'terminal';
  if (['edit', 'write', 'write_file', 'patch', 'edit_repo_file', 'create_repo_file', 'delete_repo_file', 'batch_edit_repo_files'].includes(t)) return 'edit';
  if (['browse_url', 'browser', 'browse', 'web_extract'].includes(t)) return 'browse';
  return t;
}

interface ToolActivityLike {
  tool: string;
  status: 'running' | 'completed';
  input: string;
  output?: string | null;
}

function parseJsonSafeActivity(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input.trim());
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract a short human label from tool input JSON (path / query / url). */
export function extractToolActivityLabel(tool: string, input: string): string {
  if (tool === 'moa.reference') {
    const meta = parseJsonSafeActivity(input);
    if (meta?.label) return String(meta.label);
    return 'Advisor';
  }
  if (tool === 'moa.aggregating') {
    const meta = parseJsonSafeActivity(input);
    if (meta?.aggregator) return String(meta.aggregator);
    return 'Synthesizing';
  }
  try {
    const parsed = JSON.parse(input.trim()) as Record<string, unknown>;
    // Search tools: the query is the meaningful label, not the scope path.
    // (normalizeToolName also covers titled forms like "search: useState".)
    const family = normalizeToolName(tool);
    if (family === 'search_files' || family === 'web_search') {
      for (const key of ['pattern', 'query']) {
        const v = parsed[key];
        if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 50);
      }
    }
    const target = getToolPathArg(parsed);
    if (target) {
      // File paths shorten to last 2 segments; commands/queries pass through.
      return target.includes('/') ? target.split('/').slice(-2).join('/') : target.slice(0, 80);
    }
  } catch { /* ignore */ }
  return input.slice(0, 60) + (input.length > 60 ? '...' : '');
}

/** Shorten a path to its last two segments for compact live rows. */
export function shortenToolPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

/** Codex-style present-tense verb for a running tool + its target. */
export function getRunningToolLabel(event: Pick<ToolActivityLike, 'tool' | 'input'>): string {
  const label = extractToolActivityLabel(event.tool, event.input);
  const short = label.length > 80 ? `${label.slice(0, 80)}…` : label;
  const raw = (event.tool || '').toLowerCase();
  // Exact tool ids first (execute_python must stay "Running Python", not
  // collapse into the terminal family's "Running …").
  if (raw === 'execute_python' || raw === 'code_execution' || raw === 'code') {
    return 'Running Python';
  }
  if (raw === 'create_repo_file') {
    return short ? `Creating ${shortenToolPath(short)}` : 'Creating file';
  }
  if (raw === 'delete_repo_file') {
    return short ? `Deleting ${shortenToolPath(short)}` : 'Deleting file';
  }
  switch (normalizeToolName(event.tool)) {
    case 'read_file':
      return short ? `Reading ${shortenToolPath(short)}` : 'Reading file';
    case 'edit': {
      try {
        const parsed = JSON.parse(event.input.trim());
        const n = Array.isArray(parsed?.changes) ? parsed.changes.length : 0;
        if (n > 1) return `Editing ${n} files`;
      } catch { /* fall through */ }
      return short ? `Editing ${shortenToolPath(short)}` : 'Editing file';
    }
    case 'terminal':
      return short ? `Running ${short}` : 'Running command';
    case 'web_search':
      return short ? `Searching ${short}` : 'Searching';
    case 'search_files':
      return short ? `Searching ${short}` : 'Searching';
    case 'browse':
      return short ? `Reading ${short}` : 'Reading page';
    case 'moa.reference':
      return short && short !== 'Advisor' ? `Consulting ${short}` : 'Consulting advisor';
    case 'moa.aggregating':
      return short && short !== 'Synthesizing' ? `Synthesizing ${short}` : 'Synthesizing';
    case 'lsp.diagnostic':
      return short ? `Checking ${shortenToolPath(short)}` : 'Checking diagnostics';
    case 'propose_changes':
      return 'Planning changes';
    default:
      return short ? `Running ${event.tool} ${short}`.trim() : `Running ${event.tool}`;
  }
}

/** Latest running tool in a stream, for fluent status-bar / header text. */
export function getActiveRunningTool<T extends Pick<ToolActivityLike, 'status'>>(events: T[] = []): T | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].status === 'running') return events[i];
  }
  return null;
}
