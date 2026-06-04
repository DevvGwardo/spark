import React, { useMemo } from 'react';
import { AlertTriangle, ArrowUpRight, Copy, Sparkles, TerminalSquare, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/api';
import { parseLocalProviderRuntimeError } from '@/lib/local-provider-runtime';

interface HermesCompatibilityDetails {
  currentModel: string;
  suggestions: string[];
}

interface ChatErrorBannerProps {
  message: string;
  activeProvider: string;
  activeModel: string;
  onDismiss: () => void;
  onOpenSettings: () => void;
  onSwitchModel: (model: string) => void;
}

function normalizeErrorMessage(message: string) {
  return message.replace(/^\[Error:\s*/i, '').replace(/\]$/, '').trim();
}

function isApiConnectionError(message: string) {
  const normalized = normalizeErrorMessage(message);
  return /failed after \d+ attempts\./i.test(normalized) && /cannot connect to api/i.test(normalized);
}

function formatApiConnectionMessage(message: string) {
  const normalized = normalizeErrorMessage(message);
  const withoutPrefix = normalized
    .replace(/^Failed after \d+ attempts\.\s*Last error:\s*/i, '')
    .trim();
  const trimmedDetail = withoutPrefix.replace(/\s*:\s*$/, '').trim();

  return {
    summary: 'Spark could not reach the local API server.',
    detail: trimmedDetail && !/^cannot connect to api$/i.test(trimmedDetail)
      ? trimmedDetail
      : 'The renderer lost its connection to the embedded API process, so requests never reached the provider.',
    baseUrl: getApiBaseUrl(),
  };
}

function parseHermesCompatibilityError(message: string): HermesCompatibilityDetails | null {
  const normalized = normalizeErrorMessage(message);
  const match = normalized.match(
    /Model '([^']+)' is not compatible with Hermes tool calls on OpenRouter\.\s*Choose a tool-capable model like\s+(.+)$/i,
  );

  if (!match) {
    return null;
  }

  const suggestions = match[2]
    .replace(/[.\]]+$/, '')
    .split(/\s*,\s*/)
    .map((model) => model.trim())
    .filter(Boolean);

  return {
    currentModel: match[1],
    suggestions,
  };
}

function getModelLabel(model: string) {
  return model.split('/').pop() || model;
}

function getModelSource(model: string) {
  const [source] = model.split('/');
  return source || 'provider';
}

