import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

interface PanelContextValue {
  panelId: string;
  scopeId: string;
}

const PanelContext = createContext<PanelContextValue>({
  panelId: 'default',
  scopeId: 'default',
});

export function PanelProvider({
  value,
  children,
}: {
  value: string | PanelContextValue;
  children: ReactNode;
}) {
  const normalizedValue = typeof value === 'string'
    ? { panelId: value, scopeId: value }
    : value;

  return (
    <PanelContext.Provider value={normalizedValue}>
      {children}
    </PanelContext.Provider>
  );
}

export function usePanelId(): string {
  return useContext(PanelContext).panelId;
}

export function useChatScopeId(): string {
  return useContext(PanelContext).scopeId;
}
