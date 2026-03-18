import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface SlotNumberProps {
  value: number;
  prefix?: string;
  className?: string;
}

/**
 * Animated slot-machine style number display.
 * Each digit rolls independently when the value changes.
 */
export const SlotNumber: React.FC<SlotNumberProps> = ({ value, prefix, className }) => {
  const digits = String(value).split('');
  const prevValueRef = useRef(value);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    if (prevValueRef.current !== value) {
      setAnimate(true);
      prevValueRef.current = value;
      const timer = setTimeout(() => setAnimate(false), 300);
      return () => clearTimeout(timer);
    }
  }, [value]);

  return (
    <span className={cn('inline-flex items-center overflow-hidden', className)}>
      {prefix && <span>{prefix}</span>}
      {digits.map((digit, i) => (
        <SlotDigit key={`${digits.length}-${i}`} digit={digit} animate={animate} delay={i * 30} />
      ))}
    </span>
  );
};

function SlotDigit({ digit, animate, delay }: { digit: string; animate: boolean; delay: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevDigit = useRef(digit);
  const [rolling, setRolling] = useState(false);

  useEffect(() => {
    if (prevDigit.current !== digit || animate) {
      prevDigit.current = digit;
      setRolling(true);
      const timer = setTimeout(() => setRolling(false), 250 + delay);
      return () => clearTimeout(timer);
    }
  }, [digit, animate, delay]);

  return (
    <span
      ref={ref}
      className="inline-block relative"
      style={{ width: '0.6em', height: '1.1em' }}
    >
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center tabular-nums',
          rolling ? 'slot-digit-roll' : ''
        )}
        style={{ animationDelay: `${delay}ms` }}
      >
        {digit}
      </span>
    </span>
  );
}
