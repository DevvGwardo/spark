import React from 'react';
import { CheckCircle2, GitPullRequestDraft, Wand2 } from 'lucide-react';
import type { PendingProposal } from '@/lib/proposed-changes';
import { cn } from '@/lib/utils';

interface ChangeApprovalModalProps {
  proposal: PendingProposal;
  onAccept: () => void;
  disabled?: boolean;
}

export const ChangeApprovalModal: React.FC<ChangeApprovalModalProps> = ({
  proposal,
  onAccept,
  disabled = false,
}) => {
  const previewItems = proposal.plan.slice(0, 1);
  const hiddenCount = Math.max(0, proposal.plan.length - previewItems.length);

  return (
    <div className="w-full max-w-[720px] mx-auto px-4 pb-2">
      <div className="rounded-2xl border border-border/70 bg-background/95 shadow-[0_10px_30px_rgba(0,0,0,0.14)] backdrop-blur">
        <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/8 text-emerald-500">
            <GitPullRequestDraft className="h-4 w-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-500">
                Ready
              </span>
              {proposal.plan.length > 0 && (
                <span className="rounded-full border border-border/80 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {proposal.plan.length} file{proposal.plan.length === 1 ? '' : 's'}
                </span>
              )}
            </div>

            <p className="mt-1 pr-2 text-sm font-medium leading-6 text-foreground">
              {proposal.summary || 'The proposed changes are ready for approval.'}
            </p>

            {previewItems.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {previewItems.map((item) => (
                  <div
                    key={`${item.action}-${item.path}`}
                    className="flex items-center gap-1.5 rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] text-foreground/85"
                  >
                    <Wand2 className="h-3 w-3 text-emerald-500/80" />
                    <span className="truncate font-mono">{item.path}</span>
                    <span className="text-muted-foreground">{item.action}</span>
                  </div>
                ))}
                {hiddenCount > 0 && (
                  <div className="rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground">
                    +{hiddenCount} more
                  </div>
                )}
              </div>
            )}
          </div>
          </div>

          <button
            onClick={onAccept}
            disabled={disabled}
            className={cn(
              'shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-all duration-150 sm:self-center',
              disabled
                ? 'cursor-not-allowed border border-border bg-muted text-muted-foreground'
                : 'border border-emerald-500/25 bg-emerald-500 text-white hover:bg-emerald-600'
            )}
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Accept changes
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
