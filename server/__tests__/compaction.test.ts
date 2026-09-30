// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildCompactionMessages,
  COMPACTION_INSTRUCTION,
  COMPACTION_SYSTEM_PROMPT,
  DEFAULT_COMPACTION_THRESHOLD,
  estimateTokens,
  evaluateCompaction,
  MAX_COMPACTION_THRESHOLD,
  MIN_COMPACTION_THRESHOLD,
  normalizeCompactionThreshold,
} from '../lib/compaction';

describe('compaction: constants', () => {
  it('exports the expected default/min/max thresholds', () => {
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.95);
    expect(MIN_COMPACTION_THRESHOLD).toBe(0.5);
    expect(MAX_COMPACTION_THRESHOLD).toBe(1);
  });
});

describe('compaction: normalizeCompactionThreshold', () => {
  it('returns valid numbers within range unchanged', () => {
    expect(normalizeCompactionThreshold(0.95)).toBe(0.95);
    expect(normalizeCompactionThreshold(0.5)).toBe(0.5);
    expect(normalizeCompactionThreshold(1)).toBe(1);
    expect(normalizeCompactionThreshold(0.75)).toBe(0.75);
  });

  it('accepts numeric strings', () => {
    expect(normalizeCompactionThreshold('0.9')).toBe(0.9);
    expect(normalizeCompactionThreshold('1')).toBe(1);
    expect(normalizeCompactionThreshold('0.5')).toBe(0.5);
  });

  it('clamps values below the minimum up to MIN', () => {
    expect(normalizeCompactionThreshold(0.3)).toBe(MIN_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold(0)).toBe(MIN_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold(-1)).toBe(MIN_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold('0.1')).toBe(MIN_COMPACTION_THRESHOLD);
  });

  it('clamps values above the maximum down to MAX', () => {
    expect(normalizeCompactionThreshold(1.5)).toBe(MAX_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold(2)).toBe(MAX_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold('1.2')).toBe(MAX_COMPACTION_THRESHOLD);
  });

  it('returns the default for NaN', () => {
    expect(normalizeCompactionThreshold(NaN)).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns the default for Infinity', () => {
    expect(normalizeCompactionThreshold(Infinity)).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold(-Infinity)).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns the default for undefined', () => {
    expect(normalizeCompactionThreshold(undefined)).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns the default for null', () => {
    expect(normalizeCompactionThreshold(null)).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns the default for objects', () => {
    expect(normalizeCompactionThreshold({})).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold({ threshold: 0.9 })).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold([0.9])).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns the default for empty string', () => {
    expect(normalizeCompactionThreshold('')).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold('   ')).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns the default for non-numeric strings', () => {
    expect(normalizeCompactionThreshold('abc')).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold('0.9xyz')).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns the default for booleans', () => {
    expect(normalizeCompactionThreshold(true)).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(normalizeCompactionThreshold(false)).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('never throws', () => {
    expect(() => normalizeCompactionThreshold(undefined)).not.toThrow();
    expect(() => normalizeCompactionThreshold({})).not.toThrow();
    expect(() => normalizeCompactionThreshold(NaN)).not.toThrow();
  });
});

