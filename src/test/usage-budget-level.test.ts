import { describe, expect, it } from 'vitest';
import { usageBudgetLevel } from '@/components/sidebar/hermesSidebarUtils';

describe('usageBudgetLevel', () => {
  it('returns ok below 75% of budget (including 0%)', () => {
    expect(usageBudgetLevel(0, 100)).toBe('ok');
    expect(usageBudgetLevel(74.99, 100)).toBe('ok');
  });

  it('returns warn at the 75% threshold and up to (but not at) 100%', () => {
    expect(usageBudgetLevel(75, 100)).toBe('warn');
    expect(usageBudgetLevel(99.99, 100)).toBe('warn');
  });

  it('returns over at the 100% threshold and beyond', () => {
    expect(usageBudgetLevel(100, 100)).toBe('over');
    expect(usageBudgetLevel(250, 100)).toBe('over');
  });

  it('treats a zero, negative, or missing budget as ok', () => {
    expect(usageBudgetLevel(40, 0)).toBe('ok');
    expect(usageBudgetLevel(40, -10)).toBe('ok');
    expect(usageBudgetLevel(40, Number.NaN)).toBe('ok');
  });
});
