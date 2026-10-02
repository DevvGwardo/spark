import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openExternalUrl } from '@/lib/open-external';
import { nubApi, type NubKey, type NubLinkStart, type NubStatus } from '@/lib/nub-api';
import { useSettingsStore } from '@/stores/settings-store';

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed-out'; note?: string }
  | { kind: 'waiting'; link: NubLinkStart; note: string }
  | { kind: 'linked'; status: Extract<NubStatus, { linked: true }> };

interface NubSignInProps {
  /** Called once a model key is stored (the setup wizard advances on it). */
  onLinked?: () => void;
  /** Open the Telegram link automatically when sign-in starts. */
  autoOpen?: boolean;
}

const POLL_NOTES: Record<string, string> = {
  pending: 'Waiting for you to approve in Telegram…',
  needs_subscription: 'Approved. Pick a nub plan in Telegram to continue.',
  provisioning: 'Approved. Your nub agent is starting up…',
};

const FAILURES: Record<string, string> = {
  expired: 'The sign-in code expired. Start again.',
  denied: 'The sign-in was denied in Telegram.',
  not_found: 'That sign-in is no longer valid. Start again.',
  provision_failed: 'Your nub agent failed to start. Check maiavm.com, then try again.',
};

/**
 * "Sign in with Nub": the device-code link approved in Telegram. On success
 * the nub model key lands in the provider settings like a pasted key would.
 */
export function NubSignIn({ onLinked, autoOpen = true }: NubSignInProps) {
  const apiKey = useSettingsStore((s) => s.providers.nub?.apiKey ?? '');
  const updateProviderConfig = useSettingsStore((s) => s.updateProviderConfig);
  const setAvailableModels = useSettingsStore((s) => s.setAvailableModels);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storeKey = useCallback(
    (key: NubKey) => {
      updateProviderConfig('nub', { apiKey: key.apiKey, ...(key.models[0] ? { model: key.models[0] } : {}) });
      if (key.models.length) setAvailableModels('nub', key.models);
    },
    [setAvailableModels, updateProviderConfig],
  );

  const refreshStatus = useCallback(async (note?: string) => {
    try {
      const status = await nubApi.status();
      if (status.linked) setPhase({ kind: 'linked', status });
      else setPhase({ kind: 'signed-out', note: status.expired ? 'Your nub sign-in expired. Sign in again.' : note });
    } catch (err) {
      setPhase({ kind: 'signed-out', note: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [refreshStatus]);

  // Linked on the server but the key isn't in this window's settings (another
  // window, cleared storage): fetch a fresh one.
  useEffect(() => {
    if (phase.kind !== 'linked' || apiKey) return;
    let cancelled = false;
    nubApi
      .refreshKey()
      .then((key) => {
        if (!cancelled) storeKey(key);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiKey, phase.kind, storeKey]);

  const poll = useCallback(
    (link: NubLinkStart) => {
      pollTimer.current = setTimeout(async () => {
        try {
          const result = await nubApi.poll(link.code);
          if (result.status === 'ready') {
            storeKey(result);
            await refreshStatus();
            onLinked?.();
            return;
          }
          if (result.status in FAILURES) {
            setPhase({ kind: 'signed-out', note: FAILURES[result.status] });
            return;
          }
          const note =
            result.status === 'error'
              ? result.error ?? 'maiavm is busy; still waiting…'
              : POLL_NOTES[result.status] ?? POLL_NOTES.pending;
          setPhase({ kind: 'waiting', link, note });
          poll(link);
        } catch (err) {
          setPhase({ kind: 'signed-out', note: err instanceof Error ? err.message : String(err) });
        }
      }, link.pollInterval * 1000);
    },
    [onLinked, refreshStatus, storeKey],
  );

  const start = async () => {
    setBusy(true);
    try {
      const link = await nubApi.start();
      setPhase({ kind: 'waiting', link, note: POLL_NOTES.pending });
      if (autoOpen) openExternalUrl(link.telegramUrl);
      poll(link);
    } catch (err) {
      setPhase({ kind: 'signed-out', note: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setPhase({ kind: 'signed-out' });
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await nubApi.logout();
      // Leave the linked state first, or clearing the key would trigger the
      // "linked but no key" refresh above.
      setPhase({ kind: 'loading' });
      updateProviderConfig('nub', { apiKey: '' });
      await refreshStatus('Signed out of Nub.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 text-[13px]" data-testid="nub-sign-in">
      {phase.kind === 'loading' && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Checking Nub sign-in…
        </p>
      )}

      {phase.kind === 'signed-out' && (
        <>
          <Button type="button" size="sm" onClick={start} disabled={busy} aria-busy={busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            Sign in with Nub
          </Button>
          <p className="text-muted-foreground">
            Uses your nub agent account (maiavm.com): approve in Telegram, no API key to paste. Model usage comes out
            of your nub plan.
          </p>
        </>
      )}

      {phase.kind === 'waiting' && (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <p>
            Approve the sign-in in Telegram. It should show the code{' '}
            <span className="font-mono font-semibold tracking-wider">{phase.link.code}</span>.
          </p>
          <div className="flex items-center justify-between gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => openExternalUrl(phase.link.telegramUrl)}>
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Open Telegram
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
          {phase.link.pairingUrl && (
            <button
              type="button"
              onClick={() => openExternalUrl(phase.link.pairingUrl!)}
              className="rounded text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              No Telegram here? Open the pairing page
            </button>
          )}
        </div>
      )}

      {phase.kind === 'linked' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 p-3">
          <div className="min-w-0">
            <p className="font-medium">
              Linked to Nub
              {phase.status.instance ? (
                <span className="font-normal text-muted-foreground"> · your agent is {phase.status.instance.status}</span>
              ) : (
                <span className="font-normal text-muted-foreground"> · no agent deployed</span>
              )}
            </p>
            {phase.status.keyPrefix && (
              <p className="truncate font-mono text-[11px] text-muted-foreground">{phase.status.keyPrefix}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Get a fresh Nub key"
              onClick={async () => {
                setBusy(true);
                try {
                  storeKey(await nubApi.refreshKey());
                  await refreshStatus();
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={signOut} disabled={busy}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Sign out
            </Button>
            {onLinked && (
              <Button type="button" size="sm" onClick={onLinked} disabled={busy || !apiKey}>
                Continue
              </Button>
            )}
          </div>
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {phase.kind === 'waiting' ? phase.note : phase.kind === 'signed-out' ? phase.note ?? '' : ''}
      </p>
      {(phase.kind === 'waiting' || (phase.kind === 'signed-out' && phase.note)) && (
        <p className="text-muted-foreground" aria-hidden="true">
          {phase.kind === 'waiting' ? phase.note : phase.note}
        </p>
      )}
    </div>
  );
}