describe('compaction: evaluateCompaction', () => {
  it('compacts when usage is at the default threshold', () => {
    const result = evaluateCompaction({ used: 950, total: 1000 });
    expect(result.shouldCompact).toBe(true);
    expect(result.percentage).toBe(0.95);
    expect(result.threshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(result.reason).toBe('threshold-reached');
  });

  it('compacts when usage is above the threshold', () => {
    const result = evaluateCompaction({ used: 980, total: 1000 });
    expect(result.shouldCompact).toBe(true);
    expect(result.percentage).toBe(0.98);
    expect(result.threshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(result.reason).toBe('threshold-reached');
  });

  it('does not compact just below the default threshold', () => {
    const result = evaluateCompaction({ used: 949, total: 1000 });
    expect(result.shouldCompact).toBe(false);
    expect(result.percentage).toBe(0.949);
    expect(result.reason).toBe('below-threshold');
  });

  it('compacts exactly at a custom threshold (>= semantics)', () => {
    const result = evaluateCompaction({ used: 900, total: 1000, threshold: 0.9 });
    expect(result.shouldCompact).toBe(true);
    expect(result.percentage).toBe(0.9);
    expect(result.threshold).toBe(0.9);
    expect(result.reason).toBe('threshold-reached');
  });

  it('does not compact just below a custom threshold', () => {
    const result = evaluateCompaction({ used: 899, total: 1000, threshold: 0.9 });
    expect(result.shouldCompact).toBe(false);
    expect(result.percentage).toBe(0.899);
    expect(result.threshold).toBe(0.9);
    expect(result.reason).toBe('below-threshold');
  });

  it('returns disabled when enabled is false, even above threshold', () => {
    const result = evaluateCompaction({ used: 990, total: 1000, enabled: false });
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(result.threshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('returns disabled when enabled is false, even with a custom threshold', () => {
    const result = evaluateCompaction({ used: 990, total: 1000, threshold: 0.5, enabled: false });
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('treats enabled undefined as enabled', () => {
    const result = evaluateCompaction({ used: 960, total: 1000 });
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toBe('threshold-reached');
  });

  it('returns no-context-window when total is zero', () => {
    const result = evaluateCompaction({ used: 500, total: 0 });
    expect(result.shouldCompact).toBe(false);
    expect(result.percentage).toBe(0);
    expect(result.reason).toBe('no-context-window');
  });

  it('returns no-context-window when total is negative', () => {
    const result = evaluateCompaction({ used: 500, total: -100 });
    expect(result.shouldCompact).toBe(false);
    expect(result.percentage).toBe(0);
    expect(result.reason).toBe('no-context-window');
  });

  it('returns no-context-window when total is NaN', () => {
    const result = evaluateCompaction({ used: 500, total: NaN });
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBe('no-context-window');
  });

  it('returns no-context-window when total is Infinity', () => {
    const result = evaluateCompaction({ used: 500, total: Infinity });
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBe('no-context-window');
  });

  it('returns no-usage when used is zero', () => {
    const result = evaluateCompaction({ used: 0, total: 1000 });
    expect(result.shouldCompact).toBe(false);
    expect(result.percentage).toBe(0);
    expect(result.reason).toBe('no-usage');
  });

  it('returns no-usage when used is negative', () => {
    const result = evaluateCompaction({ used: -50, total: 1000 });
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBe('no-usage');
  });

  it('returns no-usage when used is NaN', () => {
    const result = evaluateCompaction({ used: NaN, total: 1000 });
    expect(result.shouldCompact).toBe(false);
    expect(result.percentage).toBe(0);
    expect(result.reason).toBe('no-usage');
  });

  it('returns no-usage when used is Infinity', () => {
    const result = evaluateCompaction({ used: Infinity, total: 1000 });
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBe('no-usage');
  });

  it('prefers disabled over bad total', () => {
    const result = evaluateCompaction({ used: 500, total: 0, enabled: false });
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('prefers no-context-window over no-usage', () => {
    const result = evaluateCompaction({ used: 0, total: 0 });
    expect(result.reason).toBe('no-context-window');
  });

  it('computes percentage as used/total', () => {
    expect(evaluateCompaction({ used: 500, total: 1000 }).percentage).toBe(0.5);
    expect(evaluateCompaction({ used: 250, total: 1000 }).percentage).toBe(0.25);
    expect(evaluateCompaction({ used: 3, total: 4 }).percentage).toBe(0.75);
    expect(evaluateCompaction({ used: 1, total: 3 }).percentage).toBe(1 / 3);
  });

  it('normalizes an out-of-range threshold before comparing', () => {
    const result = evaluateCompaction({ used: 600, total: 1000, threshold: 0.3 });
    // 0.3 clamps up to 0.5; 0.6 >= 0.5 → compact
    expect(result.threshold).toBe(0.5);
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toBe('threshold-reached');
  });

  it('normalizes a threshold passed as a numeric string', () => {
    const result = evaluateCompaction({
      used: 960,
      total: 1000,
      threshold: '0.95' as unknown as number,
    });
    expect(result.threshold).toBe(0.95);
    expect(result.shouldCompact).toBe(true);
  });

  it('uses the default threshold when threshold is omitted', () => {
    const result = evaluateCompaction({ used: 500, total: 1000 });
    expect(result.threshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  it('always returns the normalized threshold in the decision', () => {
    const below = evaluateCompaction({ used: 100, total: 1000, threshold: 0.2 });
    expect(below.threshold).toBe(0.5);
    const above = evaluateCompaction({ used: 100, total: 1000, threshold: 5 });
    expect(above.threshold).toBe(1);
  });

  it('never throws on bad input values', () => {
    expect(() => evaluateCompaction({ used: NaN, total: NaN })).not.toThrow();
    expect(() => evaluateCompaction({ used: Infinity, total: -Infinity })).not.toThrow();
  });
});

describe('compaction: buildCompactionMessages', () => {
  it('appends the compaction instruction as a final user turn', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const result = buildCompactionMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION });
    expect(result[result.length - 1].role).toBe('user');
  });

  it('preserves the original messages in order', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    const result = buildCompactionMessages(messages);
    expect(result[0]).toEqual({ role: 'user', content: 'first' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'reply' });
    expect(result[2]).toEqual({ role: 'user', content: 'second' });
  });

  it('does not mutate the input array', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const snapshot = messages.map((m) => ({ ...m }));
    buildCompactionMessages(messages);
    expect(messages).toEqual(snapshot);
    expect(messages).toHaveLength(2);
  });

  it('treats non-array input as empty', () => {
    const result = buildCompactionMessages(null as unknown as never[]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION });
  });

  it('treats undefined input as empty', () => {
    const result = buildCompactionMessages(undefined as unknown as never[]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION });
  });

  it('works with an empty array', () => {
    const result = buildCompactionMessages([]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION });
  });
});

describe('compaction: estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(8))).toBe(2);
    expect(estimateTokens('a'.repeat(12))).toBe(3);
    expect(estimateTokens('a'.repeat(13))).toBe(4);
  });

  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for non-string input', () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
    expect(estimateTokens(123 as unknown as string)).toBe(0);
    expect(estimateTokens({ length: 100 } as unknown as string)).toBe(0);
    expect(estimateTokens([] as unknown as string)).toBe(0);
  });

  it('never throws', () => {
    expect(() => estimateTokens(null as unknown as string)).not.toThrow();
    expect(() => estimateTokens({} as unknown as string)).not.toThrow();
  });
});

describe('compaction: prompts', () => {
  it('COMPACTION_SYSTEM_PROMPT instructs preserving file paths and identifiers verbatim', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/file path/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/verbatim/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/function name/i);
  });

  it('COMPACTION_SYSTEM_PROMPT mentions commands and versions', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/command/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/version/i);
  });

  it('COMPACTION_SYSTEM_PROMPT instructs omitting chit-chat', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/chit-chat/i);
  });

  it('COMPACTION_SYSTEM_PROMPT instructs replying with only the summary', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/only the summary/i);
  });

  it('COMPACTION_SYSTEM_PROMPT mentions the goal, decisions, state, outstanding, and conventions', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/goal/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/decision/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/current state/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/outstanding/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/convention/i);
  });

  it('COMPACTION_SYSTEM_PROMPT is a non-empty string', () => {
    expect(typeof COMPACTION_SYSTEM_PROMPT).toBe('string');
    expect(COMPACTION_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('COMPACTION_INSTRUCTION is a non-empty string', () => {
    expect(typeof COMPACTION_INSTRUCTION).toBe('string');
    expect(COMPACTION_INSTRUCTION.length).toBeGreaterThan(0);
  });
});
