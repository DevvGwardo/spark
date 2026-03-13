import React from 'react';
import { cn } from '@/lib/utils';
import cloudchatMark from '@/assets/android-chrome-512x512.png';

interface WelcomeHeroMarkProps {
  className?: string;
}

export const WelcomeHeroMark: React.FC<WelcomeHeroMarkProps> = ({ className }) => {
  return (
    <img
      src={cloudchatMark}
      alt="CloudChat"
      className={cn('h-28 w-28', className)}
      data-testid="welcome-hero-mark"
    />
  );
};
