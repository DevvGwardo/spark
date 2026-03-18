/**
 * Generates contextual follow-up suggestions based on the last assistant
 * response and overall conversation context.
 */

export interface ContextualSuggestion {
  label: string;
  prompt: string;
}

interface SuggestionContext {
  lastAssistantContent: string;
  lastUserContent: string;
  hasRepo: boolean;
  hasChanges: boolean;
  messageCount: number;
}

// Pattern matchers — order matters; first match wins for each category.
const PATTERNS: Array<{
  test: (ctx: SuggestionContext) => boolean;
  suggestions: ContextualSuggestion[];
}> = [
  // After bug/issue analysis
  {
    test: (ctx) =>
      /\b(bugs?|issues?|errors?|problems?|vulnerabilit(?:y|ies)|warnings?|flaws?)\b/i.test(ctx.lastAssistantContent) &&
      /\b(found|identified|detected|spotted|noticed|here are|the following)\b/i.test(ctx.lastAssistantContent) &&
      ctx.hasRepo,
    suggestions: [
      { label: 'Fix these issues', prompt: 'Fix all the issues you identified. Apply the changes to the repo files directly.' },
      { label: 'Prioritize by severity', prompt: 'Rank these issues by severity and fix the most critical ones first. Apply the fixes directly.' },
      { label: 'Explain the root causes', prompt: 'Explain the root cause of each issue in more detail.' },
      { label: 'Add tests for these', prompt: 'Add tests that would catch these issues and prevent regressions. Create the test files directly.' },
    ],
  },
  // After code explanation / architecture overview
  {
    test: (ctx) =>
      /\b(structure|architecture|module|component|directory|folder|organized|layout)\b/i.test(ctx.lastAssistantContent) &&
      /\b(explain|overview|summary|breakdown|walkthrough)\b/i.test(ctx.lastUserContent),
    suggestions: [
      { label: 'Deep dive on a module', prompt: 'Pick the most complex module and give me a detailed walkthrough of how it works internally.' },
      { label: 'Find improvement areas', prompt: 'Based on this architecture, what areas could be improved or refactored?' },
      { label: 'Generate documentation', prompt: 'Generate developer documentation for the key modules and their interfaces.' },
      { label: 'Map the dependencies', prompt: 'Map out the dependency graph between the main modules.' },
    ],
  },
  // After code was written/edited (repo changes)
  {
    test: (ctx) =>
      ctx.hasChanges &&
      /\b(created|edited|updated|modified|wrote|added|changed|implemented)\b/i.test(ctx.lastAssistantContent),
    suggestions: [
      { label: 'Add tests', prompt: 'Write comprehensive tests for the changes you just made.' },
      { label: 'Review the changes', prompt: 'Review all the changes for potential issues, edge cases, or improvements.' },
      { label: 'Commit these changes', prompt: 'Summarize the changes and prepare them for commit.' },
      { label: 'Refactor further', prompt: 'Look for opportunities to refactor or clean up the code you just wrote.' },
    ],
  },
  // After test results
  {
    test: (ctx) =>
      /\b(test|spec|assertion|expect|passed|failed|coverage)\b/i.test(ctx.lastAssistantContent) &&
      /\b(tests?\b|specs?\b|test suite)\b/i.test(ctx.lastUserContent),
    suggestions: [
      { label: 'Fix failing tests', prompt: 'Fix any failing tests and ensure they all pass.' },
      { label: 'Improve coverage', prompt: 'Identify gaps in test coverage and add tests for uncovered code paths.' },
      { label: 'Add edge case tests', prompt: 'Add tests for edge cases, error conditions, and boundary values.' },
      { label: 'Refactor test setup', prompt: 'Refactor the test setup to reduce duplication and improve maintainability.' },
    ],
  },
  // After performance analysis
  {
    test: (ctx) =>
      /\b(performance|bottleneck|slow|latency|optimization|memory|render|bundle)\b/i.test(ctx.lastAssistantContent),
    suggestions: [
      { label: 'Apply optimizations', prompt: 'Apply the performance optimizations you suggested.' },
      { label: 'Benchmark before/after', prompt: 'Set up benchmarks to measure the impact of these optimizations.' },
      { label: 'Profile deeper', prompt: 'Do a deeper profiling analysis focusing on the most impactful bottleneck.' },
    ],
  },
  // After refactoring suggestions
  {
    test: (ctx) =>
      /\b(refactor|clean.?up|simplif|extract|consolidat|restructur)\b/i.test(ctx.lastAssistantContent),
    suggestions: [
      { label: 'Apply the refactoring', prompt: 'Go ahead and apply the refactoring changes you suggested.' },
      { label: 'Do it incrementally', prompt: 'Apply the refactoring in small, incremental steps. Start with the lowest-risk change.' },
      { label: 'Check for regressions', prompt: 'After refactoring, verify nothing is broken by running or writing tests.' },
    ],
  },
  // Generic repo-attached fallback
  {
    test: (ctx) => ctx.hasRepo && ctx.messageCount >= 2,
    suggestions: [
      { label: 'Continue working', prompt: 'Continue with the next logical step based on what we just discussed.' },
      { label: 'Find related issues', prompt: 'Look for other related issues or improvements in the same area of the codebase.' },
      { label: 'Summarize progress', prompt: 'Summarize what we\'ve done so far and what\'s left to do.' },
    ],
  },
  // Generic no-repo fallback
  {
    test: (ctx) => ctx.messageCount >= 2,
    suggestions: [
      { label: 'Elaborate on this', prompt: 'Elaborate on the key points with more detail and examples.' },
      { label: 'Try a different approach', prompt: 'Can you suggest an alternative approach to this?' },
      { label: 'Summarize so far', prompt: 'Give me a concise summary of everything we\'ve covered.' },
    ],
  },
];

const COMMIT_SUGGESTION: ContextualSuggestion = {
  label: 'Commit these changes',
  prompt: 'Summarize the changes and prepare them for commit.',
};

export function generateSuggestions(ctx: SuggestionContext): ContextualSuggestion[] {
  for (const pattern of PATTERNS) {
    if (pattern.test(ctx)) {
      let suggestions = pattern.suggestions.slice(0, 4);
      // Inject "Commit these changes" when there are pending changes,
      // replacing the last suggestion to keep the count at 4.
      if (ctx.hasChanges && !suggestions.some((s) => /commit/i.test(s.label))) {
        suggestions = [...suggestions.slice(0, 3), COMMIT_SUGGESTION];
      }
      return suggestions;
    }
  }
  return [];
}
