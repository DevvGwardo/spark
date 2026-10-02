import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const Boom = () => {
  throw new Error('modal exploded');
};

/** A modal whose open flag the boundary's onDismiss clears, like AppLayout's overlays. */
const Harness = () => {
  const [open, setOpen] = useState(true);
  return (
    <ErrorBoundary overlay onDismiss={() => setOpen(false)}>
      {open ? <Boom /> : <p>modal closed</p>}
    </ErrorBoundary>
  );
};

// jsdom reports every caught render error as an uncaught window error; the
// boundary handles them, so keep them out of the test output.
const swallow = (e: ErrorEvent) => e.preventDefault();

describe('ErrorBoundary overlay mode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', swallow);
  });

  afterEach(() => {
    window.removeEventListener('error', swallow);
    vi.restoreAllMocks();
  });

  it('renders a fixed dialog instead of an in-flow block', () => {
    render(<Harness />);
    const dialog = screen.getByRole('alertdialog', { name: 'Something went wrong' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toHaveClass('fixed', 'inset-0');
    expect(screen.getByText('modal exploded')).toBeInTheDocument();
  });

  it('Close dismisses the crashed overlay and recovers without a reload', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('modal closed')).toBeInTheDocument();
  });

  it('Escape dismisses too', () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.getByText('modal closed')).toBeInTheDocument();
  });

  it('offers only Reload when nothing can be dismissed', () => {
    render(<ErrorBoundary overlay><Boom /></ErrorBoundary>);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('keeps the inline fallback when overlay is off', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('min-h-[200px]');
    expect(alert.parentElement).not.toHaveClass('fixed');
  });
});
