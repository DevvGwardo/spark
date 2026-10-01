import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useHermesStore } from '@/stores/hermes-store';
import {
  postAcpApproval,
  postServerApproval,
  type AcpApprovalDecision,
  type ServerApprovalDecision,
} from '@/lib/hermes-api';
import { cn } from '@/lib/utils';
import { usePanelId } from '@/hooks/use-panel-context';

/** Unified ladder decisions: server approvals accept the first three; the
 *  optional 4th ("Always for prefix") is sent as decision "approved" with
 *  reason "prefix" so the server approval-engine inserts a durable prefix
 *  rule (kind: 'prefix') that auto-approves future commands with the same
 *  prefix. */
type LadderDecision = ServerApprovalDecision | 'prefix';

function legacyOptionIdForDecision(decision: LadderDecision): AcpApprovalDecision {
  switch (decision) {
    case 'approved':
      return 'allow_once';
    case 'approved_for_session':
      return 'allow_session';
    case 'denied':
      return 'deny';
    case 'prefix':
      return 'allow_always';
  }
}

function commandPrefix(command: string | undefined, max = 40): string {
  if (!command) {
    return '';
  }
  const trimmed = command.trim();
  const prefix = trimmed.split(/\s+/).slice(0, 2).join(' ');
  return prefix.length > max ? `${prefix.slice(0, max - 1)}…` : prefix;
}

/** True when the user is typing somewhere. Moving focus to an action button
 *  then would let a stray Space/Enter meant for the composer approve a tool
 *  call, so the banner only announces itself in that case. */
function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

/**
 * Inline banner for tool permission requests — renders for BOTH the real
 * hermes-agent's ACP approvals (resolved by the bridge) and the new
 * server-side tool approvals (approval-engine, resolved by the Express
 * server). The ladder maps available_decisions onto buttons; the choice is
 * POSTed with the unified {decision, reason?} contract to the single
 * /api/hermes/approvals/{id} route, which resolves engine-local ids itself
 * and forwards acp-* ids to the bridge. Legacy ACP payloads (options only)
 * go to the same route with the bridge's {option_id} contract.
 */
