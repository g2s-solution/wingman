#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setInterval } from 'node:timers';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const log = process.env.FAKE_CLAUDE_LOG;
const sid = '00000000-0000-4000-8000-000000000001';

// 'no_stdin' exits without reading the prompt; every other mode reads it all first
const promptBytes = mode === 'no_stdin' ? new Uint8Array(0) : readFileSync(0);

if (log) {
  const record = {
    argv: process.argv.slice(2),
    prompt_length: promptBytes.length,
    prompt_sha256: createHash('sha256').update(promptBytes).digest('hex'),
    env_names: Object.keys(process.env).sort(),
    cwd: process.cwd(),
  };
  appendFileSync(log, `${JSON.stringify(record)}\n`);
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const init = () => emit({ type: 'system', subtype: 'init', session_id: sid });
const hook = () => emit({ type: 'system', subtype: 'hook_started', session_id: sid });
const assistant = () =>
  emit({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', name: 'Read' },
      ],
    },
    session_id: sid,
  });
const result = (text, extra = {}) =>
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    permission_denials: [],
    num_turns: 2,
    stop_reason: 'end_turn',
    session_id: sid,
    ...extra,
  });
const rate = (status) =>
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      resetsAt: 1900000000,
      rateLimitType: 'five_hour',
      isUsingOverage: false,
    },
    session_id: sid,
  });

init();
hook();
switch (mode) {
  case 'no_stdin':
    assistant();
    result('Done without reading.\nWINGMAN_STATUS: done');
    process.exit(0);
    break;
  case 'hang':
    assistant();
    setInterval(() => undefined, 1000);
    break;
  case 'nonzero':
    assistant();
    result('Finished.\nWINGMAN_STATUS: done');
    process.stderr.write('boom\n');
    process.exit(1);
    break;
  case 'rate_limit':
    rate('rejected');
    result('You have hit your limit', { is_error: true });
    process.exit(1);
    break;
  case 'no_result':
    assistant();
    process.stdout.write('not json at all\n');
    process.exit(1);
    break;
  case 'no_status_line':
    assistant();
    result('All done, nothing more to say.');
    break;
  case 'plugin_update':
    assistant();
    result('I ran claude plugin update ailab-agent to continue.\nWINGMAN_STATUS: done');
    break;
  case 'grandchild': {
    // leaves a background process holding stdout open after the agent itself exits
    const gc = spawn('sleep', ['120'], { stdio: ['ignore', 'inherit', 'inherit'] });
    writeFileSync(process.env.FAKE_GC_PID, String(gc.pid));
    assistant();
    result('Implemented the change.\nWINGMAN_STATUS: done');
    process.exit(0);
    break;
  }
  case 'max_turns':
    assistant();
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: sid });
    process.exit(1);
    break;
  case 'move_ref': {
    // moves FAKE_REF_NAME (a branch) to FAKE_REF_TARGET inside FAKE_REF_REPO, as a misbehaving run would
    const repo = process.env.FAKE_REF_REPO;
    execFileSync('git', [
      '-C',
      repo,
      'update-ref',
      `refs/heads/${process.env.FAKE_REF_NAME}`,
      process.env.FAKE_REF_TARGET,
    ]);
    assistant();
    result('Implemented the change.\nWINGMAN_STATUS: done');
    break;
  }
  case 'edit_config':
    execFileSync('git', [
      '-C',
      process.env.FAKE_REF_REPO,
      'config',
      '--local',
      'wingman.test',
      '1',
    ]);
    assistant();
    result('Implemented the change.\nWINGMAN_STATUS: done');
    break;
  case 'edit_hook': {
    // drops a hook into the caller repo's shared hooks directory, as a misbehaving run could
    const repo = process.env.FAKE_REF_REPO;
    const common = execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(resolve(repo, common, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    assistant();
    result('Implemented the change.\nWINGMAN_STATUS: done');
    break;
  }
  case 'permission_denial':
    assistant();
    result('Could not do everything.\nWINGMAN_STATUS: partial', {
      permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Bash' }, { tool_name: 'WebFetch' }],
    });
    break;
  default:
    assistant();
    rate('allowed');
    result('Implemented the change.\nWINGMAN_STATUS: done');
}
