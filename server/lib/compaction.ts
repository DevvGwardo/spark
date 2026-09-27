// ─── Context compaction (server re-export) ───────────────────────────────────
// Thin re-export of the shared canonical definitions so the server and the
// browser agree on when to compact. The client evaluates the decision against
// live usage; the `/functions/v1/compact` route uses the prompts and message
// builder to produce the summary.
//
// The definitions themselves live in `shared/compaction.ts` (imported by both
// the server and the client).

export {
  DEFAULT_COMPACTION_THRESHOLD,
  MIN_COMPACTION_THRESHOLD,
  MAX_COMPACTION_THRESHOLD,
  normalizeCompactionThreshold,
  evaluateCompaction,
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_INSTRUCTION,
  buildCompactionMessages,
  estimateTokens,
} from '../../shared/compaction';

export type { CompactionInput, CompactionDecision, CompactionMessage } from '../../shared/compaction';
