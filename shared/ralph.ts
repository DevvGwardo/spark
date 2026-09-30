// ─── Ralph loop ──────────────────────────────────────────────────────────
// Pure logic for the fresh-agent Ralph loop, ported from DeepSeek Harness's
// `@deepseek-ai/dsh-tool-ralph` (MIT). One immutable objective; each round
// runs a FRESH agent with no conversation history; the shared workspace is
// the long-term memory; only a bounded structured report crosses rounds.
// The caller performs the actual agent I/O and subprocess management; this
// module owns the state machine, validation, and prompt construction.

/** Default and default ceiling for rounds per run. */
export const RALPH_MAX_ROUNDS_DEFAULT = 256;
/** Maximum serialized characters in one structured handoff. */
export const RALPH_MAX_HANDOFF_CHARS = 16_384;

export type RalphRoundStatus = 'continue' | 'complete' | 'blocked';
export type RalphRunStatus = 'complete' | 'blocked' | 'budget-limited' | 'round-failed' | 'failed' | 'cancelled';

export interface RalphRoundReport {
  status: RalphRoundStatus;
  summary: string;
  evidence: string[];
  nextSteps: string[];
  blocker: string;
}

export interface RalphRoundRecord {
  round: number;
  status: RalphRoundStatus;
  startedAt: number;
  finishedAt: number | null;
  summary: string;
  error?: string;
}

export interface RalphRun {
  id: string;
  objective: string;
  workspaceDir: string;
  maxRounds: number;
  status: RalphRunStatus;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  finalReport: RalphRoundReport | null;
  /** Last successful handoff when a round failed mid-run. */
  lastHandoff: RalphRoundReport | null;
  rounds: RalphRoundRecord[];
  error?: string;
}

export interface RalphRoundResult {
  report: RalphRoundReport | null;
  /** Set when the round itself failed to produce a valid report. */
  error?: string;
}

function normalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText);
}

/**
 * Validate one child round report against the fixed Ralph schema.
 * Mirrors dsh's validateReport(): continue needs nextSteps and no blocker;
 * complete needs evidence, no nextSteps, no blocker; blocked needs a
 * concrete blocker. Whole serialized report must fit the handoff budget.
 */
export function validateRalphReport(value: unknown, maxHandoffChars = RALPH_MAX_HANDOFF_CHARS): RalphRoundReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ralph round produced no structured report');
  }
  const report = value as Record<string, unknown>;
  if (!normalizedText(report.summary)) {
    throw new Error('Ralph report summary must be non-empty and trimmed');
  }
  if (!normalizedList(report.evidence) || !normalizedList(report.nextSteps)) {
    throw new Error('Ralph report evidence and nextSteps must be arrays of non-empty trimmed strings');
  }
  if (typeof report.blocker !== 'string' || report.blocker !== report.blocker.trim()) {
    throw new Error('Ralph report blocker must be a trimmed string');
  }
  const status = report.status;
  switch (status) {
    case 'continue':
      if ((report.nextSteps as string[]).length === 0 || report.blocker !== '') {
        throw new Error('a continuing Ralph report needs nextSteps and an empty blocker');
      }
      break;
    case 'complete':
      if ((report.evidence as string[]).length === 0 || (report.nextSteps as string[]).length !== 0 || report.blocker !== '') {
        throw new Error('a complete Ralph report needs evidence, no nextSteps, and an empty blocker');
      }
      break;
    case 'blocked':
      if (!normalizedText(report.blocker)) {
        throw new Error('a blocked Ralph report needs a concrete blocker');
      }
      break;
    default:
      throw new Error('Ralph report status is invalid');
  }
  const out: RalphRoundReport = {
    status,
    summary: report.summary as string,
    evidence: report.evidence as string[],
    nextSteps: report.nextSteps as string[],
    blocker: report.blocker as string,
  };
  const serialized = JSON.stringify(out);
  if (serialized.length > maxHandoffChars) {
    throw new Error(`Ralph report exceeds handoff budget (${serialized.length} > ${maxHandoffChars})`);
  }
  return out;
}

/**
 * Parse a child runner's stdout into a round result. The runner prints a
 * final line `RALPH_REPORT:<json>` on success or `RALPH_ERROR:<message>`
 * on failure; everything else is log noise.
 */
export function parseRalphRunnerOutput(stdout: string): RalphRoundResult {
  let report: RalphRoundReport | null = null;
  let error: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('RALPH_REPORT:')) {
      try {
        report = validateRalphReport(JSON.parse(line.slice('RALPH_REPORT:'.length)));
      } catch (err) {
        return { report: null, error: err instanceof Error ? err.message : String(err) };
      }
    } else if (line.startsWith('RALPH_ERROR:')) {
      error = line.slice('RALPH_ERROR:'.length).trim();
    }
  }
  if (report === null && error === undefined) {
    error = 'runner produced no report and no error marker';
  }
  return { report, error };
}

/**
 * Build the fresh worker's system prompt. Ported from dsh's RALPH_SCRIPT:
 * no parent conversation, workspace is authority, previous report is a
 * bounded handoff to verify against the workspace, not gospel.
 */
export function buildRalphRoundPrompt(input: {
  objective: string;
  round: number;
  maxRounds: number;
  previous: RalphRoundReport | null;
  workspaceDir: string;
}): string {
  const prior = input.previous === null
    ? '(none — this is the first round)'
    : JSON.stringify(input.previous);
  return [
    'You are one fresh worker in a Ralph loop. You receive no prior conversation. You are working in a shared workspace directory:',
    input.workspaceDir,
    'That workspace and its current file tree are the long-term memory and source of truth. Inspect it before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Treat the previous report only as a bounded handoff; confirm it against the workspace.',
    '',
    'Immutable objective:',
    input.objective,
    '',
    `Ralph round: ${input.round} of ${input.maxRounds}.`,
    '',
    `Previous structured handoff: ${prior}`,
    '',
    'When done, end your final message with one line: RALPH_REPORT:{...} where the JSON object has exactly these fields:',
    '{"status":"continue|complete|blocked","summary":"<non-empty trimmed string>","evidence":["<non-empty>"],"nextSteps":["<non-empty>"],"blocker":"<trimmed string>"}',
    'Rules: status continue requires at least one nextSteps entry and blocker "". status complete requires at least one evidence entry, empty nextSteps, and blocker "". status blocked requires a non-empty blocker describing exactly what human input or external change is needed. The whole JSON must stay under 16384 characters.',
  ].join('\n');
}

/**
 * Advance the loop one validated report. Returns the next round to run
 * (and mutates nothing) — the driver applies transitions. Ported from
 * dsh's fixed script: complete/blocked end the run, continue seeds the
 * next round, exhausted budget ends as budget-limited.
 */
export function nextRalphTransition(
  report: RalphRoundReport,
  round: number,
  maxRounds: number,
): { nextRound: number | null; runStatus: RalphRunStatus | null } {
  if (report.status === 'complete') return { nextRound: null, runStatus: 'complete' };
  if (report.status === 'blocked') return { nextRound: null, runStatus: 'blocked' };
  if (round >= maxRounds) return { nextRound: null, runStatus: 'budget-limited' };
  return { nextRound: round + 1, runStatus: null };
}
