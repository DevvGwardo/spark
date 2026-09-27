// ─── Output styles (server re-export) ────────────────────────────────────────
// Thin re-export of the shared canonical definitions so the server and the
// browser agree on the same vocabulary. The chat route uses these to append the
// active style's prompt (plus its per-turn reminder) to the system prompt.
//
// The definitions themselves live in `shared/output-styles.ts` (imported by both
// the server and the client's settings UI).

export {
  DEFAULT_OUTPUT_STYLE,
  OUTPUT_STYLES,
  OUTPUT_STYLE_IDS,
  isOutputStyle,
  resolveOutputStyle,
  getOutputStyleSpec,
  buildOutputStylePrompt,
} from '../../shared/output-styles';

export type { OutputStyle, OutputStyleSpec } from '../../shared/output-styles';
