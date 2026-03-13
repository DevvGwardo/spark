import { describe, expect, it } from 'vitest';
import { getChangeLineDelta } from '@/lib/change-diff';

describe('getChangeLineDelta', () => {
  it('counts replacements as both added and removed lines', () => {
    expect(
      getChangeLineDelta({
        action: 'edit',
        originalContent: ['alpha', 'beta', 'gamma'].join('\n'),
        content: ['alpha', 'beta updated', 'gamma updated'].join('\n'),
      }),
    ).toEqual({ added: 2, removed: 2 });
  });

  it('keeps unchanged shared lines out of the totals', () => {
    expect(
      getChangeLineDelta({
        action: 'edit',
        originalContent: ['shared', 'remove me', 'tail'].join('\n'),
        content: ['shared', 'add me', 'tail'].join('\n'),
      }),
    ).toEqual({ added: 1, removed: 1 });
  });
});
