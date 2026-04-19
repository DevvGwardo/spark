import React from 'react';
import { cn } from '@/lib/utils';

interface BorderBeamProps {
  className?: string;
  size?: number;
  duration?: number;
  anchor?: number;
  colorFrom?: string;
  colorTo?: string;
  delay?: number;
  blur?: number;
  /** Width of the traveling glow blob in px. */
  beamWidth?: number;
}

/**
 * A single-lap traveling glow that follows the inside edge of its parent.
 * Parent must be `relative` and have rounded corners (the beam inherits `rounded-[inherit]`).
 */
export const BorderBeam: React.FC<BorderBeamProps> = ({
  className,
  size = 260,
  duration = 8,
  anchor = 90,
  colorFrom = '#a78bfa',
  colorTo = '#22d3ee',
  delay = 0,
  blur = 24,
  beamWidth = 240,
}) => {
  return (
    <div
      style={
        {
          '--size': size,
          '--duration': duration,
          '--anchor': anchor,
          '--color-from': colorFrom,
          '--color-to': colorTo,
          '--delay': `-${delay}s`,
          '--blur': `${blur}px`,
          '--beam-w': `${beamWidth}px`,
        } as React.CSSProperties
      }
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]',
        'after:absolute after:h-[8px] after:w-[var(--beam-w)] after:animate-border-beam after:[animation-delay:var(--delay)]',
        'after:[background:linear-gradient(to_left,var(--color-from)_0%,var(--color-to)_40%,transparent_100%)]',
        'after:[filter:blur(var(--blur))] after:opacity-40',
        'after:[offset-anchor:calc(var(--anchor)*1%)_50%]',
        'after:[offset-path:rect(0_auto_auto_0_round_calc(var(--size)*1px))]',
        className,
      )}
    />
  );
};
