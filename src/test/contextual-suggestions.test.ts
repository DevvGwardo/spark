import { describe, expect, it } from 'vitest';
import { generateSuggestions } from '@/lib/contextual-suggestions';

describe('generateSuggestions', () => {
  it('returns bug-fix suggestions when assistant identifies issues in a repo', () => {
    const result = generateSuggestions({
      lastAssistantContent:
        'I found several bugs in the codebase. Here are the issues I identified:\n1. Missing null check in parser.ts\n2. Race condition in the event handler',
      lastUserContent: 'Find and fix bugs',
      hasRepo: true,
      hasChanges: false,
      messageCount: 2,
    });

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some((s) => /fix/i.test(s.label))).toBe(true);
  });

  it('returns code-change suggestions when repo has pending changes', () => {
    const result = generateSuggestions({
      lastAssistantContent: 'I\'ve edited the file and updated the handler to fix the null check.',
      lastUserContent: 'Fix the bug in parser.ts',
      hasRepo: true,
      hasChanges: true,
      messageCount: 4,
    });

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some((s) => /test/i.test(s.label))).toBe(true);
    expect(result.some((s) => /commit/i.test(s.label))).toBe(true);
  });

  it('returns architecture suggestions after explanation requests', () => {
    const result = generateSuggestions({
      lastAssistantContent:
        'The codebase is organized into the following module structure:\n- server/ handles API routes\n- src/components/ contains React components',
      lastUserContent: 'Explain the codebase structure',
      hasRepo: true,
      hasChanges: false,
      messageCount: 2,
    });

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some((s) => /module|dive/i.test(s.label))).toBe(true);
  });

  it('returns test-related suggestions after test results', () => {
    const result = generateSuggestions({
      lastAssistantContent:
        'Test results: 12 passed, 3 failed. The failing tests are in the auth module. Coverage is at 65%.',
      lastUserContent: 'Run the tests',
      hasRepo: true,
      hasChanges: false,
      messageCount: 4,
    });

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some((s) => /fix.*fail|coverage/i.test(s.label))).toBe(true);
  });

  it('returns performance suggestions when performance topics are discussed', () => {
    const result = generateSuggestions({
      lastAssistantContent:
        'I found a performance bottleneck in the rendering pipeline. The component re-renders on every keystroke due to missing memoization.',
      lastUserContent: 'Why is the app slow?',
      hasRepo: true,
      hasChanges: false,
      messageCount: 2,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((s) => /optim/i.test(s.label))).toBe(true);
  });

  it('returns refactoring suggestions when refactoring is discussed', () => {
    const result = generateSuggestions({
      lastAssistantContent:
        'I suggest we refactor the auth middleware to extract the token validation into a separate module and simplify the error handling.',
      lastUserContent: 'How can we clean up the auth code?',
      hasRepo: true,
      hasChanges: false,
      messageCount: 4,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((s) => /refactor|apply/i.test(s.label))).toBe(true);
  });

  it('returns generic repo suggestions as fallback when repo is attached', () => {
    const result = generateSuggestions({
      lastAssistantContent: 'Here is some general information about the topic you asked about.',
      lastUserContent: 'Tell me about this',
      hasRepo: true,
      hasChanges: false,
      messageCount: 4,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((s) => /continue|summarize|related/i.test(s.label))).toBe(true);
  });

  it('returns generic no-repo suggestions as fallback without a repo', () => {
    const result = generateSuggestions({
      lastAssistantContent: 'React hooks allow you to use state in functional components.',
      lastUserContent: 'What are React hooks?',
      hasRepo: false,
      hasChanges: false,
      messageCount: 4,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((s) => /elaborate|approach|summarize/i.test(s.label))).toBe(true);
  });

  it('returns empty array when not enough messages', () => {
    const result = generateSuggestions({
      lastAssistantContent: 'Hello!',
      lastUserContent: 'Hi',
      hasRepo: false,
      hasChanges: false,
      messageCount: 1,
    });

    expect(result).toEqual([]);
  });

  it('limits suggestions to at most 4', () => {
    const result = generateSuggestions({
      lastAssistantContent:
        'I found bugs and issues in the codebase. Here are the problems I identified.',
      lastUserContent: 'Check for bugs',
      hasRepo: true,
      hasChanges: false,
      messageCount: 2,
    });

    expect(result.length).toBeLessThanOrEqual(4);
  });
});
