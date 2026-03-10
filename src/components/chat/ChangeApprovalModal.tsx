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
  const previewItems = proposal.plan.slice(0, 2);
  const hiddenCount = Math.max(0, proposal.plan.length - previewItems.length);

  return (
    <div className="w-full max-w-[720px] mx-auto px-4 pb-2">
      <div className="relative overflow-hidden rounded-[22px] border border-emerald-500/20 bg-[linear-gradient(180deg,rgba(22,163,74,0.16),rgba(17,24,39,0.92))] shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
        <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/70 to-transparent" />
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
            <GitPullRequestDraft className="h-4 w-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-200/85">
                Ready To Apply
              </span>
              {proposal.plan.length > 0 && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {proposal.plan.length} file{proposal.plan.length === 1 ? '' : 's'}
                </span>
              )}
            </div>

            <p className="mt-1 text-sm font-medium text-foreground">
              {proposal.summary || 'The proposed changes are ready for approval.'}
            </p>

            {proposal.excerpt && proposal.excerpt !== proposal.summary && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {proposal.excerpt}
              </p>
            )}

            {previewItems.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {previewItems.map((item) => (
                  <div
                    key={`${item.action}-${item.path}`}
                    className="flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-foreground/85"
                  >
                    <Wand2 className="h-3 w-3 text-emerald-300/80" />
                    <span className="font-mono">{item.path}</span>
                    <span className="text-muted-foreground">{item.action}</span>
                  </div>
                ))}
                {hiddenCount > 0 && (
                  <div className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-muted-foreground">
                    +{hiddenCount} more
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={onAccept}
            disabled={disabled}
            className={cn(
              'shrink-0 rounded-2xl px-4 py-2 text-sm font-semibold transition-all duration-150',
              disabled
                ? 'cursor-not-allowed border border-white/10 bg-white/5 text-muted-foreground'
                : 'border border-emerald-300/30 bg-emerald-300 text-emerald-950 hover:translate-y-[-1px] hover:bg-emerald-200'
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
