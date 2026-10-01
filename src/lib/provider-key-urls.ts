import type { Provider } from '@/stores/settings-store';

/** Where users can create/retrieve an API key for each provider. */
export const PROVIDER_KEY_URLS: Partial<Record<Provider, string>> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  groq: 'https://console.groq.com/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  mistral: 'https://console.mistral.ai/api-keys/',
  together: 'https://api.together.ai/settings/api-keys',
  minimax: 'https://www.minimax.io/',
  'minimax-payg': 'https://www.minimax.io/',
  kimi: 'https://platform.moonshot.cn/console/api-keys',
  'kimi-coding': 'https://www.kimi.com/code',
  cerebras: 'https://cloud.cerebras.ai/platform',
  openrouter: 'https://openrouter.ai/keys',
  sambanova: 'https://cloud.sambanova.ai/apis',
  hermes: 'https://openrouter.ai/keys',
  nub: 'https://www.maiavm.com',
};