function ErrorPill({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'warning' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]',
        tone === 'warning'
          ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-200'
          : 'border-border/60 bg-background/70 text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

export const ChatErrorBanner: React.FC<ChatErrorBannerProps> = ({
  message,
  activeProvider,
  activeModel,
  onDismiss,
  onOpenSettings,
  onSwitchModel,
}) => {
  const normalizedMessage = useMemo(() => normalizeErrorMessage(message), [message]);
  const apiConnectionDetails = useMemo(
    () => (isApiConnectionError(message) ? formatApiConnectionMessage(message) : null),
    [message],
  );
  const hermesDetails = useMemo(
    () => (activeProvider === 'hermes' ? parseHermesCompatibilityError(message) : null),
    [activeProvider, message],
  );
  const localProviderRuntime = useMemo(
    () => parseLocalProviderRuntimeError(activeProvider, message),
    [activeProvider, message],
  );

  if (localProviderRuntime) {
    return (
      <div className="mx-auto mb-3 w-full max-w-[720px]">
        <div className="relative overflow-hidden rounded-[22px] border border-border/60 bg-background/85 p-4 text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-200">
              <TerminalSquare className="h-5 w-5" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <ErrorPill tone="warning">{localProviderRuntime.badge}</ErrorPill>
                <ErrorPill>{localProviderRuntime.title}</ErrorPill>
              </div>
              <h3 className="mt-2 text-sm font-semibold tracking-tight text-foreground">
                Start the {localProviderRuntime.title.toLowerCase()}
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {localProviderRuntime.summary}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {localProviderRuntime.detail}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                  Start Command
                </span>
                <button
                  onClick={() => navigator.clipboard?.writeText(localProviderRuntime.command).catch(() => {})}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs font-mono text-foreground transition-colors duration-150 hover:bg-background"
                >
                  {localProviderRuntime.command}
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                  {localProviderRuntime.locationLabel}
                </span>
                <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground">
                  {localProviderRuntime.locationValue}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={onOpenSettings}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3.5 py-2 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-background"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Open settings
                </button>
                <span className="text-xs text-muted-foreground">
                  Start the local runtime, then resend your last message.
                </span>
              </div>
            </div>

            <button
              onClick={onDismiss}
              className="rounded-xl p-2 text-muted-foreground transition-colors duration-150 hover:bg-background/80 hover:text-foreground"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (hermesDetails) {
    return (
      <div className="mx-auto mb-3 w-full max-w-[720px]">
        <div className="relative overflow-hidden rounded-[22px] border border-border/60 bg-background/85 p-4 text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          <div className="relative">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-200">
                <Sparkles className="h-5 w-5" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <ErrorPill tone="warning">Hermes Compatibility</ErrorPill>
                  <ErrorPill>OpenRouter</ErrorPill>
                </div>
                <h3 className="mt-2 text-sm font-semibold tracking-tight text-foreground">
                  Switch to a tool-capable model
                </h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  <span className="font-medium text-foreground">{getModelLabel(hermesDetails.currentModel)}</span> cannot
                  use Hermes tool calls. Pick one of the recommended models below, then resend your last message.
                </p>
              </div>

              <button
                onClick={onDismiss}
                className="rounded-xl p-2 text-muted-foreground transition-colors duration-150 hover:bg-background/80 hover:text-foreground"
                aria-label="Dismiss error"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                Current Model
              </span>
              <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground">
                {hermesDetails.currentModel}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {hermesDetails.suggestions.map((model) => {
                const isActiveSuggestion = activeModel === model;
                return (
                  <button
                    key={model}
                    onClick={() => onSwitchModel(model)}
                    className={cn(
                      'group rounded-2xl border px-3 py-3 text-left transition-all duration-150',
                      isActiveSuggestion
                        ? 'border-border/70 bg-muted/55'
                        : 'border-border/60 bg-background/70 hover:border-foreground/20 hover:bg-background',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{getModelLabel(model)}</span>
                      <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                    </div>
                    <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80">
                      {getModelSource(model)}
                    </div>
                    <div className="mt-3 text-xs text-muted-foreground">
                      {isActiveSuggestion ? 'Already selected' : 'Switch instantly'}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                onClick={onOpenSettings}
                className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3.5 py-2 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-background"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Open Hermes settings
              </button>
              <span className="text-xs text-muted-foreground">
                Your tools stay enabled. This only swaps the active model.
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (apiConnectionDetails) {
    return (
      <div className="mx-auto mb-3 w-full max-w-[720px]">
        <div className="rounded-[22px] border border-border/60 bg-background/85 p-4 shadow-[0_10px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-destructive/15 bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4.5 w-4.5" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <ErrorPill>Local API</ErrorPill>
                <ErrorPill tone="warning">Connection failed</ErrorPill>
              </div>
              <h3 className="mt-2 text-sm font-semibold tracking-tight text-foreground">
                {apiConnectionDetails.summary}
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {apiConnectionDetails.detail}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                  Target
                </span>
                <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground">
                  {apiConnectionDetails.baseUrl}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={onOpenSettings}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3.5 py-2 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-background"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Open settings
                </button>
                <span className="text-xs text-muted-foreground">
                  Restart the app if the embedded API port changed or preload did not load.
                </span>
              </div>
            </div>

            <button
              onClick={onDismiss}
              className="rounded-xl p-2 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mb-3 w-full max-w-[720px]">
      <div className="relative overflow-hidden rounded-[22px] border border-border/60 bg-background/85 p-4 shadow-[0_10px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-destructive/15 bg-destructive/10 text-destructive">
            <AlertTriangle className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive/80">
              Provider Error
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{normalizedMessage}</p>
            <button
              onClick={onOpenSettings}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-background"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Open settings
            </button>
          </div>
          <button
            onClick={onDismiss}
            className="rounded-xl p-2 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            aria-label="Dismiss error"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
