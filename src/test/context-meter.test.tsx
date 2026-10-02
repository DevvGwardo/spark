import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextMeter } from '@/components/chat/ContextMeter';
import {
  contextMeterBarClass,
  CONTEXT_WARN_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
} from '@/lib/context-meter';
import { useContextUsageStore } from '@/stores/context-usage-store';

beforeEach(() => {
  useContextUsageStore.setState({ usage: null });
});

afterEach(() => {
  cleanup();
  useContextUsageStore.setState({ usage: null });
});

describe('contextMeterBarClass', () => {
  it('is green below 70%, amber at 70-89%, red at 90%+', () => {
    expect(contextMeterBarClass(0)).toBe('bg-emerald-500/90');
    expect(contextMeterBarClass(CONTEXT_WARN_PERCENT - 1)).toBe('bg-emerald-500/90');
    expect(contextMeterBarClass(CONTEXT_WARN_PERCENT)).toBe('bg-amber-500/90');
    expect(contextMeterBarClass(CONTEXT_CRITICAL_PERCENT - 1)).toBe('bg-amber-500/90');
    expect(contextMeterBarClass(CONTEXT_CRITICAL_PERCENT)).toBe('bg-red-500/90');
    expect(contextMeterBarClass(100)).toBe('bg-red-500/90');
  });
});

describe('ContextMeter', () => {
  it('renders nothing when no usage has been reported (zero layout shift)', () => {
    const { container } = render(<ContextMeter />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the last turn cost when the backend priced it (spec 4.5)', () => {
    useContextUsageStore.getState().setUsage({
      inputTokens: 2_000,
      outputTokens: 350,
      contextWindow: 200_000,
      model: 'claude-sonnet-4',
      costUsd: 0.00909,
    });
    const { container, getByLabelText } = render(<ContextMeter />);
    expect(container.textContent).toContain('$0.0091');
    expect(getByLabelText('Last turn cost $0.0091')).not.toBeNull();
  });

  it('shows no cost when none was reported', () => {
    useContextUsageStore.getState().setUsage({
      inputTokens: 2_000,
      outputTokens: 350,
      contextWindow: 200_000,
      model: 'm',
    });
    const { container } = render(<ContextMeter />);
    expect(container.textContent).not.toContain('$');
  });

  it('renders usage with formatted token counts', () => {
    useContextUsageStore.getState().setUsage({
      inputTokens: 30_000,
      outputTokens: 1_400,
      contextWindow: 51_200,
      model: 'gpt-5.4',
    });
    const { container } = render(<ContextMeter />);
    // 31.4k / 51.2k = 61.3% → "Context 61%"
    expect(container.textContent).toContain('Context 61%');
    expect(container.textContent).toContain('(31.4k/51.2k tokens)');
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('uses the critical bar color at 90%+ and includes cached tokens in the tooltip', () => {
    useContextUsageStore.getState().setUsage({
      inputTokens: 46_000,
      outputTokens: 80,
      cachedInputTokens: 20_000,
      contextWindow: 51_200,
      model: 'gpt-5.4',
    });
    const { container } = render(<ContextMeter />);
    // 46.08k / 51.2k = 90% → red bar
    expect(container.textContent).toContain('Context 90%');
    expect(container.querySelector('.bg-red-500\\/90')).not.toBeNull();
    expect(container.querySelector('[title*="20,000 cached input tokens"]')).not.toBeNull();
  });

  it('renders nothing for a malformed usage payload', () => {
    useContextUsageStore.getState().setUsage({
      inputTokens: 100,
      outputTokens: 100,
      contextWindow: 0,
      model: 'gpt-5.4',
    });
    const { container } = render(<ContextMeter />);
    expect(container.innerHTML).toBe('');
  });
});
