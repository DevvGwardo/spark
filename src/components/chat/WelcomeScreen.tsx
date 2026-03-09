import React from 'react';
import { ModelSelector } from './ModelSelector';

export const WelcomeScreen = React.forwardRef<HTMLDivElement>((_, ref) => {
  return (
    <div ref={ref} className="flex flex-col items-center justify-center h-full px-6">
      <div className="text-center max-w-md space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">CloudChat</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          How can I help you today?
        </p>
        <ModelSelector />
      </div>
    </div>
  );
});
WelcomeScreen.displayName = 'WelcomeScreen';
