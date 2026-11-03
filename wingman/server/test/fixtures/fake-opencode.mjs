#!/usr/bin/env node
// Event shapes captured from `opencode run --format json` (opencode 2.2), text replaced.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_OC_MODE ?? 'ok';
const log = process.env.FAKE_OC_LOG;
const prompt = readFileSync(0).toString('utf8');
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({
      argv: process.argv.slice(2),
      prompt,
      env_names: Object.keys(process.env).sort(),
      xdg_data: process.env.XDG_DATA_HOME,
      permission: process.env.OPENCODE_CONFIG_CONTENT
        ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).permission
        : undefined,
      cwd: process.cwd(),
    })}\n`,
  );
}
const sid = 'ses_test0000000000000000';
const emit = (type, extra) =>
  process.stdout.write(`${JSON.stringify({ type, timestamp: 1, sessionID: sid, ...extra })}\n`);

emit('step_start', { part: { id: 'p1', sessionID: sid, messageID: 'm1', type: 'step-start' } });
process.stdout.write('not json, a stray log line\n');

if (mode === 'edit') {
  writeFileSync('edited.txt', 'by opencode\n');
  execFileSync('git', ['add', 'edited.txt']);
  execFileSync('git', ['-c', 'user.name=oc', '-c', 'user.email=oc@x', 'commit', '-q', '-m', 'oc']);
}
if (mode === 'fail') {
  emit('error', {
    error: { type: 'provider.invalid-request', message: 'model exploded', status: 400 },
  });
  process.exit(1);
}
if (mode === 'ratelimit') {
  emit('error', { error: { type: 'provider.rate-limit', message: 'slow down', status: 429 } });
  process.exit(1);
}
if (mode === 'denied') {
  emit('tool_use', {
    part: {
      type: 'tool',
      tool: 'shell',
      state: { status: 'error', error: 'Permission denied: shell' },
    },
  });
}
if (mode === 'nofinish') process.exit(0);
emit('text', { part: { id: 'p2', type: 'text', text: 'Done the work.\nWINGMAN_STATUS: done' } });
emit('step_finish', {
  part: { id: 'p3', type: 'step-finish', reason: 'stop', cost: 0, tokens: {} },
});
