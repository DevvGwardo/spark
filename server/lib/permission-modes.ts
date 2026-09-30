// ─── Permission modes (server re-export) ─────────────────────────────────────
// Thin re-export of the shared canonical definitions so the server and the
// browser agree on the same vocabulary. Used by the chat route to resolve the
// active mode, gate tool approvals, and inject the mode's system prompt.
//
// The definitions themselves live in `shared/permission-modes.ts` (imported by
// both the server and the client's settings/composer UI). Keep this module free
// of server-only logic.

export {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  PERMISSION_MODE_IDS,
  isPermissionMode,
  resolvePermissionMode,
  getPermissionModeSpec,
  isReadOnlyMode,
  shouldAutoApprove,
} from '../../shared/permission-modes';

export type { PermissionMode, PermissionModeSpec } from '../../shared/permission-modes';
