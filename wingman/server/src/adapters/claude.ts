import { assertToolItems } from '../guard.js';
import type { Account, Adapter, AgentEvent, RateLimitInfo, StartSpec } from '../types.js';

const ALLOWED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TERM',
  'SHELL',
  'TMPDIR',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
]);

const NON_REJECTIONS = new Set(['allowed', 'allowed_warning']);

export function isRateLimitRejected(info: RateLimitInfo): boolean {
  return info.status !== undefined && !NON_REJECTIONS.has(info.status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export const claudeAdapter: Adapter = {
  provider: 'claude',

  buildCommand(account: Account, spec: StartSpec) {
    assertToolItems(spec.allowed_tools, 'allowed_tools');
    assertToolItems(spec.disallowed_tools, 'disallowed_tools');
    const args = ['-p'];
    args.push('--session-id', spec.session_id);
    args.push('--append-system-prompt', spec.append_system_prompt);
    args.push('--disallowedTools', ...spec.disallowed_tools);
    args.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none');
    if (spec.max_turns !== undefined) args.push('--max-turns', String(spec.max_turns));
    args.push('--output-format', 'stream-json', '--verbose', '--strict-mcp-config');
    if (spec.allowed_tools.length > 0) args.push('--allowedTools', ...spec.allowed_tools);
    if (spec.model) args.push('--model', spec.model);
    return { command: account.command, args };
  },

  buildEnv(parent, account, depth) {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(parent)) {
      if (value === undefined) continue;
      if (ALLOWED_ENV.has(name) || name.startsWith('LC_')) env[name] = value;
    }
    env.CLAUDE_CONFIG_DIR = account.config_dir;
    env.WINGMAN_DEPTH = String(depth);
    return env;
  },

  parseLine(line: string): AgentEvent[] {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(data)) return [];
    const events: AgentEvent[] = [];
    switch (data.type) {
      case 'system': {
        const sessionId = str(data.session_id);
        if (data.subtype === 'init' && sessionId) {
          events.push({ kind: 'started', session_id: sessionId });
        }
        break;
      }
      case 'assistant': {
        const message = data.message;
        const content = isObject(message) ? message.content : undefined;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (!isObject(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            events.push({ kind: 'message', text: block.text });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            events.push({ kind: 'tool', name: block.name });
          }
        }
        break;
      }
      case 'rate_limit_event': {
        const raw = data.rate_limit_info;
        if (!isObject(raw)) break;
        const info: RateLimitInfo = {};
        const status = str(raw.status);
        const resetsAt = num(raw.resetsAt);
        const rateLimitType = str(raw.rateLimitType);
        const utilization = num(raw.utilization);
        if (status !== undefined) info.status = status;
        if (resetsAt !== undefined) info.resetsAt = resetsAt;
        if (rateLimitType !== undefined) info.rateLimitType = rateLimitType;
        if (utilization !== undefined) info.utilization = utilization;
        events.push({ kind: 'rate_limited', info });
        break;
      }
      case 'result': {
        const denials: string[] = [];
        if (Array.isArray(data.permission_denials)) {
          for (const d of data.permission_denials) {
            if (isObject(d) && typeof d.tool_name === 'string') denials.push(d.tool_name);
          }
        }
        const isError =
          data.is_error === true || (data.subtype !== undefined && data.subtype !== 'success');
        const finished: AgentEvent = {
          kind: 'finished',
          result: typeof data.result === 'string' ? data.result : null,
          is_error: isError,
          permission_denials: denials,
        };
        if (data.subtype === 'error_max_turns') finished.max_turns = true;
        events.push(finished);
        break;
      }
      default:
        break;
    }
    return events;
  },
};

export function getAdapter(provider: string): Adapter {
  if (provider === 'claude') return claudeAdapter;
  throw new Error(`No adapter for provider "${provider}"`);
}
