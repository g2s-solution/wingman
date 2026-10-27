import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), '../../hooks');
const read = (name: string): unknown => JSON.parse(readFileSync(join(hooksDir, name), 'utf8'));
const command = `sh -c '[ -n "\${WINGMAN_DEPTH:-}" ] || cat "\${CLAUDE_PLUGIN_ROOT}/hooks/session-start.json"'`;

describe('plugin SessionStart hook', () => {
  it('only prints a static file from the plugin directory', () => {
    const hooks = read('hooks.json') as {
      hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] };
    };
    const entries = hooks.hooks.SessionStart.flatMap((group) => group.hooks);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('command');
    expect(entries[0]?.command).toBe(command);
  });

  it('prints the instruction outside a run and nothing inside one', () => {
    const root = join(hooksDir, '..');
    const run = (env: NodeJS.ProcessEnv): string =>
      execFileSync('sh', ['-c', command], { env, encoding: 'utf8' });
    const base = { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: root };
    expect(run(base)).toContain('wingman:new-agent');
    expect(run({ ...base, WINGMAN_DEPTH: '1' })).toBe('');
  });

  it('injects the instruction to prefer the new-agent skill', () => {
    const out = read('session-start.json') as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text = out.hookSpecificOutput.additionalContext;
    expect(text).toContain('wingman:new-agent');
    expect(text).toMatch(/instead of the built-in Agent tool/);
    expect(text.length).toBeLessThan(1500);
  });
});
