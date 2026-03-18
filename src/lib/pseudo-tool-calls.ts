import {
  normalizeBatchEditRepoFilesArgs,
  normalizeCreateRepoFileArgs,
  normalizeDeleteRepoFileArgs,
  normalizeEditRepoFileArgs,
  normalizeProposeChangesArgs,
} from './repo-tool-args';
import { isRecord } from './utils';

export interface PseudoToolInvocation {
  toolName: string;
  args: Record<string, unknown>;
  rawText: string;
  start: number;
  end: number;
}

export interface TextFileEditInvocation {
  path: string;
  content: string;
  language?: string;
  rawText: string;
  start: number;
  end: number;
}

export interface PseudoToolMessageLike {
  content?: string;
  parts?: Array<{ type?: string; text?: string }>;
}

const SUPPORTED_TOOL_NAMES = [
  'propose_changes',
  'batch_edit_repo_files',
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'read_repo_file',
] as const;

const SUPPORTED_TOOL_SET = new Set<string>(SUPPORTED_TOOL_NAMES);
const TOOL_CALL_PATTERN = /\[?(propose_changes|batch_edit_repo_files|edit_repo_file|create_repo_file|delete_repo_file|read_repo_file)\(/g;
const FENCED_CODE_BLOCK_PATTERN = /```([A-Za-z0-9_+-]+)?\n([\s\S]*?)```/g;
const PATH_CANDIDATE_PATTERN = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g;
const HTML_PARAGRAPH_PATTERN = /<p>[\s\S]*?<\/p>/gi;
const JSON_BLOCK_START_PATTERN = /(^|\n)([ \t]*)([\[{])/g;
const HTML_ENTITY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;/gi, '\''],
  [/&amp;/gi, '&'],
];
const JSON_WRAPPER_KEYS = ['parameters', 'arguments', 'input', 'payload', 'data'] as const;
const JSON_CHANGE_KEYS = ['changes', 'edits', 'files', 'operations', 'items'] as const;
const JSON_PATH_KEYS = ['path', 'filePath', 'filepath', 'filename', 'file', 'target', 'targetPath'] as const;
const JSON_CONTENT_KEYS = ['content', 'contents', 'text', 'value', 'code', 'newContent'] as const;
const JSON_ACTION_KEYS = ['action', 'type', 'kind', 'operation', 'op', 'mode'] as const;

function countMatches(input: string, pattern: RegExp): number {
  const matches = input.match(pattern);
  return matches ? matches.length : 0;
}

function decodeHtmlEntities(input: string): string {
  return HTML_ENTITY_REPLACEMENTS.reduce(
    (decoded, [pattern, replacement]) => decoded.replace(pattern, replacement),
    input,
  );
}

function looksLikeLeakedRepoPayload(content: string): boolean {
  const normalized = decodeHtmlEntities(content)
    .replace(/^<p>/i, '')
    .replace(/<\/p>$/i, '')
    .trim();

  if (!normalized) return false;

  const repoKeyCount = countMatches(
    normalized,
    /"?(?:parameters|content|description|path|action|summary|plan|changes)"?\s*:/g,
  );
  const hasCodeMarkers = /(?:export\s+default|import\s+\{|const\s+[A-Za-z_$]|function\s+[A-Za-z_$]|className=|return\s*<|onClick=|<\/?[A-Za-z])/i.test(normalized);

  // Classic case: starts with JSON structure
  if (/^(?:\[|\{)/.test(normalized) && repoKeyCount >= 2 && hasCodeMarkers) {
    return true;
  }

  // Orphaned tail fragment: ends with tool-call closing like `])` or `])]`
  // and contains repo-payload keys (e.g. `"description": "..."`)
  if (/\]\s*\)\s*\]?\s*$/.test(normalized) && repoKeyCount >= 1) {
    return true;
  }

  return false;
}

function stripEmbeddedLeakedRepoPayloads(content: string): string {
  return content.replace(
    /(?:<p>)?\s*\[\s*\{[\s\S]*?"?(?:parameters|content)"?\s*:[\s\S]*?"?description"?\s*:[\s\S]*?(?:\}\s*\]\s*(?:<\/p>)?|$)/gi,
    (candidate) => (looksLikeLeakedRepoPayload(candidate) ? '' : candidate),
  );
}

function isProbableRepoFilePath(candidate: string): boolean {
  return (
    !!candidate &&
    !candidate.includes('://') &&
    !candidate.startsWith('www.') &&
    !candidate.endsWith('.') &&
    !candidate.endsWith('...') &&
    !candidate.startsWith('.') &&
    /[A-Za-z0-9]/.test(candidate)
  );
}

function extractPathCandidateFromLine(line: string): string | null {
  const matches = line.match(PATH_CANDIDATE_PATTERN) || [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = matches[index]?.replace(/^[(*`"'[\s-]+/, '').replace(/[)*`"',:\]\s]+$/, '') || '';
    if (isProbableRepoFilePath(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getPathFromFenceContext(content: string, fenceStart: number): string | null {
  const prefix = content.slice(Math.max(0, fenceStart - 320), fenceStart);
  const lines = prefix.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() || '';
    if (!line) continue;
    if (line.startsWith('```')) continue;
    const candidate = extractPathCandidateFromLine(line);
    if (candidate) return candidate;
    // Stop after the first non-empty line that clearly isn't a filename line.
    if (/[.:]$/.test(line) || /updated files|applied the changes|current content/i.test(line)) {
      continue;
    }
    break;
  }

  return null;
}

function findMatchingDelimiter(
  input: string,
  start: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitArgumentAssignments(input: string): Array<{ key: string; rawValue: string }> {
  const assignments: Array<{ key: string; rawValue: string }> = [];
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /[\s,]/.test(input[cursor])) {
      cursor += 1;
    }

    if (cursor >= input.length) break;

    const keyStart = cursor;
    while (cursor < input.length && /[a-zA-Z0-9_]/.test(input[cursor])) {
      cursor += 1;
    }
    const key = input.slice(keyStart, cursor).trim();
    if (!key) break;

    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }

    if (input[cursor] !== '=') {
      break;
    }
    cursor += 1;

    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }

    const valueStart = cursor;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    let bracketDepth = 0;
    let braceDepth = 0;
    let parenDepth = 0;

    while (cursor < input.length) {
      const char = input[cursor];

      if (quote) {
        if (escaped) {
          escaped = false;
          cursor += 1;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          cursor += 1;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        cursor += 1;
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        cursor += 1;
        continue;
      }

      if (char === '[') bracketDepth += 1;
      if (char === ']') bracketDepth -= 1;
      if (char === '{') braceDepth += 1;
      if (char === '}') braceDepth -= 1;
      if (char === '(') parenDepth += 1;
      if (char === ')') parenDepth -= 1;

      if (
        char === ',' &&
        bracketDepth === 0 &&
        braceDepth === 0 &&
        parenDepth === 0
      ) {
        break;
      }

      cursor += 1;
    }

    const rawValue = input.slice(valueStart, cursor).trim();
    assignments.push({ key, rawValue });

    if (input[cursor] === ',') {
      cursor += 1;
    }
  }

  return assignments;
}

function decodeQuotedString(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first !== '"' && first !== "'") || last !== first) {
    return null;
  }

  if (first === '"') {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  const inner = trimmed.slice(1, -1);
  return inner
    .replace(/\\\\/g, '\\')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function normalizeJsonLike(rawValue: string): string {
  return rawValue
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
}

function decodeValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';

  const quoted = decodeQuotedString(trimmed);
  if (quoted !== null) {
    return quoted;
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(normalizeJsonLike(trimmed));
    } catch {
      return trimmed;
    }
  }

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function parseMaybeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return value;
  }

  try {
    return JSON.parse(normalizeJsonLike(trimmed));
  } catch {
    return value;
  }
}

function unwrapJsonPayload(value: unknown): unknown {
  let current = parseMaybeJsonValue(value);

  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current)) {
      return current;
    }

    const wrapperKey = JSON_WRAPPER_KEYS.find((key) => key in current);
    if (!wrapperKey) {
      return current;
    }

    current = parseMaybeJsonValue(current[wrapperKey]);
  }

  return current;
}

function readJsonStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = parseMaybeJsonValue(record[key]);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function readJsonArrayField(record: Record<string, unknown>, keys: readonly string[]): unknown[] | null {
  for (const key of keys) {
    const value = parseMaybeJsonValue(record[key]);
    if (Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

function normalizeJsonToolName(record: Record<string, unknown>): 'create_repo_file' | 'edit_repo_file' | 'delete_repo_file' | null {
  const explicitAction = readJsonStringField(record, JSON_ACTION_KEYS)?.toLowerCase();
  if (explicitAction) {
    if (['create', 'add', 'new', 'write'].includes(explicitAction)) {
      return 'create_repo_file';
    }
    if (['delete', 'remove', 'del'].includes(explicitAction)) {
      return 'delete_repo_file';
    }
    if (['edit', 'update', 'modify', 'replace', 'overwrite'].includes(explicitAction)) {
      return 'edit_repo_file';
    }
  }

  if (record.delete === true || record.deleted === true || record.remove === true || record.removed === true) {
    return 'delete_repo_file';
  }

  return null;
}

function toInvocationArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function extractJsonWrappedRepoInvocations(content: string): PseudoToolInvocation[] {
  const invocations: PseudoToolInvocation[] = [];
  if (!content) return invocations;

  JSON_BLOCK_START_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = JSON_BLOCK_START_PATTERN.exec(content)) !== null) {
    const start = match.index + match[1].length + match[2].length;
    const openChar = match[3];
    const closeChar = openChar === '[' ? ']' : '}';
    const end = findMatchingDelimiter(content, start, openChar, closeChar);
    if (end < 0) {
      continue;
    }

    const rawText = content.slice(start, end + 1);
    if (!/"(?:parameters|arguments|input|payload|data)"\s*:/.test(rawText)) {
      JSON_BLOCK_START_PATTERN.lastIndex = start + 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(normalizeJsonLike(rawText.trim()));
    } catch {
      JSON_BLOCK_START_PATTERN.lastIndex = start + 1;
      continue;
    }

    const appendInvocation = (toolName: PseudoToolInvocation['toolName'], args: unknown) => {
      invocations.push({
        toolName,
        args: toInvocationArgs(args),
        rawText,
        start,
        end: end + 1,
      });
    };

    if (Array.isArray(parsed)) {
      const unwrappedItems = parsed.map((item) => unwrapJsonPayload(item)).filter(isRecord);
      const hasBatchChanges = unwrappedItems.some((item) => !!readJsonArrayField(item, JSON_CHANGE_KEYS));
      const hasEditLikeItems = unwrappedItems.some((item) => {
        const toolName = normalizeJsonToolName(item);
        return (
          toolName === 'delete_repo_file' ||
          toolName === 'create_repo_file' ||
          readJsonStringField(item, JSON_CONTENT_KEYS) !== undefined
        );
      });

      if (hasBatchChanges || hasEditLikeItems) {
        const batchSource = hasBatchChanges && parsed.length === 1 ? parsed[0] : parsed;
        const normalized = normalizeBatchEditRepoFilesArgs(batchSource) as { changes?: unknown };
        if (Array.isArray(normalized.changes) && normalized.changes.some((change) => isRecord(change) && typeof change.path === 'string')) {
          appendInvocation('batch_edit_repo_files', normalized);
          JSON_BLOCK_START_PATTERN.lastIndex = end + 1;
          continue;
        }
      }

      const readPaths = unwrappedItems
        .map((item) => readJsonStringField(item, JSON_PATH_KEYS))
        .filter((path): path is string => !!path);

      if (readPaths.length === unwrappedItems.length && readPaths.length > 0) {
        readPaths.forEach((path) => appendInvocation('read_repo_file', { path }));
        JSON_BLOCK_START_PATTERN.lastIndex = end + 1;
        continue;
      }
    }

    const unwrapped = unwrapJsonPayload(parsed);
    if (!isRecord(unwrapped)) {
      JSON_BLOCK_START_PATTERN.lastIndex = start + 1;
      continue;
    }

    if (readJsonArrayField(unwrapped, ['plan'])) {
      const normalized = normalizeProposeChangesArgs(parsed);
      appendInvocation('propose_changes', normalized);
      JSON_BLOCK_START_PATTERN.lastIndex = end + 1;
      continue;
    }

    if (readJsonArrayField(unwrapped, JSON_CHANGE_KEYS)) {
      const normalized = normalizeBatchEditRepoFilesArgs(parsed);
      appendInvocation('batch_edit_repo_files', normalized);
      JSON_BLOCK_START_PATTERN.lastIndex = end + 1;
      continue;
    }

    const path = readJsonStringField(unwrapped, JSON_PATH_KEYS);
    if (!path) {
      JSON_BLOCK_START_PATTERN.lastIndex = start + 1;
      continue;
    }

    const toolName = normalizeJsonToolName(unwrapped);
    const contentValue = readJsonStringField(unwrapped, JSON_CONTENT_KEYS);

    if (toolName === 'delete_repo_file') {
      appendInvocation('delete_repo_file', normalizeDeleteRepoFileArgs(parsed));
    } else if (toolName === 'create_repo_file') {
      appendInvocation('create_repo_file', normalizeCreateRepoFileArgs(parsed));
    } else if (contentValue !== undefined) {
      appendInvocation('edit_repo_file', normalizeEditRepoFileArgs(parsed));
    } else {
      appendInvocation('read_repo_file', { path });
    }

    JSON_BLOCK_START_PATTERN.lastIndex = end + 1;
  }

  return invocations;
}

function parseArgumentMap(input: string): Record<string, unknown> {
  return Object.fromEntries(
    splitArgumentAssignments(input).map(({ key, rawValue }) => [key, decodeValue(rawValue)]),
  );
}

export function getPseudoToolSourceText(message: PseudoToolMessageLike): string {
  const content = typeof message.content === 'string' ? message.content : '';
  const partText = (message.parts || [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n\n');

  if (!content) return partText;
  if (!partText) return content;
  if (partText.includes(content)) return partText;
  if (content.includes(partText)) return content;
  return `${content}\n\n${partText}`;
}

export function extractPseudoToolInvocations(content: string): PseudoToolInvocation[] {
  const invocations: PseudoToolInvocation[] = [];
  if (!content) return invocations;

  TOOL_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOOL_CALL_PATTERN.exec(content)) !== null) {
    const toolName = match[1];
    if (!SUPPORTED_TOOL_SET.has(toolName)) {
      continue;
    }

    const matchedText = match[0];
    const hasLeadingBracket = matchedText.startsWith('[');
    const start = match.index;
    const openParenIndex = start + matchedText.length - 1;
    const closeParenIndex = findMatchingDelimiter(content, openParenIndex, '(', ')');
    if (closeParenIndex < 0) {
      continue;
    }

    let end = closeParenIndex + 1;
    if (hasLeadingBracket && content[end] === ']') {
      end += 1;
    }

    const argsSource = content.slice(openParenIndex + 1, closeParenIndex);
    invocations.push({
      toolName,
      args: parseArgumentMap(argsSource),
      rawText: content.slice(start, end),
      start,
      end,
    });

    TOOL_CALL_PATTERN.lastIndex = end;
  }

  invocations.push(...extractJsonWrappedRepoInvocations(content));
  return invocations;
}

export function extractTextFileEdits(content: string): TextFileEditInvocation[] {
  const edits: TextFileEditInvocation[] = [];
  if (!content) return edits;

  FENCED_CODE_BLOCK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FENCED_CODE_BLOCK_PATTERN.exec(content)) !== null) {
    const path = getPathFromFenceContext(content, match.index);
    const code = match[2] ?? '';
    if (!path || !code.trim()) {
      continue;
    }

    edits.push({
      path,
      content: code.replace(/\n$/, ''),
      language: match[1] || undefined,
      rawText: match[0],
      start: match.index,
      end: FENCED_CODE_BLOCK_PATTERN.lastIndex,
    });
  }

  const deduped = new Map<string, TextFileEditInvocation>();
  for (const edit of edits) {
    deduped.set(edit.path, edit);
  }

  return [...deduped.values()];
}

