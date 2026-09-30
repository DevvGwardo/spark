// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildRalphRoundPrompt,
  nextRalphTransition,
  parseRalphRunnerOutput,
  validateRalphReport,
} from '../../shared/ralph';

const validContinue: import('../../shared/ralph').RalphRoundReport = {
  status: 'continue',
  summary: 'wrote the failing test',
  evidence: ['tests/ralph.spec.ts exists'],
  nextSteps: ['run the suite', 'fix failures'],
  blocker: '',
};

const validComplete: import('../../shared/ralph').RalphRoundReport = {
  status: 'complete',
  summary: 'all tests pass',
  evidence: ['vitest run: 8 tests passed'],
  nextSteps: [],
  blocker: '',
};

const validBlocked: import('../../shared/ralph').RalphRoundReport = {
  status: 'blocked',
  summary: 'need credentials',
  evidence: [],
  nextSteps: [],
  blocker: 'TYPESAFE_API_KEY missing from env',
};

describe('validateRalphReport', () => {
  it('accepts well-formed reports for each status', () => {
    expect(() => validateRalphReport(validContinue)).not.toThrow();
    expect(() => validateRalphReport(validComplete)).not.toThrow();
    expect(() => validateRalphReport(validBlocked)).not.toThrow();
  });

  it('rejects non-objects', () => {
    expect(() => validateRalphReport(null)).toThrow();
    expect(() => validateRalphReport('nope')).toThrow();
    expect(() => validateRalphReport([validContinue])).toThrow();
  });

  it('continue requires nextSteps and an empty blocker', () => {
    expect(() => validateRalphReport({ ...validContinue, nextSteps: [] })).toThrow(/nextSteps/);
    expect(() => validateRalphReport({ ...validContinue, blocker: 'stuck' })).toThrow(/empty blocker/);
  });

  it('complete requires evidence, no nextSteps, empty blocker', () => {
    expect(() => validateRalphReport({ ...validComplete, evidence: [] })).toThrow(/evidence/);
    expect(() => validateRalphReport({ ...validComplete, nextSteps: ['x'] })).toThrow(/complete/);
    expect(() => validateRalphReport({ ...validComplete, blocker: 'why' })).toThrow(/empty blocker/);
  });

  it('blocked requires a concrete blocker', () => {
    expect(() => validateRalphReport({ ...validBlocked, blocker: '' })).toThrow(/blocker/);
    expect(() => validateRalphReport({ ...validBlocked, blocker: '  ' })).toThrow();
  });

  it('rejects untrimmed and empty strings', () => {
    expect(() => validateRalphReport({ ...validContinue, summary: ' padded ' })).toThrow(/trimmed/);
    expect(() => validateRalphReport({ ...validContinue, evidence: ['ok', ''] })).toThrow();
  });

  it('rejects unknown status', () => {
    expect(() => validateRalphReport({ ...validContinue, status: 'vibes' })).toThrow(/status/);
  });

  it('enforces the handoff budget', () => {
    const big = { ...validContinue, summary: 'x'.repeat(20_000) };
    expect(() => validateRalphReport(big, 16_384)).toThrow(/handoff budget/);
  });
});

describe('parseRalphRunnerOutput', () => {
  it('extracts the report marker from noisy stdout', () => {
    const stdout = [
      '[ralph-runner] round start',
      '[ralph-runner] tool terminal(ls -la)',
      `RALPH_REPORT:${JSON.stringify(validComplete)}`,
      '',
    ].join('\n');
    const parsed = parseRalphRunnerOutput(stdout);
    expect(parsed.report).toEqual(validComplete);
    expect(parsed.error).toBeUndefined();
  });

  it('uses the LAST report marker when several appear', () => {
    const stdout = [
      `RALPH_REPORT:${JSON.stringify(validContinue)}`,
      `RALPH_REPORT:${JSON.stringify(validComplete)}`,
    ].join('\n');
    expect(parseRalphRunnerOutput(stdout).report).toEqual(validComplete);
  });

  it('surfaces the error marker', () => {
    const parsed = parseRalphRunnerOutput('RALPH_ERROR:adapter init failed\n');
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBe('adapter init failed');
  });

  it('fails closed when neither marker appears', () => {
    const parsed = parseRalphRunnerOutput('some log noise only');
    expect(parsed.report).toBeNull();
    expect(parsed.error).toMatch(/no report and no error marker/);
  });

  it('fails closed on an invalid report payload', () => {
    const parsed = parseRalphRunnerOutput('RALPH_REPORT:{"status":"nope"}\n');
    expect(parsed.report).toBeNull();
    expect(parsed.error).toBeDefined();
  });
});

describe('nextRalphTransition', () => {
  it('complete ends the run', () => {
    expect(nextRalphTransition(validComplete as never, 3, 10)).toEqual({
      nextRound: null,
      runStatus: 'complete',
    });
  });

  it('blocked ends the run', () => {
    expect(nextRalphTransition(validBlocked as never, 3, 10)).toEqual({
      nextRound: null,
      runStatus: 'blocked',
    });
  });

  it('continue advances until the cap', () => {
    expect(nextRalphTransition(validContinue, 3, 10)).toEqual({ nextRound: 4, runStatus: null });
    expect(nextRalphTransition(validContinue, 10, 10)).toEqual({
      nextRound: null,
      runStatus: 'budget-limited',
    });
  });
});

describe('buildRalphRoundPrompt', () => {
  it('seeds round 1 with no previous handoff', () => {
    const prompt = buildRalphRoundPrompt({
      objective: 'fix the tests',
      round: 1,
      maxRounds: 5,
      previous: null,
      workspaceDir: '/tmp/ralph-x',
    });
    expect(prompt).toContain('(none — this is the first round)');
    expect(prompt).toContain('Ralph round: 1 of 5');
    expect(prompt).toContain('/tmp/ralph-x');
    expect(prompt).toContain('fix the tests');
  });

  it('embeds the previous report JSON for later rounds', () => {
    const prompt = buildRalphRoundPrompt({
      objective: 'fix the tests',
      round: 2,
      maxRounds: 5,
      previous: validContinue,
      workspaceDir: '/tmp/ralph-x',
    });
    expect(prompt).toContain(JSON.stringify(validContinue));
    expect(prompt).toContain('Ralph round: 2 of 5');
  });

  it('instructs the RALPH_REPORT marker format', () => {
    const prompt = buildRalphRoundPrompt({
      objective: 'x',
      round: 1,
      maxRounds: 1,
      previous: null,
      workspaceDir: '/tmp/w',
    });
    expect(prompt).toContain('RALPH_REPORT:{');
  });
});
