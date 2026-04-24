import { describe, expect, it } from 'vitest';
import { tagColor } from '@/lib/tag-color';

describe('tagColor', () => {
  it('returns the same color for the same tag across calls', () => {
    const a = tagColor('prod');
    const b = tagColor('prod');
    expect(a).toEqual(b);
  });

  it('normalizes tags so casing/whitespace do not change the palette entry', () => {
    expect(tagColor('Prod')).toEqual(tagColor('prod'));
    expect(tagColor('  prod  ')).toEqual(tagColor('prod'));
  });

  it('spreads different tags across the palette (mostly)', () => {
    const tags = ['prod', 'scratch', 'demo', 'spike', 'chore', 'bug', 'exp', 'infra'];
    const colors = new Set(tags.map((t) => tagColor(t).bg));
    // With an 8-color palette and 8 distinct tags, a good hash should land on
    // at least half the palette.
    expect(colors.size).toBeGreaterThanOrEqual(4);
  });

  it('always returns a TagColor with bg/fg/ring strings', () => {
    const c = tagColor('anything');
    expect(typeof c.bg).toBe('string');
    expect(typeof c.fg).toBe('string');
    expect(typeof c.ring).toBe('string');
  });
});
