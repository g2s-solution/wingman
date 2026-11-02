import type { Account, Adapter, AgentEvent, StartSpec } from '../types.js';
import { allowlistedEnv } from './env.js';

const RATE_LIMIT = /rate.?limit|usage limit|insufficient_quota|too many requests|\bHTTP 429\b/i;
/** OpenCode reports no reset time on a refusal, so assume a short cooldown. */
const COOLDOWN_SECONDS = 3600;

/** A command allowed by name: the bare command and the command followed by arguments, never a longer name (`git difftool`). */
const cmd = (name: string): string[] => [name, `${name} *`];

const READ_COMMANDS = [
  ...cmd('git status'),
  ...cmd('git log'),
  ...cmd('git diff'),
  ...cmd('git show'),
  'date',
  'date +*',
];
const FILE_COMMANDS = [
  ...cmd('git add'),
  ...cmd('git commit'),
  ...cmd('git mv'),
  ...cmd('git rm'),
  ...cmd('git restore'),
  ...cmd('git rev-parse'),
  ...cmd('git ls-files'),
];
const RUN_COMMANDS = [
  ...cmd('node'),
  ...cmd('npm run'),
  ...cmd('npm test'),
  ...cmd('npm ci'),
  ...cmd('npm install'),
];
/** Refusals placed last so they win over any allow above. */
const NEVER = [
  '*--output*',
  '*--no-index*',
  '*--ext-diff*',
  '*--textconv*',
  '* -g *',
  '* -g',
  '*--global*',
  '*--location=global*',
];

/**
 * The permission rules for one run. Rules are matched in order and the last match wins, so the
 * catch-all deny comes first and the refusals come last. A command that chains others with
 * `&&`, `;` or `|` is judged per command by OpenCode, so a chain cannot smuggle one through.
 */
export function permissionFor(preset: string): Record<string, unknown> {
  const allowed =
    preset === 'readonly'
      ? READ_COMMANDS
      : preset === 'edit-files'
        ? [...READ_COMMANDS, ...FILE_COMMANDS]
        : [...READ_COMMANDS, ...FILE_COMMANDS, ...RUN_COMMANDS];
  const bash: Record<string, string> = { '*': 'deny' };
  for (const pattern of allowed) bash[pattern] = 'allow';
  for (const pattern of NEVER) bash[pattern] = 'deny';
  return {
    edit: preset === 'readonly' ? 'deny' : 'allow',
    webfetch: 'deny',
    task: 'deny',
    external_directory: 'deny',
    bash,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function createParser(): (line: string) => AgentEvent[] {
  let last: string | null = null;
  let sessionSeen = false;
  let done = false;
  const denials: string[] = [];
  return (line) => {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(data)) return [];
    const events: AgentEvent[] = [];
    const session = str(data.sessionID);
    if (session && !sessionSeen) {
      sessionSeen = true;
      events.push({ kind: 'started', session_id: session });
    }
    const part = isObject(data.part) ? data.part : undefined;
    switch (data.type) {
      case 'text': {
        const text = part ? str(part.text) : undefined;
        if (text !== undefined) {
          last = text;
          events.push({ kind: 'message', text });
        }
        break;
      }
      case 'tool_use': {
        const tool = part ? str(part.tool) : undefined;
        if (tool) events.push({ kind: 'tool', name: tool });
        const state = part && isObject(part.state) ? part.state : undefined;
        const error = state ? str(state.error) : undefined;
        if (tool && error?.startsWith('Permission denied')) denials.push(tool);
        break;
      }
      case 'step_finish': {
        if (part && part.reason === 'stop' && !done) {
          done = true;
          events.push({
            kind: 'finished',
            result: last,
            is_error: false,
            permission_denials: [...denials],
          });
        }
        break;
      }
      case 'error': {
        const error = isObject(data.error) ? data.error : {};
        const nested = isObject(error.data) ? str(error.data.message) : undefined;
        const message =
          str(error.message) ?? nested ?? str(error.name) ?? 'the OpenCode run failed';
        if (error.status === 429 || RATE_LIMIT.test(message)) {
          events.push({
            kind: 'rate_limited',
            info: {
              status: 'rejected',
              resetsAt: Math.floor(Date.now() / 1000) + COOLDOWN_SECONDS,
            },
          });
        }
        if (done) break;
        done = true;
        events.push({
          kind: 'finished',
          result: last ?? message,
          is_error: true,
          permission_denials: [...denials],
        });
        break;
      }
      default:
        break;
    }
    return events;
  };
}

export const opencodeAdapter: Adapter = {
  provider: 'opencode',
  capabilities: { allowedTools: false, maxTurns: false, agentCommits: true },

  buildPrompt(spec: StartSpec) {
    return `${spec.append_system_prompt}\n\n---\n\n${spec.prompt}`;
  },

  buildCommand(account: Account, spec: StartSpec) {
    const args = ['run', '--format', 'json', '--standalone'];
    if (spec.model) args.push('-m', spec.model);
    return { command: account.command, args };
  },

  buildEnv(parent, account, depth, spec) {
    const env = allowlistedEnv(parent);
    const dir = account.config_dir;
    env.XDG_CONFIG_HOME = `${dir}/config`;
    env.XDG_DATA_HOME = `${dir}/data`;
    env.XDG_STATE_HOME = `${dir}/state`;
    env.XDG_CACHE_HOME = `${dir}/cache`;
    env.npm_config_userconfig = `${dir}/npmrc`;
    env.WINGMAN_DEPTH = String(depth);
    if (spec)
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: permissionFor(spec.preset) });
    return env;
  },

  createLineParser: createParser,

  parseLine(line: string) {
    return createParser()(line);
  },

  isRateLimitRejected: (info) => info.status === 'rejected',
};
