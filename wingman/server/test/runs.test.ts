import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  createRun,
  listRuns,
  newRunId,
  pruneEvents,
  readMeta,
  runSummary,
  updateStatus,
  writeResult,
} from '../src/runs.js';
import { runDir, runsDir } from '../src/paths.js';

const base = {
  account: 'acct',
  cwd: '/tmp/x',
  branch: 'feat/a',
  run_branch: 'wingman/run',
  session_id: 's1',
  depth: 1,
  prompt_chars: 10,
};

describe('runs', () => {
  const saved = process.env.WINGMAN_HOME;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wm-runs-'));
    process.env.WINGMAN_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WINGMAN_HOME;
    else process.env.WINGMAN_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('generates 12 hex char ids', () => {
    expect(newRunId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('creates a running run with 0700 dirs and 0600 files', () => {
    const meta = createRun(base);
    expect(meta.status).toBe('running');
    expect(statSync(runsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(runDir(meta.id)).mode & 0o777).toBe(0o700);
    appendEvent(meta.id, '{"a":1}');
    writeResult(meta.id, 'hi');
    for (const f of ['meta.json', 'events.jsonl', 'result.md']) {
      expect(statSync(join(runDir(meta.id), f)).mode & 0o777).toBe(0o600);
    }
  });

  it('round-trips meta and rejects invalid meta', () => {
    const meta = createRun(base);
    expect(readMeta(meta.id)).toEqual(meta);
    writeFileSync(join(runDir(meta.id), 'meta.json'), '{"id":"x"}');
    expect(() => readMeta(meta.id)).toThrow();
  });

  it('rejects path-like run ids', () => {
    expect(() => readMeta('../etc')).toThrow(/invalid run id/);
  });

  it('writes meta atomically, leaving no temp files', () => {
    const meta = createRun(base);
    for (let i = 0; i < 5; i++) updateStatus(meta.id, 'running', { pid: i });
    writeResult(meta.id, 'r');
    pruneEvents(meta.id, 10);
    expect(readdirSync(runDir(meta.id)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readMeta(meta.id).pid).toBe(4);
  });

  it('keeps terminal status sticky', () => {
    const meta = createRun(base);
    const done = updateStatus(meta.id, 'done');
    expect(done.finished_at).toBeTruthy();
    expect(() => updateStatus(meta.id, 'running')).toThrow(/already done/);
    expect(() => updateStatus(meta.id, 'failed')).toThrow();
    expect(updateStatus(meta.id, 'done', { exit_code: 0 }).exit_code).toBe(0);
    expect(readMeta(meta.id).status).toBe('done');
  });

  it('allows non-terminal to terminal transitions', () => {
    const meta = createRun(base);
    expect(updateStatus(meta.id, 'rate_limited').status).toBe('rate_limited');
  });

  it('lists runs, newest first, skipping junk', () => {
    const a = createRun(base);
    const b = createRun(base);
    writeFileSync(join(runsDir(), 'stray'), 'x');
    const ids = listRuns().map((m) => m.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it('listRuns is empty when no runs dir exists', () => {
    expect(listRuns()).toEqual([]);
  });

  it('retention keeps the tail of events.jsonl on whole lines', () => {
    const meta = createRun(base);
    const lines = Array.from({ length: 50 }, (_, i) => `{"n":${String(i).padStart(3, '0')}}`);
    for (const l of lines) appendEvent(meta.id, l);
    const path = join(runDir(meta.id), 'events.jsonl');
    pruneEvents(meta.id, 100);
    const kept = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)).toBe(lines.at(-1));
    expect(kept).toEqual(lines.slice(lines.length - kept.length));
    expect(statSync(path).size).toBeLessThanOrEqual(100);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('retention is a no-op below the limit and tolerates a missing file', () => {
    const meta = createRun(base);
    pruneEvents(meta.id, 100);
    appendEvent(meta.id, '{"a":1}');
    pruneEvents(meta.id, 1000);
    expect(readFileSync(join(runDir(meta.id), 'events.jsonl'), 'utf8')).toBe('{"a":1}\n');
  });

  it('never returns events.jsonl content from runSummary or anything else', () => {
    const meta = createRun(base);
    const marker = 'RAW_TOOL_OUTPUT_' + 'q'.repeat(12);
    appendEvent(
      meta.id,
      JSON.stringify({ tool_result: marker, extra: 'sk-ant-' + 'x'.repeat(30) }),
    );
    appendFileSync(join(runDir(meta.id), 'events.jsonl'), `${marker}\n`);
    writeResult(meta.id, 'Final report only');
    updateStatus(meta.id, 'done');
    const out = JSON.stringify([runSummary(meta.id), readMeta(meta.id), listRuns()]);
    expect(out).not.toContain(marker);
    expect(out).not.toContain('sk-ant');
    expect(runSummary(meta.id).result).toBe('Final report only');
  });

  it('summary exposes only the allowed fields', () => {
    const meta = createRun({ ...base, cwd: '/secret/cwd', change: 'c', preset: 'p' });
    updateStatus(meta.id, 'rate_limited', {
      permission_denials: ['Bash'],
      rate_limit: { status: 'limited', resetsAt: 5 },
    });
    const s = runSummary(meta.id);
    expect(Object.keys(s).sort()).toEqual(
      [
        'account',
        'branch',
        'created_at',
        'finished_at',
        'id',
        'permission_denials',
        'rate_limit',
        'result',
        'run_branch',
        'status',
      ].sort(),
    );
    expect(s.result).toBeNull();
    expect(JSON.stringify(s)).not.toContain('/secret/cwd');
  });

  it('masks and caps result.md in the summary', () => {
    const meta = createRun(base);
    writeResult(meta.id, `done\npassword=hunter2x\n${'y'.repeat(5000)}`);
    const r = runSummary(meta.id).result ?? '';
    expect(r).toContain('password=[MASKED]');
    expect(r).not.toContain('hunter2x');
    expect(r).toContain('[truncated');
    expect(r.length).toBeLessThan(4100);
  });
});
