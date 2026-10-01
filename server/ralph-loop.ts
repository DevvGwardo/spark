import { logger } from './lib/logger';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  buildRalphRoundPrompt,
  nextRalphTransition,
  parseRalphRunnerOutput,
  RALPH_MAX_HANDOFF_CHARS,
  RALPH_MAX_ROUNDS_DEFAULT,
  validateRalphReport,
  type RalphRoundRecord,
  type RalphRoundReport,
  type RalphRun,
  type RalphRunStatus,
} from './lib/ralph';

// ─── Ralph loop driver ─────────────────────────────────────────────────────
// Sequential fresh-agent loop ported from DeepSeek Harness's ralph tool.
// Each round spawns run-ralph-round.py as a brand-new subprocess (fresh
// agent, no conversation history). The workspace directory is the durable
// memory. The driver owns the state machine; shared/ralph.ts owns the rules.

const MAX_ROUNDS_CEILING = 256;
const ROUND_HARD_KILL_MS = 45 * 60 * 1000; // matches RALPH_ROUND_TIMEOUT_MS default + headroom
const SCRIPTS_DIR = (() => {
  const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts');
  if (fs.existsSync(sourceDir)) return sourceDir;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'scripts');
})();

const state: {
  runs: Map<string, RalphRun>;
  children: Map<string, ChildProcess>;
} = {
  runs: new Map(),
  children: new Map(),
};

function touch(run: RalphRun): void {
  run.updatedAt = Date.now();
}

function resolveVenvPython(): string {
  // The round runner imports hermes_adapter from hermes-bridge, which loads the
  // real agent from ~/.hermes/hermes-agent — the agent's OWN venv is the runtime
  // that actually has its dependency tree (httpx, yaml, ...). Prefer it, then
  // fall back to the bridge venvs. Paths work for both tsx (server/ralph-loop.ts
  // → repo root is one up) and the bundled Electron main (out/main → two up).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoots = [path.resolve(here, '..'), path.resolve(here, '..', '..')];
  const candidates = [
    process.env.HERMES_AGENT_VENV || path.join(process.env.HOME || '', '.hermes', 'hermes-agent', 'venv'),
    process.env.HERMES_BRIDGE_VENV,
    ...repoRoots.map((root) => path.join(root, 'hermes-bridge', '.venv')),
    ...repoRoots.map((root) => path.join(root, 'hermes-bridge', 'venv')),
  ].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    const py = path.join(candidate, 'bin', 'python3');
    if (fs.existsSync(py)) return py;
  }
  return 'python3';
}

export interface StartRalphRunInput {
  objective: string;
  maxRounds?: number;
  workspaceDir?: string;
}

