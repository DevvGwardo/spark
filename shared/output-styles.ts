// ─── Output styles ─────────────────────────────────────────────────────────
// The four [CC] output styles: Default, Explanatory, Concise, Learning.
// Each non-default style contributes a system-prompt fragment plus a
// per-turn reminder that is re-injected every turn to keep the model in style.

export type OutputStyle = 'default' | 'explanatory' | 'concise' | 'learning';

export interface OutputStyleSpec {
  id: OutputStyle;
  /** e.g. 'Concise' */
  label: string;
  /** One sentence for a settings UI. */
  description: string;
  /** System-prompt fragment, null for 'default'. */
  prompt: string | null;
  /** One short sentence re-injected each turn, null for 'default'. */
  turnReminder: string | null;
}

const DEFAULT_STYLE: OutputStyle = 'default';

const OUTPUT_STYLE_SPECS: OutputStyleSpec[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Balanced responses with no special formatting constraints.',
    prompt: null,
    turnReminder: null,
  },
  {
    id: 'explanatory',
    label: 'Explanatory',
    description: 'Teaches while it works, surfacing reasoning behind non-obvious decisions.',
    prompt:
      'When you take an action, briefly explain what you are doing and why, so the user ' +
      'can follow along and learn. Surface the reasoning behind non-obvious decisions, and ' +
      'call out patterns, conventions, or trade-offs worth learning. Do not bloat the answer: ' +
      'keep explanations tight and tied to the actual work, and never restate the user\u2019s request ' +
      'back to them.',
    turnReminder:
      'Explain what you are doing and why as you work, surfacing reasoning for non-obvious decisions.',
  },
  {
    id: 'concise',
    label: 'Concise',
    description: 'Responds tersely, leading with results and skipping preamble and narration.',
    prompt:
      'Respond tersely. Lead with the result; skip preamble, narration, and summaries of what ' +
      'you just did. No filler openers or closers. If an action succeeded, say so in as few words ' +
      'as suffice; only elaborate when the result is non-obvious or failed.',
    turnReminder:
      'Lead with the result; skip preamble and narration of your process.',
  },
  {
    id: 'learning',
    label: 'Learning',
    description: 'Does the bulk of the work but leaves small marked TODOs for the user to implement.',
    prompt:
      'Do the bulk of the work yourself, but deliberately leave a small number of clearly marked ' +
      'pieces for the user to implement. Mark each such piece with a TODO comment (2\u20135 lines) ' +
      'that names what is left and gives a one-line hint, and explicitly invite the user to try ' +
      'implementing it. Never leave the core logic unfinished; only hand off small, self-contained, ' +
      'instructive gaps.',
    turnReminder:
      'Leave clearly-marked TODOs for the user and invite them to try those small pieces themselves.',
  },
];

/**
 * Stable, canonical order for UIs and serialization:
 * default, explanatory, concise, learning.
 */
export const OUTPUT_STYLE_IDS: OutputStyle[] = OUTPUT_STYLE_SPECS.map((s) => s.id);

export const OUTPUT_STYLES: Record<OutputStyle, OutputStyleSpec> =
  Object.fromEntries(OUTPUT_STYLE_SPECS.map((s) => [s.id, s])) as Record<
    OutputStyle,
    OutputStyleSpec
  >;

export const DEFAULT_OUTPUT_STYLE: OutputStyle = DEFAULT_STYLE;

const VALID_STYLE_IDS = new Set<OutputStyle>(OUTPUT_STYLE_IDS);

/** Type guard: true when `value` is one of the known OutputStyle ids. */
export function isOutputStyle(value: unknown): value is OutputStyle {
  return typeof value === 'string' && VALID_STYLE_IDS.has(value as OutputStyle);
}

/**
 * Resolve an arbitrary value to a valid OutputStyle, falling back to
 * DEFAULT_OUTPUT_STYLE when the value is not a known style. Never throws.
 */
export function resolveOutputStyle(value: unknown): OutputStyle {
  return isOutputStyle(value) ? value : DEFAULT_OUTPUT_STYLE;
}

/** Look up the full spec for a style. Throws only on a genuine programming error. */
export function getOutputStyleSpec(style: OutputStyle): OutputStyleSpec {
  return OUTPUT_STYLES[style];
}

/**
 * Compose the full style block for the system prompt: the style's `prompt`
 * followed by its `turnReminder`, separated by a blank line. Returns null for
 * 'default' (no block). Never returns an empty string.
 */
export function buildOutputStylePrompt(style: OutputStyle): string | null {
  const spec = OUTPUT_STYLES[style];
  if (!spec.prompt || !spec.turnReminder) {
    return null;
  }
  return `${spec.prompt}\n\n${spec.turnReminder}`;
}
