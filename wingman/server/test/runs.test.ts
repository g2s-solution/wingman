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
  pruneOldEvents,
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

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

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
    const meta = createRun({ ...base, cwd: '/secret/cwd', lock_key: 'c', preset: 'p' });
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

  it('masks result.md and returns the first page with the paging fields', () => {
    const meta = createRun(base);
    writeResult(meta.id, `done\npassword=hunter2x\n${'y'.repeat(5000)}`);
    const s = runSummary(meta.id);
    const r = s.result ?? '';
    expect(r).toContain('password=[MASKED]');
    expect(r).not.toContain('hunter2x');
    expect(r.length).toBe(4000);
    expect(s.result_offset).toBe(0);
    expect(s.result_next_offset).toBe(4000);
    expect(s.result_total_chars).toBeGreaterThan(5000);
  });

  it('pages through the whole report and the pages join back to the masked text', () => {
    const meta = createRun(base);
    const text = `start\n${'abcdefghij'.repeat(1500)}\nend-marker`;
    writeResult(meta.id, text);
    let joined = '';
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const s = runSummary(meta.id, { offset, limit: 3000 });
      joined += s.result ?? '';
      offset = s.result_next_offset;
      pages += 1;
      expect(pages).toBeLessThan(20);
    }
    expect(joined).toBe(text);
    expect(pages).toBe(Math.ceil(text.length / 3000));
  });

  it('masks before slicing: a secret across a page boundary never shows', () => {
    const meta = createRun(base);
    const secret = ['sk', 'ant', 'oat01', 'A'.repeat(40)].join('-');
    const head = `${'x'.repeat(989)} `;
    writeResult(meta.id, `${head}${secret}${'z'.repeat(100)}`);
    const first = runSummary(meta.id, { offset: 0, limit: 1000 });
    const second = runSummary(meta.id, { offset: first.result_next_offset ?? 0, limit: 1000 });
    for (const page of [first, second]) {
      expect(page.result).not.toContain('AAAAAAAA');
      expect(page.result).not.toContain('oat01');
    }
  });

  it('pages emoji with limit 1 to the end: every page advances and the pages join back', () => {
    const meta = createRun(base);
    const text = `a\u{1F600}b\u{1F680}\u{1F600}`;
    writeResult(meta.id, text);
    let joined = '';
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const s = runSummary(meta.id, { offset, limit: 1 });
      expect(s.result?.length).toBeGreaterThan(0);
      if (s.result_next_offset !== undefined) {
        expect(s.result_next_offset).toBeGreaterThan(s.result_offset ?? 0);
      }
      // no page ends or starts in the middle of a pair
      expect(s.result).not.toMatch(LONE_SURROGATE);
      joined += s.result ?? '';
      offset = s.result_next_offset;
      pages += 1;
      expect(pages).toBeLessThan(20);
    }
    expect(joined).toBe(text);
  });

  it('clamps limit and offset and omits next_offset on the last page', () => {
    const meta = createRun(base);
    writeResult(meta.id, 'q'.repeat(100));
    const huge = runSummary(meta.id, { limit: 10_000_000 });
    expect(huge.result?.length).toBe(100);
    expect(huge.result_next_offset).toBeUndefined();
    const past = runSummary(meta.id, { offset: 5000 });
    expect(past.result).toBe('');
    expect(past.result_offset).toBe(100);
    expect(past.result_next_offset).toBeUndefined();
  });

  it('keeps hooks_hash in the snapshot and still reads a meta that has none', () => {
    const snap = { refs: ['refs/heads/main'], refs_hash: 'a', config_hash: 'b' };
    const old = createRun({ ...base, ref_snapshot: snap });
    expect(readMeta(old.id).ref_snapshot).toEqual(snap);
    const fresh = createRun({ ...base, ref_snapshot: { ...snap, hooks_hash: 'c' } });
    expect(readMeta(fresh.id).ref_snapshot?.hooks_hash).toBe('c');
  });

  it('a run without result.md has no result and no paging fields', () => {
    const meta = createRun(base);
    const s = runSummary(meta.id);
    expect(s.result).toBeNull();
    expect(s.result_total_chars).toBeUndefined();
  });
});

describe('pruneOldEvents (L8)', () => {
  const saved = process.env.WINGMAN_HOME;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wm-ev-'));
    process.env.WINGMAN_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WINGMAN_HOME;
    else process.env.WINGMAN_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('deletes only events.jsonl of terminal runs older than the retention', () => {
    const old = createRun(base);
    const fresh = createRun(base);
    const live = createRun(base);
    for (const m of [old, fresh, live]) appendEvent(m.id, '{"x":1}');
    writeResult(old.id, 'report');
    updateStatus(old.id, 'done', {
      finished_at: new Date(Date.now() - 15 * 86400_000).toISOString(),
    });
    updateStatus(fresh.id, 'done', {
      finished_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
    });
    expect(pruneOldEvents()).toEqual([old.id]);
    expect(readdirSync(runDir(old.id)).sort()).toEqual(['meta.json', 'result.md']);
    expect(readdirSync(runDir(fresh.id))).toContain('events.jsonl');
    expect(readdirSync(runDir(live.id))).toContain('events.jsonl');
    expect(readMeta(old.id).status).toBe('done');
  });
});
