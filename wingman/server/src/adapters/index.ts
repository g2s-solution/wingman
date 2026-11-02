import type { Adapter } from '../types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';

const ADAPTERS: Record<string, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

export function getAdapter(provider: string): Adapter {
  const adapter = Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : undefined;
  if (!adapter) throw new Error(`No adapter for provider "${provider}"`);
  return adapter;
}