/**
 * If position `pos` sits inside a fenced code block (``` … ```),
 * return the start of the opening fence. Otherwise return pos unchanged.
 */
function expandToCodeFence(content: string, pos: number): number {
  // Walk backwards from pos looking for an opening fence that isn't closed before pos
  const fencePattern = /^(`{3,})[^\n]*$/gm;
  let openFenceStart = -1;
  let inFence = false;
  let fm: RegExpExecArray | null;

  while ((fm = fencePattern.exec(content)) !== null) {
    if (fm.index > pos) break;
    if (!inFence) {
      openFenceStart = fm.index;
      inFence = true;
    } else {
      inFence = false;
      openFenceStart = -1;
    }
  }

  // If pos is inside an open fence, return the fence start
  return inFence && openFenceStart >= 0 ? openFenceStart : pos;
}

/**
 * If position `pos` (end of a stripped region) is followed by a closing code fence,
 * return the position after the closing fence. Otherwise return pos unchanged.
 */
function expandPastClosingFence(content: string, pos: number): number {
  const afterSlice = content.slice(pos);
  const m = afterSlice.match(/^\s*`{3,}[ \t]*(?:\n|$)/);
  return m ? pos + m[0].length : pos;
}

export function stripPseudoToolInvocations(content: string, isStreaming = false): string {
  const invocations = extractPseudoToolInvocations(content);
  const hasPotentialPayloadLeak =
    looksLikeLeakedRepoPayload(content) ||
    /<p>[\s\S]*"parameters"[\s\S]*"description"[\s\S]*<\/p>/i.test(content);

  // During streaming, also detect partial (unclosed) tool calls and truncate from that point
  let partialStart = -1;
  if (isStreaming) {
    TOOL_CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOOL_CALL_PATTERN.exec(content)) !== null) {
      const openParenIndex = match.index + match[0].length - 1;
      const closeParenIndex = findMatchingDelimiter(content, openParenIndex, '(', ')');
      if (closeParenIndex < 0) {
        // Unclosed call — still streaming in. Expand to include surrounding code fence.
        partialStart = expandToCodeFence(content, match.index);
        break;
      }
      TOOL_CALL_PATTERN.lastIndex = closeParenIndex + 1;
    }
  }

  // Fallback: if the model dumped a raw tool-call-style string that we couldn't
  // fully parse (malformed args, truncated content), strip it with a broad regex
  // so the user doesn't see raw `batch_edit_repo_files(changes=[...])` text.
  const RAW_TOOL_DUMP_PATTERN = new RegExp(
    `(?:${SUPPORTED_TOOL_NAMES.join('|')})\\s*\\([\\s\\S]{50,}`,
    'g',
  );
  const hasRawToolDump = invocations.length === 0 && RAW_TOOL_DUMP_PATTERN.test(content);

  // Detect fenced code blocks containing tool-parameter JSON (e.g. `{"parameters": {"path": "..."}}`).
  // These occur when the model wraps tool call args in code fences instead of function-call syntax.
  const hasToolParamCodeBlocks = /```[a-z]*\n[\s\S]*?"parameters"\s*:[\s\S]*?```/.test(content);

  if (invocations.length === 0 && partialStart < 0 && !hasPotentialPayloadLeak && !hasRawToolDump && !hasToolParamCodeBlocks) return content;

  // Build ranges to cut, expanding each to include surrounding code fences
  const cuts = Array.from(
    new Map(
      invocations.map((inv) => {
        const cut = {
          start: expandToCodeFence(content, inv.start),
          end: expandPastClosingFence(content, inv.end),
        };
        return [`${cut.start}:${cut.end}`, cut] as const;
      }),
    ).values(),
  ).sort((left, right) => left.start - right.start);

  let cursor = 0;
  let cleaned = '';

  for (const cut of cuts) {
    cleaned += content.slice(cursor, cut.start);
    cursor = cut.end;
  }

  if (partialStart >= 0 && partialStart >= cursor) {
    cleaned += content.slice(cursor, partialStart);
  } else {
    cleaned += content.slice(cursor);
  }

  // Strip orphan code-fenced blocks left behind after tool call removal,
  // or standalone arg dumps the model outputs as separate code blocks.
  cleaned = cleaned.replace(
    /```[a-z]*\n([\s\S]*?)```/g,
    (_fenceBlock, inner: string) => {
      const trimmed = inner.trim();
      // Empty or whitespace-only fence (left behind after stripping inner tool calls)
      if (!trimmed) return '';
      // Looks like a tool-call argument dump (JSON with tool-related keys,
      // or a JSON array of file paths)
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        if (
          /"(?:changes|plan|path|action|content|description|summary|parameters)"/.test(trimmed) ||
          /^\[[\s\S]*\]$/.test(trimmed) && /\.(js|ts|jsx|tsx|css|html|json|py|md|vue|svelte)\b/.test(trimmed)
        ) {
          return '';
        }
      }
      return _fenceBlock;
    },
  );

  // Strip orphaned JSON array brackets that remain after tool-call code blocks
  // are removed. These appear as standalone [ or ] on their own line when the
  // model wraps tool parameters in JSON arrays around fenced code blocks.
  cleaned = cleaned.replace(/^\s*[\[\]]\s*$/gm, '');

  cleaned = cleaned.replace(HTML_PARAGRAPH_PATTERN, (paragraph) => (
    looksLikeLeakedRepoPayload(paragraph) ? '' : paragraph
  ));
  cleaned = stripEmbeddedLeakedRepoPayloads(cleaned);

  // Strip raw tool-call function invocations the model dumped as plain text
  // (e.g. `batch_edit_repo_files(changes=[...])` that wasn't parseable above)
  const rawDumpPattern = new RegExp(
    `(?:${SUPPORTED_TOOL_NAMES.join('|')})\\s*\\([\\s\\S]{50,}`,
    'g',
  );
  cleaned = cleaned.replace(rawDumpPattern, '');

  if (
    /^(?:<p>)?\s*(?:\[|\{)/i.test(cleaned.trim()) &&
    /"parameters"/i.test(cleaned) &&
    /"description"/i.test(cleaned) &&
    /(?:export\s+default|import\s+\{|className=|onClick=|return\s*<)/i.test(cleaned)
  ) {
    return '';
  }

  if (looksLikeLeakedRepoPayload(cleaned)) {
    return '';
  }

  return cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
