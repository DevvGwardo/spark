import type { Provider } from '@/stores/settings-store';

/**
 * Returns the base URL for the local API server.
 */
export function getApiBaseUrl(): string {
  if (window.electronAPI?.apiPort) {
    return `http://localhost:${window.electronAPI.apiPort}`;
  }
  return import.meta.env.VITE_API_URL || 'http://localhost:3001';
}

export async function validateApiKey(
  provider: Provider,
  apiKey: string
): Promise<{ valid: boolean; models?: string[]; defaultModel?: string; error?: string }> {
  const baseUrl = getApiBaseUrl();

  const response = await fetch(`${baseUrl}/functions/v1/validate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, api_key: apiKey }),
  });

  return response.json();
}
