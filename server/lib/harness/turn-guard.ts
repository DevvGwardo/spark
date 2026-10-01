/**
 * Per-turn guardrails for the agent loop (ported from the flash harness,
 * codex-rs `core/src/flash_guard.rs`). Deliberately simple heuristics:
 *
 *   - Stuck: the same tool call (normalized args) three times, or the same
 *     command failing twice in a row with identical output → a nudge to step
 *     back and try something else.
 *   - Verify before done: files were edited and no command ran after the
 *     last edit when the model tries to finish → one nudge to run tests/build.
 *   - Zero-edit watchdog: the task asks for changes, the model used tools but
 *     edited nothing, and it tries to finish → one nudge to actually do it.
 *
 * Each nudge is a short user-role message the loop appends before the next
 * model call. Verify and watchdog fire at most once per turn, so a model that
 * has a good reason can still finish.
 */

export const STUCK_REPEAT_TRIGGER = 3;

export const VERIFY_NUDGE =
  "You modified files during this turn but haven't run any verification commands. " +
  "Run the relevant tests/build/lint (or explain why they can't be run) and continue " +
  "instead of ending the turn.";

export const WATCHDOG_NUDGE =
  "You inspected files and gathered context, but haven't modified any files or completed " +
  "the requested changes yet. Implement the solution and verify it before concluding.";

export function stuckNudge(call: string): string {
  return (
    `You appear to be looping on \`${call}\`. Step back, re-read the error or output ` +
    "carefully, and try a different approach instead of repeating the same action."
  );
}

export interface ToolClassifier {
  isEdit(name: string): boolean;
  isShell(name: string): boolean;
}

const EDIT_TOOL = /^(apply_patch|write|write_file|edit|edit_file|multi_edit|str_replace|str_replace_editor|create_file|replace_in_file|patch|insert)$|patch|^write_(?!stdin)/i;
const SHELL_TOOL = /^(bash|shell|exec|exec_command|run_command|run_terminal_cmd|terminal|execute_command|local_shell|run_shell)$/i;

export const defaultToolClassifier: ToolClassifier = {
  isEdit: (name) => EDIT_TOOL.test(baseName(name)),
  isShell: (name) => SHELL_TOOL.test(baseName(name)),
};

/** `mcp__server__tool` / `server:tool` / `server/tool` → `tool`. */
function baseName(name: string): string {
  const parts = name.split(/__|[:/]/);
  return parts[parts.length - 1] ?? name;
}

export class TurnGuard {
  private readonly callCounts = new Map<string, number>();
  private readonly lastFailure = new Map<string, string>();
  private readonly failureStreak = new Map<string, number>();
  private pendingStuck: string | null = null;
  private toolCalls = 0;
  private editedFiles = false;
  private shellAfterLastEdit = false;
  private verifyNudged = false;
  private watchdogNudged = false;

  constructor(
    private readonly userMessage: string,
    private readonly classifier: ToolClassifier = defaultToolClassifier,
  ) {}

  recordToolCall(name: string, args: unknown): void {
    this.toolCalls += 1;
    if (this.classifier.isEdit(name)) {
      this.editedFiles = true;
      this.shellAfterLastEdit = false;
    } else if (this.classifier.isShell(name)) {
      this.shellAfterLastEdit = true;
    }
    const key = callKey(name, args);
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);
    if (count === STUCK_REPEAT_TRIGGER) this.pendingStuck = stuckNudge(key);
  }

  recordToolResult(name: string, args: unknown, output: string, failed: boolean): void {
    const command = commandOf(name, args, this.classifier);
    if (!failed) {
      this.lastFailure.delete(command);
      this.failureStreak.delete(command);
      // A shell command that now succeeds may legitimately be re-run.
      if (this.classifier.isShell(name)) this.callCounts.delete(callKey(name, args));
      return;
    }
    const normalized = output.trim();
    if (this.lastFailure.get(command) === normalized) {
      const streak = (this.failureStreak.get(command) ?? 1) + 1;
      this.failureStreak.set(command, streak);
      if (streak === 2) this.pendingStuck = stuckNudge(command);
    } else {
      this.lastFailure.set(command, normalized);
      this.failureStreak.set(command, 1);
    }
  }

  /** Nudge to inject before the next model call, if the turn looks stuck. */
  takeStuckNudge(): string | null {
    const nudge = this.pendingStuck;
    this.pendingStuck = null;
    return nudge;
  }

  /**
   * Called when the model ends its turn (no tool calls). Returns a nudge to
   * inject and keep the loop going, or null to let the turn finish.
   */
  beforeFinish(): string | null {
    if (this.editedFiles && !this.shellAfterLastEdit && !this.verifyNudged) {
      this.verifyNudged = true;
      return VERIFY_NUDGE;
    }
    if (
      !this.editedFiles &&
      this.toolCalls > 0 &&
      !this.watchdogNudged &&
      taskAsksForChanges(this.userMessage)
    ) {
      this.watchdogNudged = true;
      return WATCHDOG_NUDGE;
    }
    return null;
  }
}

/** Stable key for a call: tool name + args with sorted keys and trimmed strings. */
export function callKey(name: string, args: unknown): string {
  return `${name}(${canonicalJson(typeof args === "string" ? tryJson(args) : args)})`;
}

function commandOf(name: string, args: unknown, classifier: ToolClassifier): string {
  const value = typeof args === "string" ? tryJson(args) : args;
  if (classifier.isShell(name) && value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const cmd = record.command ?? record.cmd;
    if (typeof cmd === "string") return cmd.trim();
    if (Array.isArray(cmd)) return cmd.filter((p) => typeof p === "string").join(" ");
  }
  return callKey(name, value);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value === "string" ? value.trim() : value;
}

const CHANGE_VERBS = new Set(
  (
    "fix fixes fixed fixing add adds added adding implement implements implemented implementing " +
    "implementation refactor refactors refactored refactoring rename renames renamed renaming " +
    "update updates updated updating create creates created creating bump bumps bumped bumping " +
    "write writes wrote writing modify modifies modified modifying change changes changed changing " +
    "edit edits edited editing patch patches patched patching remove removes removed removing " +
    "delete deletes deleted deleting generate generates generated generating harden hardens " +
    "debug debugs debugged debugging rewrite rewrites rewriting reorganize migrate migrates " +
    "migrated migrating port ports ported porting build builds"
  ).split(" "),
);

const QUESTION_STARTERS = [
  "what ", "which ", "how ", "why ", "where ", "who ", "when ", "can you explain",
  "could you explain", "explain ", "tell me about", "is there ", "are there ", "does ",
  "do ", "should ",
];

export function isPureQuestion(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  const startsWithQuestion = QUESTION_STARTERS.some((q) => lower.startsWith(q));
  return startsWithQuestion && (lower.endsWith("?") || !lower.includes("\n"));
}

export function taskAsksForChanges(text: string): boolean {
  if (isPureQuestion(text)) return false;
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .some((word) => CHANGE_VERBS.has(word));
}