export const AcpApprovalBanner: React.FC = () => {
  // Oldest pending request first — one banner at a time; concurrent prompts
  // queue instead of clobbering each other.
  const pending = useHermesStore((state) => Object.values(state.pendingAcpApprovals)[0] ?? null);
  const clearPendingAcpApproval = useHermesStore((state) => state.clearPendingAcpApproval);
  const panelId = usePanelId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const actionsRef = useRef<HTMLDivElement>(null);
  // Focus moves to the first action once per approval id, never on re-render,
  // so streaming updates elsewhere in the transcript cannot steal focus back.
  const focusedApprovalIdRef = useRef<string | null>(null);
  // Where focus was before the banner took it; restored when the queue drains.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const pendingId = pending?.approval_id ?? null;

  useEffect(() => {
    if (!pendingId) {
      focusedApprovalIdRef.current = null;
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const active = document.activeElement;
      // Only restore when the resolved banner left focus nowhere (on <body>).
      if (restore && restore.isConnected && (!active || active === document.body)) {
        restore.focus({ preventScroll: true });
      }
      return;
    }
    if (focusedApprovalIdRef.current === pendingId) {
      return;
    }
    focusedApprovalIdRef.current = pendingId;
    const active = document.activeElement;
    if (isEditableElement(active)) {
      return;
    }
    const actions = actionsRef.current;
    const firstAction = actions?.querySelector<HTMLButtonElement>('button');
    if (!actions || !firstAction) {
      return;
    }
    if (active instanceof HTMLElement && active !== document.body && !actions.contains(active)) {
      restoreFocusRef.current = active;
    }
    firstAction.focus({ preventScroll: true });
  }, [pendingId]);

  const decide = useCallback(
    async (decision: LadderDecision) => {
      // aria-disabled (not disabled) keeps focus on the button while a
      // decision is in flight, so the guard lives here.
      if (!pending || busyRef.current) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const approved = decision !== 'denied';
      try {
        const hasUnifiedContract =
          Array.isArray(pending.available_decisions) && pending.available_decisions.length > 0;
        if (hasUnifiedContract) {
          const serverDecision: ServerApprovalDecision =
            decision === 'prefix' ? 'approved' : decision;
          await postServerApproval(
            pending.approval_id,
            serverDecision,
            decision === 'prefix' ? 'prefix' : undefined,
          );
        } else {
          // Legacy ACP payloads (options only) — existing bridge flow.
          // hermes-agent's ACP adapter accepts only allow_once/deny;
          // session/always option ids are treated as a denial, so clamp
          // them to "once" (mirrors the server-side clamp).
          const clampedDecision: LadderDecision =
            decision === 'approved_for_session' || decision === 'prefix'
              ? 'approved'
              : decision;
          const optionId = legacyOptionIdForDecision(clampedDecision);
          await postAcpApproval(pending.approval_id, optionId);
        }
        // One-line assistant-side audit entry appended to the transcript by
        // the chat runtime (persisted like other messages).
        useHermesStore.getState().requestChatAction(panelId, {
          kind: 'approval_audit',
          tool: pending.tool,
          command: pending.command,
          approved,
        });
        clearPendingAcpApproval(pending.approval_id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to send decision');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [panelId, pending, clearPendingAcpApproval],
  );

  if (!pending) {
    return null;
  }

  const headline = pending.summary || pending.excerpt || pending.tool || 'Hermes is waiting for approval.';
  const detail = pending.summary && pending.excerpt && pending.excerpt !== pending.summary
    ? pending.excerpt
    : null;
  const decisions = pending.available_decisions ?? [];
  const unified = decisions.length > 0;
  const hasApproved = !unified || decisions.includes('approved');
  // Legacy payloads carry no decision list, and hermes-agent only accepts
  // allow_once/deny — session/always buttons stay hidden in that case.
  const hasApprovedSession = unified && decisions.includes('approved_for_session');
  const hasDenied = !unified || decisions.includes('denied');
  // "Always for prefix" is only offered when the payload carries a command
  // and the session-scoped decision it maps to is available.
  const hasPrefix = unified && Boolean(pending.command && hasApprovedSession);
  const prefixLabel = commandPrefix(pending.command);
  // Accessible names start with the visible label (WCAG 2.5.3) and add the
  // tool so a screen-reader user hears what they are deciding on.
  const toolSuffix = pending.tool ? `: ${pending.tool}` : '';

  const buttonClass = (tone: 'default' | 'danger') =>
    cn(
      'inline-flex items-center justify-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      tone === 'danger'
        ? 'border-destructive/40 bg-background/70 text-destructive hover:bg-destructive/10'
        : 'border-border/60 bg-background/70 text-foreground hover:bg-muted',
      busy && 'cursor-not-allowed opacity-60',
    );

  return (
    <div
      className="mt-2"
      data-testid="acp-approval-banner"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
    >
      <div className="rounded-[20px] border border-border/60 bg-background/90 shadow-[0_8px_24px_rgba(0,0,0,0.06)] backdrop-blur-sm">
        <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/45 text-muted-foreground">
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          </div>

          <div className="min-w-0 flex-1">
            {/* role="alert" (implicit aria-live="assertive") announces each new
                request, including the next one in the queue. */}
            <div role="alert" aria-live="assertive" aria-atomic="true">
              <div className="flex flex-wrap items-center gap-2">
                <span id={titleId} className="rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Approval required
                </span>
                {pending.tool && (
                  <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground">
                    {pending.tool}
                  </span>
                )}
              </div>

              <p id={descriptionId} className="mt-2 text-sm font-medium leading-6 text-foreground">
                {headline}
              </p>
            </div>

            {pending.command && (
              <div className="mt-1.5">
                <pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/40 bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground/90">
                  {pending.command}
                </pre>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/60">
                  {pending.cwd ? (
                    <span className="font-mono truncate" title={pending.cwd}>{pending.cwd}</span>
                  ) : null}
                  {pending.reason ? (
                    <span className="italic">{pending.reason}</span>
                  ) : null}
                </div>
              </div>
            )}

            {!pending.command && detail && (
              <p className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/40 bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                {detail}
              </p>
            )}

            {error && (
              <p role="alert" className="mt-1.5 text-[11px] text-destructive">
                {error}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            <div
              ref={actionsRef}
              role="group"
              aria-label="Approval decision"
              className="flex flex-col gap-2 sm:flex-row"
            >
              {hasApproved && (
                <button
                  type="button"
                  onClick={() => decide('approved')}
                  aria-disabled={busy || undefined}
                  aria-label={`Approve once${toolSuffix}`}
                  className={buttonClass('default')}
                >
                  Approve once
                </button>
              )}
              {hasApprovedSession && (
                <button
                  type="button"
                  onClick={() => decide('approved_for_session')}
                  aria-disabled={busy || undefined}
                  aria-label={`Approve for session${toolSuffix}`}
                  className={buttonClass('default')}
                >
                  Approve for session
                </button>
              )}
              {hasPrefix && (
                <button
                  type="button"
                  onClick={() => decide('prefix')}
                  aria-disabled={busy || undefined}
                  aria-label={`Always for prefix ${prefixLabel}`}
                  className={buttonClass('default')}
                  title={`Always allow ${prefixLabel}…`}
                >
                  Always for prefix
                </button>
              )}
              {hasDenied && (
                <button
                  type="button"
                  onClick={() => decide('denied')}
                  aria-disabled={busy || undefined}
                  aria-label={`Deny${toolSuffix}`}
                  className={buttonClass('danger')}
                >
                  Deny
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
