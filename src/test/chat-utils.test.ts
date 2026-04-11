import { describe, expect, it } from 'vitest';
import { formatMissingRepoFileError } from '@/hooks/chat-utils';

describe('chat-utils repo path recovery', () => {
  it('prefers examples from the same top-level area for missing repo paths', () => {
    const message = formatMissingRepoFileError('server/agent-loop.ts', [
      'README.md',
      'server/src/index.ts',
      'server/src/routes/cards.ts',
      'server/src/routes/metrics.ts',
    ]);

    expect(message).toContain('server/src/index.ts');
    expect(message).toContain('server/src/routes/cards.ts');
    expect(message).not.toContain('- README.md');
  });

  it('surfaces exact nested matches for guessed directory-like paths', () => {
    const message = formatMissingRepoFileError('server/routes', [
      'README.md',
      'server/src/index.ts',
      'server/src/routes/cards.ts',
      'server/src/routes/metrics.ts',
    ]);

    expect(message).toContain('Possible matches:');
    expect(message).toContain('server/src/routes/cards.ts');
  });
});
