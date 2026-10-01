import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HermesErrorState } from '@/components/hermes/HermesErrorState';
import { HermesApiError } from '@/lib/hermes-api';
import { HERMES_CODE_TITLES, toHermesError } from '@/lib/hermes-errors';

function envelope(code: string, message: string, retryable: boolean) {
  return { error: { code, message, retryable } };
}

describe('HermesErrorState', () => {
  it('renders nothing without an error', () => {
    const { container } = render(<HermesErrorState error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders code-aware copy from an enveloped HermesApiError, with Retry when retryable', () => {
    const onRetry = vi.fn();
    const err = new HermesApiError('Bridge is restarting', 503, envelope('BRIDGE_STARTING', 'Bridge is restarting', true));
    render(<HermesErrorState error={err} onRetry={onRetry} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-error-code', 'BRIDGE_STARTING');
    expect(alert).toHaveTextContent(HERMES_CODE_TITLES.BRIDGE_STARTING);
    expect(alert).toHaveTextContent('Bridge is restarting');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides Retry when the envelope says retrying will not help', () => {
    const err = new HermesApiError('bad input', 400, envelope('VALIDATION', 'name is required', false));
    render(<HermesErrorState error={err} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(HERMES_CODE_TITLES.VALIDATION);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('accepts a bare envelope', () => {
    render(<HermesErrorState error={envelope('UPSTREAM_TIMEOUT', 'took too long', true)} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(HERMES_CODE_TITLES.UPSTREAM_TIMEOUT);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows a client-side string as written, with no heading or retry', () => {
    render(<HermesErrorState error="Project name required" onRetry={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Project name required');
    expect(alert).not.toHaveAttribute('data-error-code');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe('toHermesError', () => {
  it('maps a legacy { error: string } response by status', () => {
    expect(toHermesError(new HermesApiError('Bridge down', 503))).toEqual({
      code: 'BRIDGE_UNREACHABLE',
      message: 'Bridge down',
      retryable: true,
    });
    expect(toHermesError(new HermesApiError('nope', 401)).code).toBe('BRIDGE_AUTH');
    expect(toHermesError(new HermesApiError('bad', 422))).toMatchObject({ code: 'VALIDATION', retryable: false });
  });

  it('classifies network failures and timeouts as retryable', () => {
    expect(toHermesError(new TypeError('Failed to fetch'))).toMatchObject({ code: 'BRIDGE_UNREACHABLE', retryable: true });
    const timeout = new Error('signal timed out');
    timeout.name = 'TimeoutError';
    expect(toHermesError(timeout)).toMatchObject({ code: 'UPSTREAM_TIMEOUT', retryable: true });
  });

  it('falls back to INTERNAL with the provided message', () => {
    expect(toHermesError(undefined, 'Failed to load usage')).toEqual({
      code: 'INTERNAL',
      message: 'Failed to load usage',
      retryable: false,
    });
  });
});
