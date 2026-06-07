import React from 'react';
import { motion } from 'framer-motion';
import { useTour, type ProviderProps, type StepType } from '@reactour/tour';
import { SPRING } from '@/components/onboarding/motion';

// Presentational step body — keeps every popover consistent with the dark, dense
// UI. Re-keyed on the current step so the content replays its entrance each time
// the tour advances, with an animated progress bar tying the steps together.
function TourStep({ title, body }: { title: string; body: React.ReactNode }) {
  const { currentStep, steps } = useTour();
  const total = steps?.length ?? 1;
  const progress = Math.min(1, (currentStep + 1) / total);

  return (
    <motion.div
      key={currentStep}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="px-1 py-0.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-[hsl(var(--border))]">
          <motion.div
            className="h-full rounded-full bg-[hsl(var(--primary))]"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: progress }}
            style={{ originX: 0 }}
            transition={SPRING}
          />
        </div>
        <span className="shrink-0 font-mono text-[9px] tabular-nums text-[hsl(var(--text-secondary))]">
          {currentStep + 1}/{total}
        </span>
      </div>
      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-[hsl(var(--text-primary))]">{title}</h3>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[hsl(var(--text-secondary))]">{body}</p>
    </motion.div>
  );
}

export const appTourSteps: StepType[] = [
  {
    selector: '[data-tour="threads-list"]',
    content: (
      <TourStep
        title="Threads, grouped by project"
        body="Your conversations live here — automatically grouped into collapsible sections by the GitHub repo each thread is working on. Pinned threads stay on top."
      />
    ),
  },
  {
    selector: '[data-tour="repo-footer"]',
    content: (
      <TourStep
        title="Connect GitHub"
        body="Attach a repository so the agent can read and edit real code. If you haven't added a token yet, this takes you straight to GitHub settings to connect."
      />
    ),
  },
  {
    selector: '[data-tour="subtab-nav"]',
    content: (
      <TourStep
        title="Board, Sessions & more"
        body={
          <>
            Switch between Threads, the <span className="font-medium text-[hsl(var(--text-primary))]">Board</span> (a
            full Kanban view of your tasks that can open fullscreen), Sessions, and other tools right here.
          </>
        }
      />
    ),
  },
  {
    selector: '[data-tour="composer"]',
    content: (
      <TourStep
        title="Build something"
        body={
          <>
            Describe what you want and hand it off. Toggle <span className="font-medium text-[hsl(var(--text-primary))]">Plan</span>{' '}
            mode for read-only exploration, or open the terminal and mini-browser from the top bar.
          </>
        }
      />
    ),
  },
];

// Theme the popover + mask to match the dark, high-contrast aesthetic.
export const tourStyles: NonNullable<ProviderProps['styles']> = {
  popover: (base) => ({
    ...base,
    background: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    borderRadius: 14,
    border: '1px solid hsl(var(--border))',
    // Subtle top-rim highlight + deep ambient shadow for modern, lifted depth.
    boxShadow: '0 1px 0 0 hsl(var(--primary) / 0.12) inset, 0 18px 50px -12px rgba(0,0,0,0.6)',
    padding: '14px 16px 14px',
    maxWidth: 320,
    '--reactour-accent': 'hsl(var(--primary))',
  }),
  maskArea: (base) => ({ ...base, rx: 12 }),
  maskWrapper: (base) => ({ ...base, color: 'rgba(0,0,0,0.62)' }),
  badge: (base) => ({
    ...base,
    background: 'hsl(var(--primary))',
    color: 'hsl(var(--primary-foreground))',
    fontSize: 11,
  }),
  dot: (base, state) => ({
    ...base,
    background: state?.current ? 'hsl(var(--primary))' : 'hsl(var(--border))',
    border: 'none',
  }),
  close: (base) => ({ ...base, color: 'hsl(var(--muted-foreground))', top: 10, right: 10, width: 9, height: 9 }),
};
