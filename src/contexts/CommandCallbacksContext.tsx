import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export interface CommandCallbacks {
  stopAgent?: () => void;
  retryMessage?: () => void;
  newConversation?: () => void;
  renameConversation?: (title: string) => void;
  undoMessage?: () => void;
  approveCommand?: () => void;
  denyCommand?: () => void;
  resetSession?: () => void;
  compressContext?: () => void;
}

const CommandCallbacksContext = createContext<CommandCallbacks>({});

export function CommandCallbacksProvider({
  callbacks,
  children,
}: {
  callbacks: CommandCallbacks;
  children: ReactNode;
}) {
  return (
    <CommandCallbacksContext.Provider value={callbacks}>
      {children}
    </CommandCallbacksContext.Provider>
  );
}

export function useCommandCallbacks(): CommandCallbacks {
  return useContext(CommandCallbacksContext);
}
