import { AlertCircle, RefreshCw } from 'lucide-react';
import { toHermesError, titleForHermesCode } from '@/lib/hermes-errors';
import { cn } from '@/lib/utils';

interface HermesErrorStateProps {
  /**
   * Anything a Hermes query or mutation threw, an error envelope, or a plain
   * string for a client-side message (e.g. a missing form field). Renders
   * nothing when null/undefined so callers can pass `query.error` directly.
   */
  error: unknown;
  /** Shown as Retry when the error's code says retrying could work. */
  onRetry?: () => void;
  /** Used when the thrown value carries no message of its own. */
  fallbackMessage?: string;
  /** `inline` sits inside a card row; `block` is a standalone panel notice. */
  variant?: 'block' | 'inline';
  className?: string;
}

/**
 * The one rendering of a Hermes failure in the sidebar panels (spec 6.4).
 *
 * Copy comes from the error envelope's `code` via the same table
 * `ChatErrorBanner` uses; the server message is shown under it. Retry appears
 * only when the envelope marks the error `retryable`.
 */
export function HermesErrorState({
  error,
  onRetry,
  fallbackMessage,
  variant = 'block',
  className,
}: HermesErrorStateProps) {
  if (error == null || error === false || error === '') return null;

  // A bare string is a client-side message, not a Hermes failure: show it as
  // written, with no code heading and no retry.
  const isLocalMessage = typeof error === 'string';
  const body = isLocalMessage ? null : toHermesError(error, fallbackMessage);
  const title = body ? titleForHermesCode(body.code) : null;
  const message = isLocalMessage ? (error as string) : body?.message;
  const showRetry = Boolean(onRetry && body?.retryable);

  return (
    <div
      role="alert"
      data-error-code={body?.code}
      className={cn(
        'flex items-start gap-2 border border-destructive/25 bg-destructive/10 text-destructive',
        variant === 'inline' ? 'rounded-lg px-2 py-1.5 text-[10px]' : 'rounded-xl px-2.5 py-2 text-[11px]',
        className,
      )}
    >
      <AlertCircle className={cn('mt-px shrink-0', variant === 'inline' ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden />
      <div className="min-w-0 flex-1 leading-snug">
        {title && <p className="font-medium">{title}</p>}
        {message && message !== title && (
          <p className={cn('break-words', title && 'mt-0.5 text-destructive/80')}>{message}</p>
        )}
      </div>
      {showRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/30 px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/60"
        >
          <RefreshCw className="h-2.5 w-2.5" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}
