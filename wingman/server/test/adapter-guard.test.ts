import { describe, expect, it } from 'vitest';
import { claudeAdapter, isRateLimitRejected } from '../src/adapters/claude.js';
import {
  PRESETS,
  baseDisallowed,
  guardPrompt,
  parseStatusLine,
  resolveTools,
} from '../src/guard.js';
import type { Account, StartSpec } from '../src/types.js';

const account: Account = {
  id: 'b',
  label: 'B',
  config_dir: '/cfg/b',
  provider: 'claude',
  command: '/bin/launcher',
};
const spec: StartSpec = {
  prompt: 'do it',
  cwd: '/x',
  allowed_tools: ['Read', 'Bash(git:*)'],
  disallowed_tools: ['AskUserQuestion'],
  session_id: 'sid-1',
  append_system_prompt: 'guard',
  max_turns: 7,
  model: 'opus',
};

describe('claude adapter command', () => {
  it('builds the verified command line', () => {
    const { command, args } = claudeAdapter.buildCommand(account, spec);
    expect(command).toBe('/bin/launcher');
    expect(args).toEqual([
      '-p',
      'do it',
      '--session-id',
      'sid-1',
      '--append-system-prompt',
      'guard',
      '--disallowedTools',
      'AskUserQuestion',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--max-turns',
      '7',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Read',
      'Bash(git:*)',
      '--model',
      'opus',
    ]);
  });

  it('uses --resume and omits optional flags', () => {
    const { args } = claudeAdapter.buildCommand(account, {
      ...spec,
      resume: true,
      allowed_tools: [],
      max_turns: undefined,
      model: undefined,
    });
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('bypassPermissions');
  });
});

describe('claude adapter env', () => {
  it('keeps only allowlisted variables and sets profile and depth', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/bin',
      HOME: '/h',
      LC_ALL: 'C',
      https_proxy: 'http://proxy',
      NO_PROXY: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'a',
      CLAUDECODE: '1',
      CLAUDE_CONFIG_DIR: '/caller',
      ANTHROPIC_API_KEY: 'b',
      GITHUB_TOKEN: 'c',
      WINGMAN_DEPTH: '0',
      WINGMAN_HOME: '/w',
    };
    const env = claudeAdapter.buildEnv(parent, account, 1);
    expect(Object.keys(env).sort()).toEqual(
      [
        'CLAUDE_CONFIG_DIR',
        'HOME',
        'LC_ALL',
        'NO_PROXY',
        'PATH',
        'WINGMAN_DEPTH',
        'https_proxy',
      ].sort(),
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg/b');
    expect(env.WINGMAN_DEPTH).toBe('1');
  });
});

describe('claude adapter parseLine', () => {
  const p = (o: unknown): ReturnType<typeof claudeAdapter.parseLine> =>
    claudeAdapter.parseLine(typeof o === 'string' ? o : JSON.stringify(o));

  it('maps init, assistant, rate limit and result', () => {
    expect(p({ type: 'system', subtype: 'init', session_id: 's' })).toEqual([
      { kind: 'started', session_id: 's' },
    ]);
    expect(
      p({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', name: 'Edit' },
          ],
        },
      }),
    ).toEqual([
      { kind: 'message', text: 'hi' },
      { kind: 'tool', name: 'Edit' },
    ]);
    expect(
      p({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 5, utilization: 0.9 },
      }),
    ).toEqual([
      { kind: 'rate_limited', info: { status: 'rejected', resetsAt: 5, utilization: 0.9 } },
    ]);
    expect(
      p({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        permission_denials: [{ tool_name: 'Bash' }, { x: 1 }],
      }),
    ).toEqual([{ kind: 'finished', result: 'ok', is_error: false, permission_denials: ['Bash'] }]);
    expect(p({ type: 'result', subtype: 'error_max_turns' })).toEqual([
      { kind: 'finished', result: null, is_error: true, permission_denials: [] },
    ]);
  });

  it('ignores hooks, unknown and malformed lines without throwing', () => {
    expect(p({ type: 'system', subtype: 'hook_started' })).toEqual([]);
    expect(p({ type: 'weird' })).toEqual([]);
    expect(p('not json')).toEqual([]);
    expect(p('null')).toEqual([]);
    expect(p('[1]')).toEqual([]);
    expect(p({ type: 'assistant', message: 5 })).toEqual([]);
    expect(p({ type: 'rate_limit_event' })).toEqual([]);
  });

  it('treats only non-allowed statuses as rejections', () => {
    expect(isRateLimitRejected({ status: 'allowed' })).toBe(false);
    expect(isRateLimitRejected({ status: 'allowed_warning' })).toBe(false);
    expect(isRateLimitRejected({})).toBe(false);
    expect(isRateLimitRejected({ status: 'rejected' })).toBe(true);
  });
});

describe('guard', () => {
  it('prompt carries the mandatory rules', () => {
    const text = guardPrompt();
    expect(text).toMatch(/sensitive/i);
    expect(text).toMatch(/base branch/i);
    expect(text).toMatch(/WINGMAN_STATUS: needs_input/);
    expect(text).toMatch(/WINGMAN_STATUS: done/);
  });

  it('os-apply preset and base deny list', () => {
    expect(PRESETS['os-apply'].allowed).toEqual([
      'Agent',
      'Skill',
      'Edit',
      'Write',
      'Read',
      'Bash(git:*)',
      'Bash(node:*)',
      'Bash(openspec:*)',
      'Bash(date:*)',
    ]);
    const deny = baseDisallowed();
    for (const name of [
      'AskUserQuestion',
      'Bash(git push:*)',
      'Bash(claude:*)',
      'Bash(claude plugin:*)',
      'Bash(npm install -g:*)',
      'mcp__plugin_wingman_*',
      'mcp__wingman__*',
    ]) {
      expect(deny).toContain(name);
    }
  });

  it('explicit allowed_tools replaces the preset but never the deny list', () => {
    const r = resolveTools({ preset: 'os-apply', allowed_tools: ['Read', 'Bash(git push:*)'] });
    expect(r.allowed).toEqual(['Read']);
    expect(r.disallowed).toEqual(baseDisallowed());
    expect(resolveTools({ preset: 'os-apply' }).allowed).toContain('Skill');
    expect(resolveTools({}).allowed).toEqual([]);
    expect(() => resolveTools({ preset: 'nope' })).toThrow(/Unknown preset/);
  });

  it('parses the last valid status line', () => {
    expect(parseStatusLine('x\nWINGMAN_STATUS: partial\nmore\nWINGMAN_STATUS: done\n')).toBe(
      'done',
    );
    expect(parseStatusLine('WINGMAN_STATUS: bogus')).toBeNull();
    expect(parseStatusLine('no status here')).toBeNull();
    expect(parseStatusLine('a WINGMAN_STATUS: done inline')).toBeNull();
  });
});
