import React from 'react';
import SlotCounter from 'react-slot-counter';
import { cn } from '@/lib/utils';

interface SlotNumberProps {
  value?: number;
  formattedValue?: string;
  prefix?: string;
  className?: string;
}

/**
 * Slot-machine style number display using react-slot-counter.
 * Each digit rolls independently when the value changes.
 */
export const SlotNumber: React.FC<SlotNumberProps> = ({ value, formattedValue, prefix, className }) => {
  return (
    <span className={cn('inline-flex items-center overflow-hidden', className)}>
      {prefix && <span className="shrink-0">{prefix}</span>}
      <SlotCounter
        value={formattedValue ?? Math.max(0, value ?? 0)}
        duration={0.4}
        speed={0.04}
        direction="bottom-up"
        useMonospaceWidth={false}
        containerClassName="inline-flex items-center"
        charClassName="tabular-nums"
        slotPeek={2}
      />
    </span>
  );
};
