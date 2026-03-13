import type { Provider } from '@/stores/settings-store';

export interface LocalProviderRuntimeDetails {
  provider: 'hermes' | 'openclaw';
  title: string;
  badge: string;
  summary: string;
  detail: string;
  command: string;
  locationLabel: string;
  locationValue: string;
}

const HERMES_BRIDGE_URL = import.meta.env.VITE_HERMES_BRIDGE_URL || 'http://localhost:3002/v1';
const OPENCLAW_BIN = import.meta.env.VITE_OPENCLAW_BIN || '~/.openclaw/bin/openclaw';

export function getLocalProviderRuntimeDetails(
  provider: Provider | 'hermes' | 'openclaw',
): LocalProviderRuntimeDetails | null {
  if (provider === 'hermes') {
    return {
      provider: 'hermes',
      title: 'Hermes Bridge',
      badge: 'Local Agent',
      summary: 'Hermes needs its local bridge running before chats can reach the agent.',
      detail: 'Start the FastAPI bridge, then retry your request. Hermes also uses your configured OpenRouter key for model calls.',
      command: 'cd hermes-bridge && python main.py',
      locationLabel: 'Bridge URL',
      locationValue: HERMES_BRIDGE_URL,
    };
  }

  if (provider === 'openclaw') {
    return {
      provider: 'openclaw',
      title: 'OpenClaw Runtime',
      badge: 'Local Agent',
      summary: 'OpenClaw must be installed and available locally before this provider can run.',
      detail: 'Make sure the OpenClaw CLI and its local agent runtime are installed, then retry model discovery or resend your chat.',
      command: `${OPENCLAW_BIN} agent --help`,
      locationLabel: 'CLI Path',
      locationValue: OPENCLAW_BIN,
    };
  }

  return null;
}

export function parseLocalProviderRuntimeError(
  provider: string,
  message: string,
): LocalProviderRuntimeDetails | null {
  const normalized = message.toLowerCase();
  if (provider === 'hermes') {
    if (
      normalized.includes('hermes bridge is not reachable') ||
      normalized.includes('start hermes-bridge/main.py')
    ) {
      return getLocalProviderRuntimeDetails('hermes');
    }
  }

  if (provider === 'openclaw') {
    if (
      normalized.includes('openclaw cli not found') ||
      normalized.includes('openclaw agent is not available') ||
      normalized.includes('openclaw runtime is not available')
    ) {
      return getLocalProviderRuntimeDetails('openclaw');
    }
  }

  return null;
}
