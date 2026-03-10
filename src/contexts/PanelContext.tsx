import { createContext, useContext } from 'react';

const PanelContext = createContext<string>('default');

export const PanelProvider = PanelContext.Provider;

export function usePanelId(): string {
  return useContext(PanelContext);
}