export function startRalphRun(input: StartRalphRunInput): RalphRun {
  const objective = input.objective.trim();
  if (!objective) throw new Error('objective must be a non-empty string');
  const maxRounds = input.maxRounds ?? RALPH_MAX_ROUNDS_DEFAULT;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_CEILING) {
    throw new Error(`maxRounds must be a safe integer 1..${MAX_ROUNDS_CEILING}`);
  }
  const workspaceDir = path.resolve(
    input.workspaceDir || path.join('/tmp', `ralph-${randomUUID().slice(0, 8)}`),
  );
  fs.mkdirSync(workspaceDir, { recursive: true });

  const run: RalphRun = {
    id: randomUUID(),
    objective,
    workspaceDir,
    maxRounds,
    // A run is in flight until finishedAt is set; this placeholder is
    // overwritten by finishRun() on the first terminal transition. The API
    // layer reports `statusLabel` so consumers never see the raw value.
    status: 'budget-limited',
    roundsStarted: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    finalReport: null,
    lastHandoff: null,
    rounds: [],
  };
  state.runs.set(run.id, run);
  // Kick off round 1 asynchronously; API returns the run immediately.
  void runRound(run, 1).catch((err) => {
    logger.error(`[ralph] round 1 dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return run;
}

async function runRound(run: RalphRun, round: number): Promise<void> {
  if (run.finishedAt !== null) return;
  run.roundsStarted = Math.max(run.roundsStarted, round);
  const record: RalphRoundRecord = {
    round,
    status: 'continue',
    startedAt: Date.now(),
    finishedAt: null,
    summary: '',
  };
  run.rounds.push(record);
  touch(run);

  const prompt = buildRalphRoundPrompt({
    objective: run.objective,
    round,
    maxRounds: run.maxRounds,
    previous: run.lastHandoff,
    workspaceDir: run.workspaceDir,
  });

  const scriptPath = path.join(SCRIPTS_DIR, 'run-ralph-round.py');
  if (!fs.existsSync(scriptPath)) {
    finishRun(run, 'failed', null, `runner script missing: ${scriptPath}`);
    return;
  }

  const child = spawn(resolveVenvPython(), [scriptPath], {
    env: {
      ...process.env,
      // A leaked PYTHONPATH (e.g. from launching the app inside another agent's
      // environment) makes foreign site-packages shadow the runner's venv deps
      // (yaml, httpx). The runner resolves its own paths; never inherit it.
      PYTHONPATH: '',
      RALPH_ROUND_PROMPT: prompt,
      RALPH_WORKSPACE_DIR: run.workspaceDir,
      RALPH_ROUND_TIMEOUT_MS: String(ROUND_HARD_KILL_MS),
    },
    cwd: run.workspaceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  state.children.set(run.id, child);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        logger.error(`[ralph] run ${run.id} round ${round} exceeded ${ROUND_HARD_KILL_MS}ms — killing`);
        child.kill('SIGKILL');
      }
    }, ROUND_HARD_KILL_MS);
    timer.unref?.();
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', () => {
      settled = true;
      clearTimeout(timer);
      resolve(-1);
    });
  });
  state.children.delete(run.id);

  if (run.finishedAt !== null) return; // cancelled while running

  record.finishedAt = Date.now();

  if (exitCode !== 0) {
    record.status = 'blocked';
    record.summary = `round ${round} failed (exit ${exitCode})`;
    record.error = (stderr || stdout || 'unknown runner error').slice(-500);
    finishRun(run, 'round-failed', run.lastHandoff ?? null, record.error);
    return;
  }

  const parsed = parseRalphRunnerOutput(stdout);
  if (parsed.report === null) {
    record.status = 'blocked';
    record.summary = `round ${round} produced no valid report`;
    record.error = parsed.error ?? 'no report';
    finishRun(run, 'round-failed', run.lastHandoff ?? null, parsed.error);
    return;
  }

  // Defense in depth: re-validate across the process boundary even though
  // the runner structurally sanity-checked its JSON.
  let report: RalphRoundReport;
  try {
    report = validateRalphReport(parsed.report, RALPH_MAX_HANDOFF_CHARS);
  } catch (err) {
    record.status = 'blocked';
    record.summary = `round ${round} report failed validation`;
    record.error = err instanceof Error ? err.message : String(err);
    finishRun(run, 'round-failed', run.lastHandoff, record.error);
    return;
  }

  record.status = report.status;
  record.summary = report.summary;
  run.lastHandoff = report.status === 'continue' ? report : run.lastHandoff;

  const transition = nextRalphTransition(report, round, run.maxRounds);
  if (transition.runStatus !== null) {
    finishRun(run, transition.runStatus, report);
    return;
  }
  touch(run);
  await runRound(run, transition.nextRound as number);
}

function finishRun(
  run: RalphRun,
  status: RalphRunStatus,
  finalReport: RalphRoundReport | null,
  error?: string,
): void {
  if (run.finishedAt !== null) return;
  run.status = status;
  run.finalReport = finalReport;
  run.finishedAt = Date.now();
  run.updatedAt = run.finishedAt;
  if (error) run.error = error;
  logger.info(`[ralph] run ${run.id} finished: ${status} after ${run.roundsStarted} round(s)`);
}

export function cancelRalphRun(runId: string): boolean {
  const run = state.runs.get(runId);
  if (!run || run.finishedAt !== null) return false;
  const child = state.children.get(runId);
  if (child) child.kill('SIGTERM');
  finishRun(run, 'cancelled', run.lastHandoff);
  return true;
}

export function listRalphRuns(): RalphRun[] {
  return [...state.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getRalphRun(runId: string): RalphRun | undefined {
  return state.runs.get(runId);
}
