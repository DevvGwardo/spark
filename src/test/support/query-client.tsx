import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';

/** A QueryClient that never retries and never garbage-collects mid-test. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

export function createQueryWrapper(client: QueryClient = createTestQueryClient()) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** `render` inside a fresh QueryClientProvider. Returns the client too. */
export function renderWithQueryClient(
  ui: ReactElement,
  options: Omit<RenderOptions, 'wrapper'> & { client?: QueryClient } = {},
) {
  const { client = createTestQueryClient(), ...rest } = options;
  return { client, ...render(ui, { wrapper: createQueryWrapper(client), ...rest }) };
}
