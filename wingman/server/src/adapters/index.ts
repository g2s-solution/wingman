import type { Adapter } from '../types.js';
import { claudeAdapter } from './claude.js';

const ADAPTERS: Record<string, Adapter> = {
  claude: claudeAdapter,
};

export function getAdapter(provider: string): Adapter {
  const adapter = Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : undefined;
  if (!adapter) throw new Error(`No adapter for provider "${provider}"`);
  return adapter;
}
