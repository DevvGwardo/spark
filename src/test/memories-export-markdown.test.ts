import { describe, expect, it } from 'vitest';
import { memoriesToMarkdown } from '@/components/sidebar/hermesSidebarUtils';

describe('memoriesToMarkdown', () => {
  it('emits a markdown heading and body for each memory', () => {
    const md = memoriesToMarkdown([
      { label: 'soul.md', content: 'Be helpful and precise.' },
      { label: 'user.md', content: 'Prefers terse answers.' },
    ]);
    expect(md).toContain('## soul.md');
    expect(md).toContain('Be helpful and precise.');
    expect(md).toContain('## user.md');
    expect(md).toContain('Prefers terse answers.');
    // One section per memory.
    expect(md.match(/^## /gm)).toHaveLength(2);
  });

  it('trims surrounding whitespace in each memory body', () => {
    const md = memoriesToMarkdown([{ label: 'memory.md', content: '\n\n  remembered fact  \n\n' }]);
    expect(md).toContain('## memory.md\n\nremembered fact\n');
  });

  it('returns an empty-state string (not a throw) for an empty list', () => {
    const md = memoriesToMarkdown([]);
    expect(typeof md).toBe('string');
    expect(md).toContain('# Hermes Memories');
    expect(md).toContain('No memories to export');
    expect(md.match(/^## /gm)).toBeNull();
  });
});
