// Thin re-export shim (repo pattern: server/lib -> shared). The Ralph loop
// rules live in shared/ralph.ts so the renderer and the server import the
// exact same contract.
export {
  RALPH_MAX_ROUNDS_DEFAULT,
  RALPH_MAX_HANDOFF_CHARS,
  validateRalphReport,
  parseRalphRunnerOutput,
  buildRalphRoundPrompt,
  nextRalphTransition,
} from '../../shared/ralph';

export type {
  RalphRoundStatus,
  RalphRunStatus,
  RalphRoundReport,
  RalphRoundRecord,
  RalphRun,
  RalphRoundResult,
} from '../../shared/ralph';
