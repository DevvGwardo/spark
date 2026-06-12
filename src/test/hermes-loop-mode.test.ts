import { describe, it, expect } from 'vitest';
import { isHermesLoopStatusData } from '@/hooks/chat-utils';
import { useHermesStore } from '@/stores/hermes-store';
import { parseLoopJudgeVerdict } from '../../server/lib/hermes';

describe('hermes loop mode', () => {
  it('guards hermes_loop_status data parts', () => {
    expect(
      isHermesLoopStatusData({ type: 'hermes_loop_status', status: { phase: 'agent', iteration: 1, maxIterations: 5 } }),
    ).toBe(true);
    expect(isHermesLoopStatusData({ type: 'agent_status', status: { label: 'x' } })).toBe(false);
    expect(isHermesLoopStatusData({ type: 'hermes_loop_status' })).toBe(false);
    expect(isHermesLoopStatusData(null)).toBe(false);
  });

  it('toggles loop mode and resets status on disable', () => {
    const store = useHermesStore.getState();
    store.setLoopEnabled('panel-a', true);
    store.setLoopConfig('panel-a', { maxIterations: 3, timeBudgetMinutes: 10 });
    store.setLoopStatus('panel-a', { phase: 'agent', iteration: 2 });

    let loop = useHermesStore.getState().getLoop('panel-a');
    expect(loop.enabled).toBe(true);
    expect(loop.config).toEqual({ maxIterations: 3, timeBudgetMinutes: 10 });
    expect(loop.phase).toBe('agent');
    expect(loop.iteration).toBe(2);

    store.setLoopEnabled('panel-a', false);
    loop = useHermesStore.getState().getLoop('panel-a');
    expect(loop.enabled).toBe(false);
    expect(loop.phase).toBe('idle');
    expect(loop.iteration).toBe(0);
    // Config is preserved across toggles.
    expect(loop.config).toEqual({ maxIterations: 3, timeBudgetMinutes: 10 });
  });

  it('keeps loop state independent per panel', () => {
    const store = useHermesStore.getState();
    store.setLoopEnabled('panel-1', true);
    store.setLoopEnabled('panel-2', true);
    store.setLoopStatus('panel-2', { phase: 'judge', iteration: 4 });

    // Disabling one panel's loop must not touch another's.
    store.setLoopEnabled('panel-1', false);

    expect(useHermesStore.getState().getLoop('panel-1').enabled).toBe(false);
    const other = useHermesStore.getState().getLoop('panel-2');
    expect(other.enabled).toBe(true);
    expect(other.phase).toBe('judge');
    expect(other.iteration).toBe(4);

    // Unknown panels fall back to the default (disabled) state.
    expect(useHermesStore.getState().getLoop('panel-3').enabled).toBe(false);
  });

  describe('parseLoopJudgeVerdict', () => {
    it('parses a bare JSON verdict', () => {
      expect(parseLoopJudgeVerdict('{"met": true, "feedback": ""}')).toEqual({ met: true, feedback: '' });
    });

    it('parses a verdict wrapped in <think> reasoning', () => {
      expect(
        parseLoopJudgeVerdict('<think>The agent {clearly} did partial work.</think>\n{"met": false, "feedback": "tests missing"}'),
      ).toEqual({ met: false, feedback: 'tests missing' });
    });

    it('parses a verdict inside a markdown code fence with prose', () => {
      expect(
        parseLoopJudgeVerdict('Here is my verdict:\n```json\n{"met": false, "feedback": "build fails"}\n```'),
      ).toEqual({ met: false, feedback: 'build fails' });
    });

    it('skips invalid JSON candidates and finds a later valid one', () => {
      expect(
        parseLoopJudgeVerdict('{not json} then {"met": true, "feedback": "done"}'),
      ).toEqual({ met: true, feedback: 'done' });
    });

    it('returns null for unparsable output', () => {
      expect(parseLoopJudgeVerdict('no verdict here')).toBeNull();
      expect(parseLoopJudgeVerdict('')).toBeNull();
      expect(parseLoopJudgeVerdict('{"feedback": "missing met"}')).toBeNull();
    });
  });
});
