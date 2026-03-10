import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextUsageBar } from '@/components/chat/ContextUsageBar';

describe('ContextUsageBar', () => {
  it('shows a compact percentage ring with the rounded context usage', () => {
    render(
      <ContextUsageBar
        model="moonshot-v1-8k"
        messages={[{ role: 'user', content: 'abcd'.repeat(1000) }]}
      />
    );

    expect(screen.getByText('13%')).toBeInTheDocument();
    expect(screen.getByLabelText(/13% of context used/i)).toBeInTheDocument();
  });
});
