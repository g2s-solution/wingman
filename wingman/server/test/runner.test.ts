import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runDir, worktreesDir } from '../src/paths.js';
import { readMeta, runSummary, writeMeta } from '../src/runs.js';
import {
  cancelRun,
  mapOutcome,
  startRun,
  waitForRun,
  type StartRunOptions,
} from '../src/runner.js';
import { isAlive } from '../src/worktree.js';
import { groupMembers } from '../src/proc.js';
import { reconcile } from '../src/reconcile.js';
import type { RunMeta } from '../src/types.js';
import {
  bundleSupervisor,
  git,
  makeAccount,
  makeLauncher,
  makeRepo,
  readLog,
  tmp,
} from './helpers.js';

let work: string;
let entry: string;
let home: string;
let saved: string | undefined;
const parentEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...extra,
});
const noSleep = (): Promise<void> => Promise.resolve();

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

interface Ctx {
  log: string;
  opts: StartRunOptions;
}

function ctx(mode: string, extra: Partial<StartRunOptions> = {}, extraExports = ''): Ctx {
  const log = join(work, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  const launcher = makeLauncher(work, mode, log, extraExports);
  const opts: StartRunOptions = {
    account: makeAccount(launcher, join(home, 'cfg-target')),
    prompt: 'do the thing',
    cwd: tmp('cwd'),
    parentEnv: parentEnv(),
    supervisorEntry: entry,
    preset: 'edit',
    ...extra,
  };
  return { log, opts };
}

async function finish(meta: RunMeta, timeoutMs = 20000): Promise<RunMeta> {
  return waitForRun(meta.id, { timeoutMs, pollMs: 50 });
}

describe('status mapping', () => {
  it('normal finish: done, result.md written, events teed to events.jsonl', async () => {
    const { opts, log } = ctx('ok');
    const started = await startRun(opts);
    expect(started.status).toBe('running');
    expect(started.depth).toBe(1);
    const meta = await finish(started);
    expect(meta.status).toBe('done');
    expect(meta.exit_code).toBe(0);
    expect(runSummary(meta.id).result).toMatch(/Implemented the change/);
    const events = readFileSync(join(runDir(meta.id), 'events.jsonl'), 'utf8');
    expect(events).toContain('"type":"result"');
    const argv = readLog(log)[0]!.argv;
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(meta.session_id);
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('--permission-prompts');
    expect(meta.rate_limit?.status).toBe('allowed');
  });

  it('nonzero exit with a result maps to failed', async () => {
    const meta = await finish(await startRun(ctx('nonzero').opts));
    expect(meta.status).toBe('failed');
    expect(meta.exit_code).toBe(1);
    const events = readFileSync(join(runDir(meta.id), 'events.jsonl'), 'utf8');
    expect(events).toContain('"type":"stderr"');
  });

  it('timeout kills a hung child and maps to failed', async () => {
    const { opts } = ctx('hang', { timeout_ms: 600 });
    const meta = await finish(await startRun(opts));
    expect(meta.status).toBe('failed');
    expect(runSummary(meta.id).result).toMatch(/time limit/);
  });

  it('rejected rate limit maps to rate_limited and records the info', async () => {
    const meta = await finish(await startRun(ctx('rate_limit').opts));
    expect(meta.status).toBe('rate_limited');
    expect(meta.rate_limit).toMatchObject({
      status: 'rejected',
      resetsAt: 1900000000,
      rateLimitType: 'five_hour',
    });
  });

  it('no result message maps to failed_no_report', async () => {
    const meta = await finish(await startRun(ctx('no_result').opts));
    expect(meta.status).toBe('failed_no_report');
  });

  it('missing status line maps to needs_input', async () => {
    const meta = await finish(await startRun(ctx('no_status_line').opts));
    expect(meta.status).toBe('needs_input');
  });

  it('a plugin update in the result maps to needs_caller', async () => {
    const meta = await finish(await startRun(ctx('plugin_update').opts));
    expect(meta.status).toBe('needs_caller');
  });

  it('records unique permission denial tool names', async () => {
    const meta = await finish(await startRun(ctx('permission_denial').opts));
    expect(meta.status).toBe('partial');
    expect(meta.permission_denials).toEqual(['Bash', 'WebFetch']);
  });
});

describe('process hygiene (M5)', () => {
  it('finalizes on exit without waiting for a grandchild that holds the pipes, then reaps it', async () => {
    const gcFile = join(work, `gc-${Math.random().toString(16).slice(2)}.pid`);
    const { opts } = ctx('grandchild', {}, `export FAKE_GC_PID=${gcFile}`);
    const t0 = Date.now();
    const meta = await finish(await startRun(opts), 15000);
    expect(meta.status).toBe('done');
    expect(Date.now() - t0).toBeLessThan(10000);
    const gc = Number(readFileSync(gcFile, 'utf8'));
    const deadline = Date.now() + 5000;
    while (isAlive(gc) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(gc)).toBe(false);
  });

  it('a received result wins over timedOut and the kill-caused exit code', () => {
    const out = mapOutcome({
      finished: { result: 'Done.\nWINGMAN_STATUS: done', is_error: false },
      exitCode: 143,
      signal: null,
      timedOut: true,
      rateRejected: false,
    });
    expect(out.status).toBe('done');
    expect(
      mapOutcome({
        finished: undefined,
        exitCode: 143,
        signal: null,
        timedOut: true,
        rateRejected: false,
      }).status,
    ).toBe('failed');
  });
});

describe('cancel', () => {
  it('kills the process group and marks the run cancelled', async () => {
    const started = await startRun(ctx('hang').opts);
    await new Promise((r) => setTimeout(r, 400));
    const res = await cancelRun(started.id);
    expect(res).toMatchObject({ cancelled: true, killed: true });
    const meta = await finish(started);
    expect(meta.status).toBe('cancelled');
    expect(isAlive(started.pid as number)).toBe(false);
  });

  it('does not kill when the recorded start time does not match the pid', async () => {
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const started = await startRun(ctx('ok').opts);
      await finish(started);
      const meta = createRunning(started, bystander.pid as number, '1');
      const res = await cancelRun(meta.id);
      expect(res.cancelled).toBe(false);
      expect(res.killed).toBe(false);
      expect(res.reason).toMatch(/failed_no_report/);
      expect(isAlive(bystander.pid as number)).toBe(true);
      expect(readMeta(meta.id).status).toBe('failed_no_report');
    } finally {
      bystander.kill('SIGKILL');
    }
  });
});

