// ─── Permission modes ───────────────────────────────────────────────────────
// Generalizes the legacy single boolean `planMode` into a 5-value enum that
// mirrors Claude Code's modes (default, plan, acceptEdits, bypassPermissions,
// dontAsk). `resolvePermissionMode` keeps the legacy `planMode: true` field
// working by mapping it onto the 'plan' mode.

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';

export interface PermissionModeSpec {
  id: PermissionMode;
  /** Short human label, e.g. 'Plan'. */
  label: string;
  /** One sentence, shown in a menu. */
  description: string;
  /** true => mutating tools must be stripped and the read-only prompt injected. */
  readOnly: boolean;
  /** true => file write/patch tools never prompt. */
  autoApproveEdits: boolean;
  /** true => every gated tool including shell commands never prompts. */
  autoApproveAll: boolean;
  /** System-prompt fragment for this mode, or null when the mode adds none. */
  prompt: string | null;
}

// Existing production read-only planning prompt — copied verbatim, do not edit.
const PLAN_MODE_PROMPT = `You are operating in PLAN MODE (read-only exploration).

RULES (strict):
- You MAY: read files, search code, analyze structure, inspect configs, run read-only commands
- You MAY NOT: write files, edit files, delete files, run mutating commands, apply patches
- You MAY NOT: use write_file, patch, or execute_code tools
- For the terminal tool, only run read-only commands (ls, cat, grep, find, git log, git diff, git status, etc.)
- Do NOT use shell redirects (>, >>) or destructive commands (rm, mv, chmod)

YOUR GOAL:
- Explore the codebase to understand the current state
- Produce a clear, actionable implementation plan
- Your plan should be "decision complete" — detailed enough for another engineer to implement without asking questions
- Structure your plan with: goal, files to modify, specific changes, and expected outcome

When you are done exploring and ready to present your plan, clearly mark it with a section header like "## Implementation Plan".`;

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

export const PERMISSION_MODES: Record<PermissionMode, PermissionModeSpec> = {
  default: {
    id: 'default',
    label: 'Default',
    description: 'Ask for approval before running mutating tools.',
    readOnly: false,
    autoApproveEdits: false,
    autoApproveAll: false,
    prompt: null,
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Read-only exploration; produce an implementation plan without making changes.',
    readOnly: true,
    autoApproveEdits: false,
    autoApproveAll: false,
    prompt: PLAN_MODE_PROMPT,
  },
  acceptEdits: {
    id: 'acceptEdits',
    label: 'Accept Edits',
    description: 'File edits are pre-approved and will not prompt for approval.',
    readOnly: false,
    autoApproveEdits: true,
    autoApproveAll: false,
    prompt: 'File edits (write_file, patch) are pre-approved in this mode. Do not request approval before editing files.',
  },
  bypassPermissions: {
    id: 'bypassPermissions',
    label: 'Bypass Permissions',
    description: 'All actions are pre-approved; never request permission for any tool.',
    readOnly: false,
    autoApproveEdits: true,
    autoApproveAll: true,
    prompt: 'All actions are pre-approved in this mode. Do not request permission for any tool, including shell commands.',
  },
  dontAsk: {
    id: 'dontAsk',
    label: "Don't Ask",
    description: 'Never ask for confirmation, but still refuse destructive or irreversible actions.',
    readOnly: false,
    autoApproveEdits: true,
    autoApproveAll: true,
    prompt: 'Never ask for confirmation in this mode. However, you must still refuse any destructive or irreversible action and explain why you refused.',
  },
};

// Stable display order used by menus and mode switchers.
export const PERMISSION_MODE_IDS: PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
];

const PERMISSION_MODE_ID_SET: ReadonlySet<PermissionMode> = new Set(PERMISSION_MODE_IDS);

/** True when `value` is one of the known PermissionMode ids. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODE_ID_SET.has(value as PermissionMode);
}

/**
 * Resolve the effective permission mode from a request shape that may carry
 * either the new `permissionMode` field or the legacy boolean `planMode`.
 * A valid `permissionMode` always wins; otherwise a boolean-true `planMode`
 * maps to 'plan'; otherwise the default mode is used. Never throws.
 */
export function resolvePermissionMode(input: { permissionMode?: unknown; planMode?: unknown }): PermissionMode {
  if (isPermissionMode(input.permissionMode)) {
    return input.permissionMode;
  }
  if (input.planMode === true) {
    return 'plan';
  }
  return DEFAULT_PERMISSION_MODE;
}

/** Look up the full spec for a mode. */
export function getPermissionModeSpec(mode: PermissionMode): PermissionModeSpec {
  return PERMISSION_MODES[mode];
}

/** True when the mode strips mutating tools and injects the read-only prompt. */
export function isReadOnlyMode(mode: PermissionMode): boolean {
  return getPermissionModeSpec(mode).readOnly;
}

/**
 * Whether a tool of the given kind should skip the approval prompt in this
 * mode. 'edit' honors autoApproveEdits or autoApproveAll; 'command' and
 * 'other' only honor autoApproveAll.
 */
export function shouldAutoApprove(mode: PermissionMode, kind: 'edit' | 'command' | 'other'): boolean {
  const spec = getPermissionModeSpec(mode);
  if (kind === 'edit') {
    return spec.autoApproveEdits || spec.autoApproveAll;
  }
  return spec.autoApproveAll;
}
