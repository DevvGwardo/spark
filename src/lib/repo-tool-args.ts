import { isRecord } from './utils';

export type RepoFileAction = 'create' | 'edit' | 'delete';

export interface NormalizedRepoPlanItem {
  path: string;
  action: RepoFileAction;
  description: string;
}

export interface NormalizedBatchRepoFileChange extends NormalizedRepoPlanItem {
  content: string;
}

export interface NormalizedEditRepoFileArgs {
  path: string;
  content: string;
  description: string;
}

export interface NormalizedDeleteRepoFileArgs {
  path: string;
  reason: string;
}

export interface NormalizedProposeChangesArgs {
  summary: string;
  plan: NormalizedRepoPlanItem[];
}

export interface NormalizedBatchEditRepoFilesArgs {
  changes: NormalizedBatchRepoFileChange[];
}

export interface RepoToolNormalizationOptions {
  existingPaths?: Iterable<string>;
}

const WRAPPER_KEYS = ['parameters', 'arguments', 'input', 'payload', 'data'] as const;
const BATCH_COLLECTION_KEYS = ['changes', 'edits', 'files', 'operations', 'items'] as const;
const PATH_KEYS = ['path', 'filePath', 'filepath', 'filename', 'file', 'target', 'targetPath'] as const;
const ACTION_KEYS = ['action', 'type', 'kind', 'operation', 'op', 'mode'] as const;
const CONTENT_KEYS = ['content', 'contents', 'text', 'value', 'code', 'newContent'] as const;
const DESCRIPTION_KEYS = ['description', 'summary', 'message', 'reason', 'note', 'purpose'] as const;

function parseMaybeJson<T>(value: T): T | unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function unwrapPayload(input: unknown): unknown {
  let current = parseMaybeJson(input);

  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) {
      return current;
    }

    const wrapperKey = WRAPPER_KEYS.find((key) => key in current);
    if (!wrapperKey) {
      return current;
    }

    const wrapped = parseMaybeJson(current[wrapperKey]);
    current = wrapped;
  }

  return current;
}

function readStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const raw = parseMaybeJson(record[key]);

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) {
        return trimmed;
      }
    }

    if (Array.isArray(raw)) {
      const joined = raw
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (isRecord(item)) {
            if (typeof item.text === 'string') return item.text;
            if (typeof item.content === 'string') return item.content;
          }
          return '';
        })
        .filter(Boolean)
        .join('');
      if (joined.trim()) {
        return joined.trim();
      }
    }

    if (isRecord(raw)) {
      if (typeof raw.text === 'string' && raw.text.trim()) {
        return raw.text.trim();
      }
      if (typeof raw.content === 'string' && raw.content.trim()) {
        return raw.content.trim();
      }
    }
  }

  return undefined;
}

function normalizeExplicitAction(rawAction: unknown): RepoFileAction | undefined {
  if (typeof rawAction !== 'string') {
    return undefined;
  }

  const value = rawAction.trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  if (['create', 'add', 'new', 'write'].includes(value)) {
    return 'create';
  }
  if (['edit', 'update', 'modify', 'replace', 'overwrite'].includes(value)) {
    return 'edit';
  }
  if (['delete', 'remove', 'del'].includes(value)) {
    return 'delete';
  }

  return undefined;
}

function inferAction(
  record: Record<string, unknown>,
  path: string | undefined,
  existingPaths: Set<string>,
): RepoFileAction | undefined {
  const explicit = ACTION_KEYS
    .map((key) => normalizeExplicitAction(record[key]))
    .find((value): value is RepoFileAction => !!value);
  if (explicit) {
    if (explicit === 'create' && path && existingPaths.has(path)) {
      return 'edit';
    }
    return explicit;
  }

  if (record.delete === true || record.deleted === true || record.remove === true || record.removed === true) {
    return 'delete';
  }

  const content = readStringField(record, CONTENT_KEYS);
  if (!content && ('reason' in record || 'delete' in record || 'deleted' in record || 'remove' in record)) {
    return 'delete';
  }

  if (!path) {
    return undefined;
  }

  return existingPaths.has(path) ? 'edit' : 'create';
}

