import React from 'react';
import { cn } from '@/lib/utils';
import sparkMark from '@/assets/spark-mark.png';

interface WelcomeHeroMarkProps {
  className?: string;
}

export const WelcomeHeroMark: React.FC<WelcomeHeroMarkProps> = ({ className }) => {
  return (
    <img
      src={sparkMark}
      alt="Spark"
      className={cn('h-28 w-28', className)}
      data-testid="welcome-hero-mark"
    />
  );
};
