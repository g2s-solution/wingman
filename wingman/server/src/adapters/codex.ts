import type { Account, Adapter, AgentEvent, StartSpec } from '../types.js';
import { allowlistedEnv } from './env.js';

const RATE_LIMIT =
  /rate.?limit|usage limit|insufficient_quota|too many requests|\bHTTP 429\b|\b429 Too Many/i;
/** Codex reports no reset time on a refusal, so assume a short cooldown. */
const COOLDOWN_SECONDS = 3600;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sandboxFor(preset: string): string {
  return preset === 'readonly' ? 'read-only' : 'workspace-write';
}

/**
 * Codex emits `error` events for transient reconnects before a normal result, so only
 * `turn.failed` ends a run as an error and only `turn.completed` ends it as a success.
 */
function createParser(): (line: string) => AgentEvent[] {
  let last: string | null = null;
  return (line) => {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(data)) return [];
    switch (data.type) {
      case 'thread.started': {
        const id = str(data.thread_id);
        return id ? [{ kind: 'started', session_id: id }] : [];
      }
      case 'item.completed': {
        const item = data.item;
        if (!isObject(item)) return [];
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          last = item.text;
          return [{ kind: 'message', text: item.text }];
        }
        if (item.type === 'command_execution' && typeof item.command === 'string') {
          return [{ kind: 'tool', name: 'command' }];
        }
        return [];
      }
      case 'turn.completed':
        return [{ kind: 'finished', result: last, is_error: false, permission_denials: [] }];
      case 'turn.failed': {
        const error = isObject(data.error) ? str(data.error.message) : undefined;
        const message = error ?? 'the Codex turn failed';
        const events: AgentEvent[] = [];
        if (RATE_LIMIT.test(message)) {
          events.push({
            kind: 'rate_limited',
            info: {
              status: 'rejected',
              resetsAt: Math.floor(Date.now() / 1000) + COOLDOWN_SECONDS,
            },
          });
        }
        events.push({
          kind: 'finished',
          result: last ?? message,
          is_error: true,
          permission_denials: [],
        });
        return events;
      }
      default:
        return [];
    }
  };
}

export const codexAdapter: Adapter = {
  provider: 'codex',
  capabilities: { allowedTools: false, maxTurns: false, agentCommits: false },

  buildPrompt(spec: StartSpec) {
    return `${spec.append_system_prompt}\n\n---\n\n${spec.prompt}`;
  },

  buildCommand(account: Account, spec: StartSpec) {
    const args = [
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      spec.cwd,
      '-s',
      sandboxFor(spec.preset),
    ];
    if (spec.model) args.push('-m', spec.model);
    args.push('-');
    return { command: account.command, args };
  },

  buildEnv(parent, account, depth) {
    const env = allowlistedEnv(parent);
    env.CODEX_HOME = account.config_dir;
    env.WINGMAN_DEPTH = String(depth);
    return env;
  },

  createLineParser: createParser,

  parseLine(line: string) {
    return createParser()(line);
  },

  isRateLimitRejected: (info) => info.status === 'rejected',
};