function createRunning(from: RunMeta, pid: number, startTime: string): RunMeta {
  const meta = readMeta(from.id);
  const forged: RunMeta = { ...meta, status: 'running', pid, pid_start_time: startTime };
  delete forged.finished_at;
  writeMeta(forged);
  return forged;
}

describe('environment and secrets', () => {
  it('drops CLAUDE_CODE_*, ANTHROPIC_*, tokens and keeps proxies; credential never lands in run files', async () => {
    const cred = ['sk', 'ant', 'oat01', 'AAAABBBBCCCCDDDD1234'].join('-');
    const { opts, log } = ctx('ok', {
      parentEnv: parentEnv({
        CLAUDE_CODE_OAUTH_TOKEN: cred,
        CLAUDE_CODE_ENTRYPOINT: 'desktop',
        CLAUDECODE: '1',
        ANTHROPIC_API_KEY: cred,
        GITHUB_TOKEN: cred,
        CLAUDE_CONFIG_DIR: '/caller/profile',
        HTTPS_PROXY: 'http://proxy.example:3128',
        no_proxy: 'localhost',
        LANG: 'C.UTF-8',
        LC_ALL: 'C',
      }),
    });
    const meta = await finish(await startRun(opts));
    expect(meta.status).toBe('done');
    const names = readLog(log)[0]!.env_names;
    for (const gone of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDECODE',
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'WINGMAN_HOME',
    ]) {
      expect(names).not.toContain(gone);
    }
    for (const kept of [
      'PATH',
      'HOME',
      'HTTPS_PROXY',
      'no_proxy',
      'LANG',
      'LC_ALL',
      'WINGMAN_DEPTH',
      'CLAUDE_CONFIG_DIR',
    ]) {
      expect(names).toContain(kept);
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(home);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain(cred);
  });

  it('the launcher can add the credential and only then does the child see it', async () => {
    const { opts, log } = ctx('ok', {}, 'export CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    await finish(await startRun(opts));
    expect(readLog(log)[0]!.env_names).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('child output goes to events.jsonl only: supervisor stdout and stderr are that file, no pipe', async () => {
    const started = await startRun(ctx('hang').opts);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const pid = started.pid as number;
      const events = join(runDir(started.id), 'events.jsonl');
      expect(readlinkSync(`/proc/${pid}/fd/1`)).toBe(events);
      expect(readlinkSync(`/proc/${pid}/fd/2`)).toBe(events);
      expect(statSync(events).mode & 0o777).toBe(0o600);
      expect(readFileSync(events, 'utf8')).toContain('"subtype":"init"');
    } finally {
      await cancelRun(started.id);
    }
  });
});

describe('guards', () => {
  it('refuses recursion at depth 1', async () => {
    const { opts } = ctx('ok', { parentEnv: parentEnv({ WINGMAN_DEPTH: '1' }) });
    await expect(startRun(opts)).rejects.toThrow(/nested run/);
    expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')) : []).toEqual([]);
  });

  it('delivers a prompt that looks like a flag as the prompt, after `--`', async () => {
    const prompt = '--dangerously-skip-permissions';
    const { opts, log } = ctx('ok', { prompt });
    await finish(await startRun(opts));
    const argv = readLog(log)[0]!.argv;
    expect(argv.slice(-2)).toEqual(['--', prompt]);
    expect(argv.slice(0, -2)).not.toContain(prompt);
  });

  it('passes depth+1 and the base deny list to the child', async () => {
    const { opts, log } = ctx('ok');
    await finish(await startRun(opts));
    const rec = readLog(log)[0]!;
    const denied = rec.argv.slice(rec.argv.indexOf('--disallowedTools') + 1);
    expect(denied).toContain('AskUserQuestion');
    expect(denied).toContain('mcp__plugin_wingman_*');
    expect(rec.argv.join(' ')).not.toContain('bypassPermissions');
  });
});

describe('worktree runs', () => {
  it('an edit run on the base branch gets a wingman/<id> branch and leaves main alone', async () => {
    const repo = makeRepo('main');
    const mainHead = git(repo, 'rev-parse', 'main');
    const { opts } = ctx('ok', { cwd: repo, worktree: true });
    const started = await startRun(opts);
    expect(started.run_branch).toBe(`wingman/${started.id}`);
    expect((await finish(started)).status).toBe('done');
    expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('a readonly run gets a detached worktree and no run branch', async () => {
    const repo = makeRepo('main');
    const branches = git(repo, 'branch', '--format=%(refname:short)');
    const { opts } = ctx('ok', { cwd: repo, worktree: true, preset: 'readonly' });
    const started = await startRun(opts);
    expect(started.worktree).toBeDefined();
    expect(started.run_branch).toBeUndefined();
    expect((await finish(started)).status).toBe('done');
    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe(branches);
  });

  it('runs inside a worktree cut from the caller HEAD and locks the change', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/run');
    const { opts, log } = ctx('hang', {
      cwd: join(repo, 'sub'),
      worktree: true,
      lock_key: 'add-thing',
      sleep: noSleep,
    });
    const first = await startRun(opts);
    try {
      expect(first.branch).toBe('feat/run');
      expect(first.run_branch).toBe(`feat/run-wm-${first.id}`);
      expect(first.worktree).toBe(join(worktreesDir(), first.id));
      await new Promise((r) => setTimeout(r, 400));
      const rec = readLog(log)[0]!;
      expect(rec.cwd).toBe(join(first.worktree as string, 'sub'));
      await expect(startRun({ ...opts, sleep: noSleep })).rejects.toThrow(/already held/);
    } finally {
      await cancelRun(first.id);
    }
  });
});

describe('waitForRun', () => {
  it('marks a run failed_no_report when its supervisor died without finalizing', async () => {
    const started = await startRun(ctx('ok').opts);
    await finish(started);
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => dead.on('exit', r));
    const forged = createRunning(started, dead.pid as number, '1');
    const meta = await waitForRun(forged.id, { timeoutMs: 2000, pollMs: 20 });
    expect(meta.status).toBe('failed_no_report');
  });

  it('times out while a run is still going', async () => {
    const started = await startRun(ctx('hang').opts);
    try {
      await expect(waitForRun(started.id, { timeoutMs: 150, pollMs: 20 })).rejects.toThrow(
        /Timed out/,
      );
    } finally {
      await cancelRun(started.id);
    }
  });
});

async function until(cond: () => boolean, what: string, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('agent outliving a killed supervisor', () => {
  it('reconcile takes down the orphaned process group', async () => {
    const started = await startRun(ctx('hang').opts);
    const pid = started.pid as number;
    await until(() => groupMembers(pid).length >= 2, 'supervisor and agent in the group');
    // the agent writes to a pipe to the supervisor: killing it mid-startup would EPIPE the agent
    const events = join(runDir(started.id), 'events.jsonl');
    await until(
      () => existsSync(events) && readFileSync(events, 'utf8').includes('"type":"assistant"'),
      'the agent to be idle after its first output',
    );
    process.kill(pid, 'SIGKILL'); // only the supervisor: the agent stays in its group
    await until(() => !isAlive(pid), 'the killed supervisor to be reaped');
    expect(groupMembers(pid).length).toBeGreaterThan(0);

    expect(reconcile(readMeta(started.id)).status).toBe('failed_no_report');
    await until(() => groupMembers(pid).length === 0, 'the orphaned group to be gone');
  }, 90_000);
});
