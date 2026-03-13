import { describe, expect, it } from 'vitest';
import { getRepoTurnIntentInstruction, isRepoEditIntentMessage } from '@/lib/repo-intent';

describe('repo intent helpers', () => {
  it('treats explicit repository modification requests as edit intent', () => {
    expect(isRepoEditIntentMessage('Fix the login bug and update the tests.')).toBe(true);
    expect(isRepoEditIntentMessage('Go ahead and apply the changes.')).toBe(true);
  });

  it('keeps descriptive repository questions read-only', () => {
    expect(isRepoEditIntentMessage('What is this repo?')).toBe(false);
    expect(isRepoEditIntentMessage('Review this repository and tell me how it works.')).toBe(false);
  });

  it('renders an explicit read-only instruction for analysis turns', () => {
    expect(getRepoTurnIntentInstruction(false)).toContain('read-only repository help');
    expect(getRepoTurnIntentInstruction(true)).toContain('repository changes');
  });
});