function describeChange(action: RepoFileAction | undefined, path: string | undefined): string | undefined {
  if (!action || !path) {
    return undefined;
  }

  if (action === 'create') return `Create ${path}`;
  if (action === 'delete') return `Delete ${path}`;
  return `Edit ${path}`;
}

function collectExistingPaths(options?: RepoToolNormalizationOptions): Set<string> {
  return new Set(Array.from(options?.existingPaths ?? []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
}

function normalizePlanItem(
  input: unknown,
  existingPaths: Set<string>,
): Partial<NormalizedRepoPlanItem> {
  const value = unwrapPayload(input);
  if (!isRecord(value)) {
    return {};
  }

  const path = readStringField(value, PATH_KEYS);
  const action = inferAction(value, path, existingPaths);
  const description = readStringField(value, DESCRIPTION_KEYS) ?? describeChange(action, path);

  return {
    ...(path ? { path } : {}),
    ...(action ? { action } : {}),
    ...(description ? { description } : {}),
  };
}

function extractChangeList(input: unknown): unknown[] | null {
  const value = unwrapPayload(input);
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }

  for (const key of BATCH_COLLECTION_KEYS) {
    const candidate = unwrapPayload(value[key]);
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function normalizeProposeChangesArgs(
  input: unknown,
  options?: RepoToolNormalizationOptions,
): unknown {
  const value = unwrapPayload(input);
  if (!isRecord(value)) {
    return input;
  }

  const existingPaths = collectExistingPaths(options);
  const planItems = extractChangeList(value.plan) ?? extractChangeList(value);

  return {
    ...value,
    ...(readStringField(value, ['summary', 'description', 'message']) ? { summary: readStringField(value, ['summary', 'description', 'message']) } : {}),
    ...(planItems ? { plan: planItems.map((item) => normalizePlanItem(item, existingPaths)) } : {}),
  };
}

export function normalizeEditRepoFileArgs(input: unknown): unknown {
  const value = unwrapPayload(input);
  if (!isRecord(value)) {
    return input;
  }

  const path = readStringField(value, PATH_KEYS);
  const content = readStringField(value, CONTENT_KEYS);
  const description = readStringField(value, DESCRIPTION_KEYS) ?? describeChange('edit', path);

  return {
    ...value,
    ...(path ? { path } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(description ? { description } : {}),
  };
}

export function normalizeCreateRepoFileArgs(input: unknown): unknown {
  const value = unwrapPayload(input);
  if (!isRecord(value)) {
    return input;
  }

  const path = readStringField(value, PATH_KEYS);
  const content = readStringField(value, CONTENT_KEYS);
  const description = readStringField(value, DESCRIPTION_KEYS) ?? describeChange('create', path);

  return {
    ...value,
    ...(path ? { path } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(description ? { description } : {}),
  };
}

export function normalizeDeleteRepoFileArgs(input: unknown): unknown {
  const value = unwrapPayload(input);
  if (!isRecord(value)) {
    return input;
  }

  const path = readStringField(value, PATH_KEYS);
  const reason = readStringField(value, ['reason', 'description', 'summary', 'message']) ?? describeChange('delete', path);

  return {
    ...value,
    ...(path ? { path } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function normalizeBatchEditRepoFilesArgs(
  input: unknown,
  options?: RepoToolNormalizationOptions,
): unknown {
  const value = unwrapPayload(input);
  const changes = extractChangeList(value);
  if (!changes) {
    return input;
  }

  const existingPaths = collectExistingPaths(options);

  return {
    ...(isRecord(value) ? value : {}),
    changes: changes.map((item) => {
      const record = unwrapPayload(item);
      if (!isRecord(record)) {
        return {};
      }

      const path = readStringField(record, PATH_KEYS);
      const action = inferAction(record, path, existingPaths);
      const content = action === 'delete' ? '' : readStringField(record, CONTENT_KEYS);
      const description = readStringField(record, DESCRIPTION_KEYS) ?? describeChange(action, path);

      if (path) {
        existingPaths.add(path);
      }

      return {
        ...(path ? { path } : {}),
        ...(action ? { action } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(description ? { description } : {}),
      };
    }),
  };
}
