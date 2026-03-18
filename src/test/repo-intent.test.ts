import { describe, expect, it } from 'vitest';
import {
  getRepoTurnIntentInstruction,
  isRepoApprovalFollowUpMessage,
  isRepoEditIntentMessage,
  isRepoWriteMessage,
} from '@/lib/repo-intent';

describe('repo intent helpers', () => {
  it('treats explicit repository modification requests as edit intent', () => {
    expect(isRepoEditIntentMessage('Fix the login bug and update the tests.')).toBe(true);
    expect(isRepoEditIntentMessage('Go ahead and apply the changes.')).toBe(true);
  });

  it('keeps descriptive repository questions read-only', () => {
    expect(isRepoEditIntentMessage('What is this repo?')).toBe(false);
    expect(isRepoEditIntentMessage('Review this repository and tell me how it works.')).toBe(false);
  });

  it('keeps explain-only issue prompts read-only even when they mention fixes and changes', () => {
    expect(isRepoEditIntentMessage([
      'Explain GitHub issue #45503 in openclaw/openclaw.',
      'Issue title: Fix auth profile order reversion',
      'The user wants an explanation only, not a fix or implementation plan.',
      'Do not propose patches, implementation steps, or next actions unless the user explicitly asks for them.',
      'Do not make any code changes.',
    ].join('\n'))).toBe(false);
  });

  it('renders an explicit read-only instruction for analysis turns', () => {
    expect(getRepoTurnIntentInstruction(false)).toContain('read-only repository help');
    expect(getRepoTurnIntentInstruction(true)).toContain('repository changes');
  });

  it('treats approval follow-ups as write-authorized continuations', () => {
    expect(isRepoApprovalFollowUpMessage('yes')).toBe(true);
    expect(isRepoApprovalFollowUpMessage('continue with the plan')).toBe(true);
    expect(isRepoWriteMessage('approve')).toBe(true);
    expect(isRepoWriteMessage('analyze the repo and suggest fixes')).toBe(false);
  });

  it('treats "write tests" and similar phrasing as edit intent', () => {
    expect(isRepoEditIntentMessage('Write tests that would catch these issues')).toBe(true);
    expect(isRepoEditIntentMessage('Write comprehensive unit tests for the auth module')).toBe(true);
    expect(isRepoEditIntentMessage('Add tests for the new component')).toBe(true);
  });
});
