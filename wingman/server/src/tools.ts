import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maskSecrets, safeSummary } from './mask.js';
import { getAccount, targetsFor } from './registry.js';
import { listRuns, readMeta, runSummary } from './runs.js';
import { cancelRun, sendToRun, startRun, type StartRunOptions } from './runner.js';
import { callerProfile } from './self.js';
import { TERMINAL_STATUSES, type RunMeta } from './types.js';
import { removeWorktree } from './worktree.js';

export interface ServerDeps {
  /** The caller's environment: decides the caller profile and the depth. */
  env?: NodeJS.ProcessEnv;
  /** Script the supervisor is started from; defaults to the running entry. */
  supervisorEntry?: string;
}

const LIST_DEFAULT = 20;
const LIST_MAX = 100;
const GIT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return maskSecrets(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

function ok(payload: Json): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(scrub(payload)) }] };
}

function fail(err: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: safeSummary(message, 500) }] };
}

function loadMeta(runId: string): RunMeta {
  try {
    return readMeta(runId);
  } catch {
    throw new Error(`Unknown run id "${safeSummary(runId, 80)}"`);
  }
}

function currentBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}

async function assertTarget(env: NodeJS.ProcessEnv, accountId: string): Promise<void> {
  await getAccount(accountId);
  const targets = await targetsFor(callerProfile(env));
  if (!targets.some((a) => a.id === accountId)) {
    throw new Error(`Account "${accountId}" is the caller's own profile; pick another account`);
  }
}

const startInput = {
  account: z.string().min(1).describe('Registry id of the account to run on (never your own).'),
  prompt: z.string().min(1).max(200_000).describe('The full task brief for the run.'),
  cwd: z.string().min(1).describe('Absolute path of the project directory.'),
  model: z.string().min(1).optional(),
  preset: z.string().min(1).optional().describe('Tool preset, for example "os-apply".'),
  allowed_tools: z.array(z.string().min(1)).max(100).optional(),
  max_turns: z.number().int().positive().max(1000).optional(),
  worktree: z.boolean().optional().describe('Run in a fresh git worktree; default true in a repo.'),
  change: z.string().min(1).max(200).optional().describe('OpenSpec change name, locks it.'),
  setup: z.string().min(1).max(2000).optional().describe('Shell command run in a new worktree.'),
};
const runIdInput = { run_id: z.string().min(1).max(64) };

