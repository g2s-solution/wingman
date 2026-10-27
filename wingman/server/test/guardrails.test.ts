import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMeta, runSummary } from '../src/runs.js';
import {
  flagGuardrail,
  mapOutcome,
  reportsPluginChange,
  startRun,
  waitForRun,
} from '../src/runner.js';
import type { StartRunOptions } from '../src/runner.js';
import { createHandlers } from '../src/tools.js';
import { saveAccounts } from '../src/registry.js';
import { bundleSupervisor, git, makeAccount, makeLauncher, makeRepo, tmp } from './helpers.js';

let work: string;
let entry: string;
let home: string;
let saved: string | undefined;
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME });

beforeAll(async () => {
  work = tmp('bundle');
  entry = await bundleSupervisor(work);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => {
  saved = process.env.WINGMAN_HOME;
  home = tmp('home');
  process.env.WINGMAN_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

function opts(mode: string, extra: Partial<StartRunOptions>, exports = ''): StartRunOptions {
  const log = join(work, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  return {
    account: makeAccount(makeLauncher(work, mode, log, exports), join(home, 'cfg-target')),
    prompt: 'do it',
    cwd: tmp('cwd'),
    parentEnv: env(),
    supervisorEntry: entry,
    preset: 'edit',
    sleep: () => Promise.resolve(),
    ...extra,
  };
}

function featureRepo(): { repo: string; callerHead: string; mainHead: string } {
  const repo = makeRepo('main');
  const mainHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'feat/g');
  writeFileSync(join(repo, 'b.txt'), 'b');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'caller');
  return { repo, callerHead: git(repo, 'rev-parse', 'HEAD'), mainHead };
}

const settle = (id: string) => waitForRun(id, { timeoutMs: 20000, pollMs: 50 });

describe('ref snapshot', () => {
  it('records a snapshot and a normal run stays done', async () => {
    const { repo } = featureRepo();
    const started = await startRun(opts('ok', { cwd: repo, worktree: true }));
    expect(started.ref_snapshot?.refs).toContain('refs/heads/main');
    expect(started.ref_snapshot?.refs).toContain('refs/heads/feat/g');
    expect(started.ref_snapshot?.refs_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await settle(started.id)).status).toBe('done');
  });

  it('moving the base branch maps a done run to needs_caller with a note', async () => {
    const { repo, callerHead } = featureRepo();
    const exports = `export FAKE_REF_REPO=${repo} FAKE_REF_NAME=main FAKE_REF_TARGET=${callerHead}`;
    const started = await startRun(opts('move_ref', { cwd: repo, worktree: true }, exports));
    const meta = await settle(started.id);
    expect(meta.status).toBe('needs_caller');
    expect(runSummary(meta.id).result).toMatch(/guardrail: the base branch or caller branch ref/);
    expect(readMeta(meta.id).run_branch).toBeTruthy();
  });

  it('moving the caller branch ref maps to needs_caller', async () => {
    const { repo, mainHead } = featureRepo();
    const exports = `export FAKE_REF_REPO=${repo} FAKE_REF_NAME=feat/g FAKE_REF_TARGET=${mainHead}`;
    const meta = await settle(
      (await startRun(opts('move_ref', { cwd: repo, worktree: true }, exports))).id,
    );
    expect(meta.status).toBe('needs_caller');
  });

  it('creating the run branch alone is fine, but editing local config is flagged', async () => {
    const { repo } = featureRepo();
    const exports = `export FAKE_REF_REPO=${repo}`;
    const meta = await settle(
      (await startRun(opts('edit_config', { cwd: repo, worktree: true }, exports))).id,
    );
    expect(meta.status).toBe('needs_caller');
    expect(runSummary(meta.id).result).toMatch(/local git config/);
  });

  it('flagGuardrail keeps failure statuses and appends the note', () => {
    expect(flagGuardrail({ status: 'failed', text: 'x' }, ['refs']).status).toBe('failed');
    expect(flagGuardrail({ status: 'partial', text: 'x' }, ['config']).status).toBe('needs_caller');
  });
});

describe('start on a base branch or detached HEAD (M4)', () => {
  it('refuses on the base branch only without a worktree', async () => {
    const repo = makeRepo('main');
    await expect(startRun(opts('ok', { cwd: repo, worktree: false }))).rejects.toThrow(
      /base branch/,
    );
    await expect(startRun(opts('ok', { cwd: repo, worktree: undefined }))).rejects.toThrow(
      /base branch/,
    );
    const onBase = await startRun(opts('ok', { cwd: repo, worktree: true }));
    expect((await settle(onBase.id)).status).toBe('done');
    git(repo, 'checkout', '-q', '--detach');
    await expect(startRun(opts('ok', { cwd: repo, worktree: false }))).rejects.toThrow(/detached/);
    git(repo, 'switch', '-q', '-c', 'feat/ok');
    const started = await startRun(opts('ok', { cwd: repo, worktree: false }));
    expect((await settle(started.id)).status).toBe('done');
  });

  it('the tool refuses worktree:false on the base branch', async () => {
    const repo = makeRepo('main');
    const callerDir = join(home, 'cfg-caller');
    const o = opts('ok', {});
    await saveAccounts({ accounts: [o.account] });
    const h = createHandlers({ env: { ...env(), CLAUDE_CONFIG_DIR: callerDir } });
    await expect(
      h.start({ account: 'target', prompt: 'x', cwd: repo, worktree: false }),
    ).rejects.toThrow(/base branch/);
  });
});

describe('run branch rules', () => {
  it('a slashed caller branch gets <branch>-wm-<id> and a branch from a feature branch is not wingman/', async () => {
    const { repo } = featureRepo();
    const started = await startRun(opts('ok', { cwd: repo, worktree: true }));
    expect(started.run_branch).toBe(`feat/g-wm-${started.id}`);
    expect((await settle(started.id)).status).toBe('done');
  });

  it('branch:false is refused for a run that may commit, and the readonly default needs no branch', async () => {
    const { repo } = featureRepo();
    await expect(
      startRun(opts('ok', { cwd: repo, worktree: true, create_branch: false })),
    ).rejects.toThrow(/cannot commit/);
    await expect(
      startRun(
        opts('ok', {
          cwd: repo,
          worktree: true,
          preset: 'readonly',
          allowed_tools: ['Read'],
          create_branch: false,
        }),
      ),
    ).rejects.toThrow(/cannot commit/);
    const ro = await startRun(opts('ok', { cwd: repo, worktree: true, preset: 'readonly' }));
    expect(ro.run_branch).toBeUndefined();
    expect((await settle(ro.id)).status).toBe('done');
  });

  it('create_branch:true gives a readonly run a branch, and explicit allowed_tools imply one', async () => {
    const { repo } = featureRepo();
    const forced = await startRun(
      opts('ok', { cwd: repo, worktree: true, preset: 'readonly', create_branch: true }),
    );
    expect(forced.run_branch).toBe(`feat/g-wm-${forced.id}`);
    const tools = await startRun(
      opts('ok', { cwd: repo, worktree: true, preset: 'readonly', allowed_tools: ['Read'] }),
    );
    expect(tools.run_branch).toBe(`feat/g-wm-${tools.id}`);
    await settle(forced.id);
    await settle(tools.id);
  });

  it('a detached HEAD is refused even with a worktree', async () => {
    const { repo } = featureRepo();
    git(repo, 'checkout', '-q', '--detach');
    await expect(startRun(opts('ok', { cwd: repo, worktree: true }))).rejects.toThrow(/detached/);
  });

  it('an existing branch named wingman makes the start fail with a clear git error and no leftovers', async () => {
    const repo = makeRepo('main');
    git(repo, 'branch', 'wingman');
    await expect(
      startRun(opts('ok', { cwd: repo, worktree: true, lock_key: 'k1' })),
    ).rejects.toThrow(/git worktree add failed/);
    const retry = await startRun(
      opts('ok', { cwd: repo, worktree: true, preset: 'readonly', lock_key: 'k1' }),
    );
    expect((await settle(retry.id)).status).toBe('done');
  });

  it('wingman_cleanup on a detached run omits kept_branch', async () => {
    const { repo } = featureRepo();
    const callerDir = join(home, 'cfg-caller');
    const o = opts('ok', {});
    await saveAccounts({ accounts: [o.account] });
    const h = createHandlers({
      env: { ...env(), CLAUDE_CONFIG_DIR: callerDir },
      supervisorEntry: entry,
    });
    const started = (await h.start({
      account: 'target',
      prompt: 'x',
      cwd: repo,
      preset: 'readonly',
    })) as { run_id: string; run_branch?: string };
    expect(started.run_branch).toBeUndefined();
    await settle(started.run_id);
    const cleaned = (await h.cleanup({ run_id: started.run_id, action: 'accept' })) as Record<
      string,
      unknown
    >;
    expect(cleaned.worktree_removed).toBe(true);
    expect(cleaned).not.toHaveProperty('kept_branch');
  });
});

describe('outcome mapping', () => {
  const base = { exitCode: 0, signal: null, timedOut: false, rateRejected: false };
  it('error_max_turns maps to partial, even with a nonzero exit', () => {
    const out = mapOutcome({
      ...base,
      exitCode: 1,
      finished: { result: null, is_error: true, max_turns: true },
    });
    expect(out.status).toBe('partial');
    expect(out.text).toMatch(/turn limit/);
  });

  it('plugin change needs an explicit command or claude in the same sentence', () => {
    expect(reportsPluginChange('I ran claude plugin install foo')).toBe(true);
    expect(reportsPluginChange('claude plugins uninstall bar was needed')).toBe(true);
    expect(reportsPluginChange('Claude Code said the plugin updated itself.')).toBe(true);
    expect(reportsPluginChange('The plugin updated the docs.\nClaude was fine.')).toBe(false);
    expect(reportsPluginChange('I installed a plugin directory listing and updated tests.')).toBe(
      false,
    );
    expect(reportsPluginChange('plugin was updated')).toBe(false);
  });
});
