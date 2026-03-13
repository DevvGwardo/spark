import React from 'react';
import { CheckCircle2, GitPullRequestDraft, ShieldCheck, Wand2, X } from 'lucide-react';
import type { PendingProposal } from '@/lib/proposed-changes';
import { cn } from '@/lib/utils';

interface ChangeApprovalModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposal: PendingProposal;
  onAccept: () => void;
  onAcceptAlways: () => void;
  disabled?: boolean;
}

export const ChangeApprovalModal: React.FC<ChangeApprovalModalProps> = ({
  open,
  onOpenChange,
  proposal,
  onAccept,
  onAcceptAlways,
  disabled = false,
}) => {
  if (!open) return null;

  const headline = proposal.summary || proposal.excerpt || 'Review the proposed file changes before Hermes continues.';
  const detail = proposal.summary && proposal.excerpt && proposal.excerpt !== proposal.summary
    ? proposal.excerpt
    : null;
  const previewItems = proposal.plan.slice(0, 1);
  const hiddenCount = Math.max(0, proposal.plan.length - previewItems.length);

  return (
    <div className="mt-2" data-testid="change-approval-banner">
      <div className="rounded-[20px] border border-border/60 bg-background/90 shadow-[0_8px_24px_rgba(0,0,0,0.06)] backdrop-blur-sm">
        <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/45 text-muted-foreground">
            <GitPullRequestDraft className="h-4 w-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Approval required
              </span>
              {proposal.plan.length > 0 && (
                <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {proposal.plan.length} file{proposal.plan.length === 1 ? '' : 's'}
                </span>
              )}
            </div>

            <p className="mt-2 text-sm font-medium leading-6 text-foreground">
              {headline}
            </p>

            <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/85">
              Hermes is waiting for approval before it edits repo files.
            </p>

            {(previewItems.length > 0 || detail) && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                  <Wand2 className="h-3.5 w-3.5" />
                  Planned edits
                </div>

                {previewItems.map((item, index) => (
                  <React.Fragment key={`${item.action}-${item.path}-${index}`}>
                    <code className="rounded-lg border border-border/60 bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground">
                      {item.path}
                    </code>
                    <span className="rounded-full border border-border/60 bg-muted/45 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      {item.action}
                    </span>
                  </React.Fragment>
                ))}

                {hiddenCount > 0 && (
                  <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                    +{hiddenCount} more
                  </span>
                )}
              </div>
            )}

            {detail && previewItems.length === 0 && (
              <p className="mt-2 text-sm leading-5 text-muted-foreground">
                {detail}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="self-end rounded-xl p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
              aria-label="Dismiss approval banner"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                onClick={onAcceptAlways}
                disabled={disabled}
                className={cn(
                  'inline-flex items-center justify-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                  disabled
                    ? 'cursor-not-allowed border-border/60 bg-muted/40 text-muted-foreground/60'
                    : 'border-border/60 bg-background/80 text-foreground hover:bg-muted'
                )}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Allow all
              </button>

              <button
                onClick={onAccept}
                disabled={disabled}
                className={cn(
                  'inline-flex items-center justify-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors duration-150',
                  disabled
                    ? 'cursor-not-allowed bg-muted text-muted-foreground/60'
                    : 'bg-foreground text-background hover:opacity-90'
                )}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Approve
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
