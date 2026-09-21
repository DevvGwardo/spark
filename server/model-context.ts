// ─── Per-model context window lookup (server) ────────────────────────────────
// Thin wrapper over the shared canonical table so the server and the browser
// resolve the SAME window for a given model. Used to enrich the `usage` event
// emitted at the end of every chat stream:
// {type:"usage", input_tokens, output_tokens, cached_input_tokens,
//  context_window, model}.
//
// The table itself lives in `shared/model-context.ts` (imported by both the
// server and `src/lib/tokens.ts`).

import { resolveModelContextWindow } from '../shared/model-context';

/** Fallback context window when a model is not in the table. */
export { DEFAULT_MODEL_CONTEXT_WINDOW } from '../shared/model-context';

/** Best-effort per-model context window (in tokens). */
export function getModelContextWindow(modelName: string): number {
  return resolveModelContextWindow(modelName);
}
