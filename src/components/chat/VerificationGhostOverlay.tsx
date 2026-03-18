import React from 'react';
import { useActivityStore } from '@/stores/activity-store';
import { GhostIcon } from './GhostIcon';
import { Progress } from '@/components/ui/progress';

export const VerificationGhostOverlay: React.FC = () => {
  const verification = useActivityStore((s) => s.verification);

  if (!verification.active) return null;

  return (
    <div className="mb-3 flex items-center gap-3 rounded-2xl border border-border/60 bg-background/80 px-4 py-3 shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/50 bg-background">
        <GhostIcon size={28} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground/90">{verification.stepLabel}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{Math.round(verification.progress)}%</span>
        </div>
        <Progress
          value={verification.progress}
          className="mt-1.5 h-1.5 bg-background/70 [&>div]:bg-[linear-gradient(90deg,rgba(245,208,84,0.95),rgba(16,185,129,0.95))]"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">{verification.stepDetail}</p>
      </div>
    </div>
  );
};
