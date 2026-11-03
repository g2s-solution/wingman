#!/usr/bin/env node
// Event shapes captured from `codex exec --json` (codex-cli 0.163), text replaced.
import { appendFileSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
const log = process.env.FAKE_CODEX_LOG;
const argv = process.argv.slice(2);
const prompt = readFileSync(0);
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({
      argv,
      prompt: prompt.toString('utf8'),
      prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
      env_names: Object.keys(process.env).sort(),
      codex_home: process.env.CODEX_HOME,
      cwd: process.cwd(),
    })}\n`,
  );
}
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const tid = '00000000-0000-4000-8000-0000000000c1';

emit({ type: 'thread.started', thread_id: tid });
emit({ type: 'turn.started' });
emit({ type: 'error', message: 'Reconnecting... 2/5 (transient)' });
process.stdout.write('not json, a stray log line\n');

if (mode === 'edit') {
  const cwd = argv[argv.indexOf('-C') + 1];
  writeFileSync(join(cwd, 'edited.txt'), 'by codex\n');
}
if (mode === 'edit_env') {
  const cwd = argv[argv.indexOf('-C') + 1];
  writeFileSync(join(cwd, 'edited.txt'), 'ok\n');
  writeFileSync(join(cwd, '.env'), 'PLACEHOLDER=1\n');
}
if (mode === 'edit_link') {
  const cwd = argv[argv.indexOf('-C') + 1];
  symlinkSync('/etc/hostname', join(cwd, 'link'));
}
if (mode === 'fail') {
  emit({ type: 'turn.failed', error: { message: 'model exploded' } });
  process.exit(1);
}
if (mode === 'ratelimit') {
  emit({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  process.exit(1);
}
if (mode === 'nomessage') {
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
emit({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: 'Done the work.\nWINGMAN_STATUS: done' },
});
emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
