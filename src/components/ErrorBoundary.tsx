import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /**
   * For boundaries around modals and overlays: show the error as a centered
   * dialog over the app instead of in document flow (where it would push the
   * whole shell down), and offer Close as well as Reload.
   */
  overlay?: boolean;
  /** Closes whatever crashed (e.g. the modal's open flag) so Close can recover without a reload. */
  onDismiss?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      const { overlay, onDismiss } = this.props;
      const body = (
        <div
          className={cn(
            'flex flex-col items-center justify-center p-8 text-center',
            overlay ? 'w-[min(420px,calc(100vw-32px))] rounded-xl border border-border bg-popover shadow-2xl' : 'min-h-[200px]',
          )}
          role={overlay ? 'alertdialog' : 'alert'}
          aria-modal={overlay || undefined}
          aria-labelledby="error-boundary-title"
        >
          <AlertTriangle className="mb-3 h-8 w-8 text-amber-500 dark:text-amber-400" aria-hidden />
          <p id="error-boundary-title" className="mb-2 text-sm text-foreground">Something went wrong</p>
          <p className="mb-4 max-w-md break-words text-xs text-muted-foreground">
            {this.state.error.message || 'An unexpected error occurred'}
          </p>
          <div className="flex items-center gap-2">
            {overlay && onDismiss && (
              <button
                autoFocus
                onClick={() => {
                  onDismiss();
                  this.setState({ error: null });
                }}
                className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.05]"
              >
                Close
              </button>
            )}
            <button
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
              className="inline-flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/80"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </button>
          </div>
        </div>
      );
      if (!overlay) return body;
      return (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/50"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onDismiss) {
              onDismiss();
              this.setState({ error: null });
            }
          }}
        >
          {body}
        </div>
      );
    }

    return this.props.children;
  }
}
