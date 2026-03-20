import { useChangesetStore } from '@/stores/changeset-store';

// ─── Event type constants ────────────────────────────────────────────────────

export const REPO_FILE_READ = 'repo_file_read' as const;
export const REPO_FILE_EDIT = 'repo_file_edit' as const;
export const REPO_FILE_CREATE = 'repo_file_create' as const;
export const REPO_FILE_DELETE = 'repo_file_delete' as const;
export const REPO_BATCH_EDIT = 'repo_batch_edit' as const;
export const REPO_PROPOSAL = 'repo_proposal' as const;

/** Set of all server tool event types for quick lookup. */
export const SERVER_TOOL_EVENT_TYPES = new Set([
  REPO_FILE_READ,
  REPO_FILE_EDIT,
  REPO_FILE_CREATE,
  REPO_FILE_DELETE,
  REPO_BATCH_EDIT,
  REPO_PROPOSAL,
]);

/** Tool names that execute server-side when the server has repo context. */
export const SERVER_EXECUTED_REPO_TOOLS = new Set([
  'read_repo_file',
  'edit_repo_file',
  'create_repo_file',
  'delete_repo_file',
  'batch_edit_repo_files',
  'propose_changes',
]);

// ─── Event payload interfaces ────────────────────────────────────────────────

export interface RepoFileReadEvent {
  type: typeof REPO_FILE_READ;
  path: string;
  content: string;
}

export interface RepoFileEditEvent {
  type: typeof REPO_FILE_EDIT;
  path: string;
  content: string;
  originalContent: string;
  description: string;
}

export interface RepoFileCreateEvent {
  type: typeof REPO_FILE_CREATE;
  path: string;
  content: string;
  description: string;
}

export interface RepoFileDeleteEvent {
  type: typeof REPO_FILE_DELETE;
  path: string;
  originalContent: string;
  reason: string;
}

export interface RepoBatchEditEvent {
  type: typeof REPO_BATCH_EDIT;
  changes: Array<{
    path: string;
    action: 'create' | 'edit' | 'delete';
    content: string;
    originalContent: string;
    description: string;
  }>;
}

export interface RepoProposalEvent {
  type: typeof REPO_PROPOSAL;
  summary: string;
  plan: Array<{ path: string; action: string; description: string }>;
}

export type ServerToolEvent =
  | RepoFileReadEvent
  | RepoFileEditEvent
  | RepoFileCreateEvent
  | RepoFileDeleteEvent
  | RepoBatchEditEvent
  | RepoProposalEvent;

// ─── Handler options ─────────────────────────────────────────────────────────

export interface HandleServerToolEventOpts {
  conversationId: string | null;
  addChange: (change: {
    path: string;
    action: 'create' | 'edit' | 'delete';
    content: string;
    originalContent?: string;
    staged: boolean;
  }) => void;
  batchAddChanges?: (changes: Array<{
    path: string;
    action: 'create' | 'edit' | 'delete';
    content: string;
    originalContent?: string;
    staged: boolean;
  }>) => void;
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * Process a server-side tool event and update the appropriate client stores.
 * Called from the hermesStreamFetch interceptor when server-side tool
 * execution events are detected in the SSE stream.
 */
export function handleServerToolEvent(
  event: ServerToolEvent,
  scopeId: string,
  opts: HandleServerToolEventOpts,
): void {
  switch (event.type) {
    case REPO_FILE_READ: {
      useChangesetStore.getState().cacheRepoFile(scopeId, event.path, event.content);
      break;
    }

    case REPO_FILE_EDIT: {
      useChangesetStore.getState().cacheRepoFile(scopeId, event.path, event.originalContent);
      opts.addChange({
        path: event.path,
        action: 'edit',
        content: event.content,
        originalContent: event.originalContent,
        staged: true,
      });
      break;
    }

    case REPO_FILE_CREATE: {
      opts.addChange({
        path: event.path,
        action: 'create',
        content: event.content,
        staged: true,
      });
      break;
    }

    case REPO_FILE_DELETE: {
      useChangesetStore.getState().cacheRepoFile(scopeId, event.path, event.originalContent);
      opts.addChange({
        path: event.path,
        action: 'delete',
        content: '',
        originalContent: event.originalContent,
        staged: true,
      });
      break;
    }

    case REPO_BATCH_EDIT: {
      // Cache original content for all files first
      for (const change of event.changes) {
        if (change.action !== 'create') {
          useChangesetStore.getState().cacheRepoFile(scopeId, change.path, change.originalContent);
        }
      }

      // Apply all changes atomically in a single store update to prevent
      // state interleaving issues with rapid sequential set() calls
      const changesToApply = event.changes.map((change) => ({
        path: change.path,
        action: change.action,
        content: change.content,
        originalContent: change.originalContent,
        staged: true as const,
      }));

      if (opts.batchAddChanges) {
        opts.batchAddChanges(changesToApply);
      } else {
        // Fallback to individual adds
        for (const change of changesToApply) {
          opts.addChange(change);
        }
      }

      break;
    }

    case REPO_PROPOSAL: {
      // Informational only — the proposal text is in the assistant message.
      // The client's proposal detection logic handles approval UX.
      break;
    }
  }
}
