// ─── Context compaction ───────────────────────────────────────────────────
// Pure logic for deciding when a conversation's token usage has reached the
// model's context window threshold and should be compacted (summarized into
// a handoff). The caller performs the actual model I/O; this module only
// evaluates the decision and builds the summarizer message array.

export const DEFAULT_COMPACTION_THRESHOLD = 0.95;
export const MIN_COMPACTION_THRESHOLD = 0.5;
export const MAX_COMPACTION_THRESHOLD = 1;

export interface CompactionInput {
  /** Tokens currently in the window. */
  used: number;
  /** The model's context window. */
  total: number;
  /** Fraction 0..1, defaults to DEFAULT_COMPACTION_THRESHOLD. */
  threshold?: number;
  /** Defaults to true. */
  enabled?: boolean;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  /** used/total as a fraction 0..1 (0 when total is not positive). */
  percentage: number;
  /** The normalized threshold actually applied. */
  threshold: number;
  /** Short machine-readable reason. */
  reason: string;
}

/**
 * Normalize an arbitrary threshold value into [MIN_COMPACTION_THRESHOLD,
 * MAX_COMPACTION_THRESHOLD]. Accepts a number or a numeric string; clamps
 * out-of-range values. Returns DEFAULT_COMPACTION_THRESHOLD for anything
 * non-finite, non-numeric, undefined, null, or NaN. Never throws.
 */
export function normalizeCompactionThreshold(value: unknown): number {
  let candidate: number;
  if (typeof value === 'number') {
    candidate = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    candidate = Number(value);
  } else {
    return DEFAULT_COMPACTION_THRESHOLD;
  }
  if (!Number.isFinite(candidate)) {
    return DEFAULT_COMPACTION_THRESHOLD;
  }
  return Math.min(
    MAX_COMPACTION_THRESHOLD,
    Math.max(MIN_COMPACTION_THRESHOLD, candidate),
  );
}

/**
 * Evaluate whether the conversation should be compacted based on current
 * token usage relative to the model's context window. Never throws.
 */
export function evaluateCompaction(input: CompactionInput): CompactionDecision {
  const threshold = normalizeCompactionThreshold(input.threshold);
  const used = input.used;
  const total = input.total;

  const totalOk = Number.isFinite(total) && total > 0;
  const usedOk = Number.isFinite(used) && used > 0;
  const percentage = totalOk && usedOk ? used / total : 0;

  if (input.enabled === false) {
    return { shouldCompact: false, percentage, threshold, reason: 'disabled' };
  }
  if (!totalOk) {
    return { shouldCompact: false, percentage, threshold, reason: 'no-context-window' };
  }
  if (!usedOk) {
    return { shouldCompact: false, percentage, threshold, reason: 'no-usage' };
  }
  if (percentage >= threshold) {
    return { shouldCompact: true, percentage, threshold, reason: 'threshold-reached' };
  }
  return { shouldCompact: false, percentage, threshold, reason: 'below-threshold' };
}

export const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to compact the preceding conversation into a dense, structured handoff that preserves everything a fresh agent needs to continue the work without rereading the transcript.

Produce a summary with these sections:
- Goal: The user's overarching objective and what they asked for.
- Decisions: Every decision made and the reasoning behind it.
- Files & Paths: Every file, directory, or path touched or referenced.
- Current State: Where things stand right now — what works, what is in progress.
- Outstanding: What remains to be done, including any open questions or blockers.
- Conventions & Constraints: Any rules, style conventions, or constraints that must be followed.

Preserve concrete identifiers verbatim — file paths, function names, variable names, commands, package names, and version numbers must appear exactly as they were in the conversation. Do not paraphrase, abbreviate, or invent identifiers.

Omit all chit-chat, pleasantries, filler, and meta-commentary. Include only information that advances the work.

Reply with ONLY the summary. Do not include any preamble, explanation, or conversation.`;

export const COMPACTION_INSTRUCTION =
  'Summarize the conversation above into the structured handoff described in your instructions.';

export interface CompactionMessage {
  role: string;
  content: string;
}

/**
 * Build the message array to send to the summarizer: the conversation
 * transcript, then the compaction instruction as a final user turn.
 * Does not mutate the input array; tolerates non-array input as empty.
 */
export function buildCompactionMessages(
  messages: CompactionMessage[],
): CompactionMessage[] {
  const source = Array.isArray(messages) ? messages : [];
  return [...source, { role: 'user', content: COMPACTION_INSTRUCTION }];
}

/**
 * Rough token estimate for a string (chars/4, rounded up). Returns 0 for
 * empty or non-string input.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}