export function createHandlers(deps: ServerDeps = {}) {
  const env = deps.env ?? process.env;
  const runOpts = (): Partial<StartRunOptions> => ({
    parentEnv: env,
    ...(deps.supervisorEntry !== undefined ? { supervisorEntry: deps.supervisorEntry } : {}),
  });

  return {
    async start(input: z.infer<z.ZodObject<typeof startInput>>): Promise<Json> {
      await assertTarget(env, input.account);
      const account = await getAccount(input.account);
      if (
        !isAbsolute(input.cwd) ||
        !statSync(input.cwd, { throwIfNoEntry: false })?.isDirectory()
      ) {
        throw new Error('cwd must be an absolute path of an existing directory');
      }
      const branch = await currentBranch(input.cwd);
      const worktree = input.worktree ?? branch !== undefined;
      if (worktree && branch === undefined) {
        throw new Error('worktree needs cwd to be inside a git repository with a commit');
      }
      const meta = await startRun({
        ...runOpts(),
        account,
        prompt: input.prompt,
        cwd: input.cwd,
        worktree,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.preset !== undefined ? { preset: input.preset } : {}),
        ...(input.allowed_tools !== undefined ? { allowed_tools: input.allowed_tools } : {}),
        ...(input.max_turns !== undefined ? { max_turns: input.max_turns } : {}),
        ...(input.change !== undefined ? { change: input.change } : {}),
        ...(input.setup !== undefined ? { setup: input.setup } : {}),
      });
      return {
        run_id: meta.id,
        status: meta.status,
        ...(meta.run_branch !== undefined ? { run_branch: meta.run_branch } : {}),
      };
    },

    status(input: { run_id: string }): Json {
      loadMeta(input.run_id);
      const { result, ...summary } = runSummary(input.run_id);
      return { ...summary, has_result: result !== null };
    },

    result(input: { run_id: string }): Json {
      const meta = loadMeta(input.run_id);
      if (!TERMINAL_STATUSES.includes(meta.status)) {
        return { id: meta.id, status: meta.status, message: 'still running' };
      }
      return { ...runSummary(input.run_id) };
    },

    async send(input: { run_id: string; prompt: string }): Promise<Json> {
      const previous = loadMeta(input.run_id);
      await assertTarget(env, previous.account);
      const meta = await sendToRun(input.run_id, input.prompt, runOpts());
      return {
        run_id: meta.id,
        status: meta.status,
        ...(meta.run_branch !== undefined ? { run_branch: meta.run_branch } : {}),
      };
    },

    async cancel(input: { run_id: string }): Promise<Json> {
      loadMeta(input.run_id);
      const res = await cancelRun(input.run_id);
      return {
        run_id: input.run_id,
        cancelled: res.cancelled,
        ...(res.reason !== undefined ? { reason: res.reason } : {}),
      };
    },

    list(input: { limit?: number | undefined }): Json {
      const limit = Math.min(input.limit ?? LIST_DEFAULT, LIST_MAX);
      const runs = listRuns()
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          account: m.account,
          status: m.status,
          ...(m.branch !== undefined ? { branch: m.branch } : {}),
          created_at: m.created_at,
        }));
      return { runs };
    },

    async cleanup(input: { run_id: string; action: 'accept' | 'discard' }): Promise<Json> {
      const meta = loadMeta(input.run_id);
      if (meta.status === 'running') {
        throw new Error(`Run ${meta.id} is still running; cancel it before cleanup`);
      }
      await removeWorktree(meta.id);
      return {
        run_id: meta.id,
        action: input.action,
        worktree_removed: meta.worktree !== undefined,
        ...(meta.run_branch !== undefined ? { kept_branch: meta.run_branch } : {}),
      };
    },
  };
}

const LOGS_WARNING = 'Never read run logs or events.jsonl; use only the output of these tools.';

export function buildServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'wingman', version: '0.1.0' });
  const h = createHandlers(deps);

  const wrap =
    <A>(fn: (args: A) => Json | Promise<Json>) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
      } catch (err) {
        return fail(err);
      }
    };

  server.registerTool(
    'wingman_start',
    {
      description: `Start a detached run of Claude Code on another registered account. Returns run_id and status only. ${LOGS_WARNING}`,
      inputSchema: startInput,
    },
    wrap(h.start),
  );
  server.registerTool(
    'wingman_status',
    {
      description: `Masked status of a run (no report text). ${LOGS_WARNING}`,
      inputSchema: runIdInput,
    },
    wrap(h.status),
  );
  server.registerTool(
    'wingman_result',
    {
      description: `Masked, capped final report of a finished run, or "still running". ${LOGS_WARNING}`,
      inputSchema: runIdInput,
    },
    wrap(h.result),
  );
  server.registerTool(
    'wingman_send',
    {
      description: `Continue a finished run on the same account with a new prompt; returns a new run_id. Refused while running or after failed_no_report. ${LOGS_WARNING}`,
      inputSchema: { ...runIdInput, prompt: z.string().min(1).max(200_000) },
    },
    wrap(h.send),
  );
  server.registerTool(
    'wingman_cancel',
    { description: 'Cancel a running run (kills its process group).', inputSchema: runIdInput },
    wrap(h.cancel),
  );
  server.registerTool(
    'wingman_list',
    {
      description: 'List recent runs: id, account, status, branch, created_at.',
      inputSchema: { limit: z.number().int().positive().max(LIST_MAX).optional() },
    },
    wrap(h.list),
  );
  server.registerTool(
    'wingman_cleanup',
    {
      description:
        'Remove the worktree and lock of a finished run; the run branch is always kept. Refused while running.',
      inputSchema: { ...runIdInput, action: z.enum(['accept', 'discard']) },
    },
    wrap(h.cleanup),
  );
  return server;
}
