import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { publicAccounts } from './accounts.js';
import type { Account } from './types.js';
import { TOOL_ITEM } from './guard.js';
import { maskSecrets, safeSummary } from './mask.js';
import { getAccount, isActive, isLimited, loadAccounts, targetsFor } from './registry.js';
import { reconcile } from './reconcile.js';
import {
  listRuns,
  readMeta,
  runSummary,
  RESULT_PAGE_CHARS,
  RESULT_PAGE_MAX_CHARS,
} from './runs.js';
import { cancelRun, startRun, type StartRunOptions } from './runner.js';
import { callerProfile } from './self.js';
import { TERMINAL_STATUSES, type RunMeta } from './types.js';
import { removeWorktree, worktreeDirty } from './worktree.js';

export interface ServerDeps {
  /** The caller's environment: decides the caller profile and the depth. */
  env?: NodeJS.ProcessEnv;
  /** Random source for picking an account; defaults to Math.random. */
  random?: () => number;
  /** Clock for rate-limit expiry; defaults to the system clock. */
  now?: () => Date;
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
  let meta: RunMeta;
  try {
    meta = readMeta(runId);
  } catch {
    throw new Error(`Unknown run id "${safeSummary(runId, 80)}"`);
  }
  return reconcile(meta);
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

/** Ids of the accounts the caller could use instead of `exceptId`: active, not limited, not its own. */
async function alternativesTo(
  env: NodeJS.ProcessEnv,
  exceptId: string,
  now: Date,
): Promise<string[]> {
  try {
    const targets = await targetsFor(callerProfile(env));
    return targets.filter((a) => a.id !== exceptId && isActive(a, now)).map((a) => a.id);
  } catch {
    return [];
  }
}

function alternativesHint(ids: string[]): string {
  return ids.length === 0
    ? ''
    : `; other active accounts: ${ids.join(', ')} (pass one as "account" to retry)`;
}

async function chooseAccount(
  env: NodeJS.ProcessEnv,
  accountId: string | undefined,
  random: () => number,
  now: Date,
): Promise<Account> {
  const targets = await targetsFor(callerProfile(env));
  if (accountId !== undefined) {
    const account = await getAccount(accountId);
    if (!targets.some((a) => a.id === accountId)) {
      throw new Error(`Account "${accountId}" is the caller's own profile; pick another account`);
    }
    if (isLimited(account, now)) {
      const until =
        account.limited_until === undefined
          ? 'no end time, until cleared'
          : `limited_until ${account.limited_until}`;
      throw new Error(
        `Account "${accountId}" is rate limited (${until}); pick another account${alternativesHint(await alternativesTo(env, accountId, now))}`,
      );
    }
    if (!isActive(account, now)) {
      throw new Error(
        `Account "${accountId}" is ${account.status}, not active; pick another account`,
      );
    }
    return account;
  }
  const pool = targets.filter((a) => isActive(a, now));
  if (pool.length === 0) {
    const limited = targets.filter((a) => isLimited(a, now));
    const note =
      limited.length === 0
        ? ''
        : `; rate limited: ${limited.map((a) => `${a.id} (limited_until ${a.limited_until ?? 'none'})`).join(', ')}`;
    throw new Error(
      `No other active account is registered to run on${note}; see \`wingman accounts list\``,
    );
  }
  return pool[Math.min(Math.floor(random() * pool.length), pool.length - 1)]!;
}

const startInput = {
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Registry id of the account to run on (never your own); omitted: a random active one.',
    ),
  prompt: z.string().min(1).max(200_000).describe('The full task brief for the run.'),
  cwd: z.string().min(1).describe('Absolute path of the project directory.'),
  model: z.string().min(1).optional(),
  preset: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Tool preset: "readonly" (default), "edit-files" (changes files and commits, runs no commands) or "edit" (also runs node and npm: arbitrary code).',
    ),
  allowed_tools: z
    .array(z.string().min(1).max(300).regex(TOOL_ITEM, 'invalid tool rule'))
    .max(100)
    .optional(),
  max_turns: z.number().int().positive().max(1000).optional(),
  worktree: z
    .boolean()
    .optional()
    .describe(
      'Run in a fresh git worktree; default true in a repo, also when the caller is on the base branch.',
    ),
  branch: z
    .boolean()
    .optional()
    .describe(
      'Create a run branch in the worktree. Default: yes for edit runs, no (detached worktree) for readonly runs. branch:false is refused for runs that may commit.',
    ),
  lock_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Stops two concurrent runs in the same repo with the same key. Needs a worktree run: refused with worktree:false or outside a git repo.',
    ),
  setup: z.string().min(1).max(2000).optional().describe('Shell command run in a new worktree.'),
};
const runIdInput = { run_id: z.string().min(1).max(64) };

export function createHandlers(deps: ServerDeps = {}) {
  const env = deps.env ?? process.env;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? ((): Date => new Date());
  /** On a rate_limited run: names the other usable accounts; the caller decides, nothing is rerouted. */
  const withHint = async (
    payload: Json,
    run: { status: string; account: string },
  ): Promise<Json> => {
    if (run.status !== 'rate_limited') return payload;
    const others = await alternativesTo(env, run.account, now());
    if (others.length === 0) return payload;
    return {
      ...payload,
      other_active_accounts: others,
      hint: `Account ${run.account} hit its rate limit. Other active accounts: ${others.join(', ')}. Start a new run with "account" set to one of them if you want to retry; nothing is rerouted automatically.`,
    };
  };
  const runOpts = (): Partial<StartRunOptions> => ({
    parentEnv: env,
    ...(deps.supervisorEntry !== undefined ? { supervisorEntry: deps.supervisorEntry } : {}),
  });

  return {
    async start(input: z.infer<z.ZodObject<typeof startInput>>): Promise<Json> {
      const account = await chooseAccount(env, input.account, random, now());
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
        ...(input.branch !== undefined ? { create_branch: input.branch } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.preset !== undefined ? { preset: input.preset } : {}),
        ...(input.allowed_tools !== undefined ? { allowed_tools: input.allowed_tools } : {}),
        ...(input.max_turns !== undefined ? { max_turns: input.max_turns } : {}),
        ...(input.lock_key !== undefined ? { lock_key: input.lock_key } : {}),
        ...(input.setup !== undefined ? { setup: input.setup } : {}),
      });
      return {
        run_id: meta.id,
        account: account.id,
        status: meta.status,
        ...(meta.run_branch !== undefined ? { run_branch: meta.run_branch } : {}),
      };
    },

    async status(input: { run_id: string }): Promise<Json> {
      loadMeta(input.run_id);
      const { result, ...summary } = runSummary(input.run_id);
      return withHint({ ...summary, has_result: result !== null }, summary);
    },

    async result(input: { run_id: string; offset?: number; limit?: number }): Promise<Json> {
      const meta = loadMeta(input.run_id);
      if (!TERMINAL_STATUSES.includes(meta.status)) {
        return { id: meta.id, status: meta.status, message: 'still running' };
      }
      const summary = runSummary(input.run_id, {
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return withHint({ ...summary }, summary);
    },

    async accounts(): Promise<Json> {
      const { accounts } = await loadAccounts();
      return { accounts: publicAccounts(accounts, callerProfile(env), now()) };
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
        .map((m) => reconcile(m))
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
      if (
        input.action !== 'discard' &&
        meta.worktree !== undefined &&
        existsSync(meta.worktree) &&
        (await worktreeDirty(meta.worktree))
      ) {
        throw new Error(
          `The worktree of run ${meta.id} has uncommitted changes; commit or copy them, or call wingman_cleanup with action "discard" to drop them`,
        );
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
  const server = new McpServer({ name: 'wingman', version: pkg.version });
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
      description: `Start a one-shot detached run of Claude Code on another registered account (random active one when account is omitted); to give more work, start a new run. Returns run_id, account and status only. Presets: "readonly" (default), "edit-files" (edits files and commits, runs no commands) and "edit" (also runs node and npm). The preset "edit" runs arbitrary code under the target account and the deny rules are advisory, not a sandbox; "setup" is an arbitrary shell command run as the caller's user, outside the presets. Then run bin/wingman-wait <run_id> in the background and call wingman_result. ${LOGS_WARNING}`,
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
      description: `Masked final report of a finished run, or "still running". Long reports come in pages: when the answer has result_next_offset, call again with offset set to it until it is absent (result_total_chars is the full length). ${LOGS_WARNING}`,
      inputSchema: {
        ...runIdInput,
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Start of the page, in characters; default 0.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(RESULT_PAGE_MAX_CHARS)
          .optional()
          .describe(
            `Page size in characters; default ${RESULT_PAGE_CHARS}, max ${RESULT_PAGE_MAX_CHARS}.`,
          ),
      },
    },
    wrap(h.result),
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
    'wingman_accounts',
    {
      description:
        'List the registered accounts: id, label, status (active, disabled or rate_limited, with limited_until while limited; a limited account is skipped until then), is_caller (your own profile, never a target), provider and runs (finished runs by status). Read-only on purpose: an account entry names a command the runner executes, so no tool adds, changes or removes accounts; the Human does that with `wingman accounts ...` in a terminal.',
      inputSchema: {},
    },
    wrap(h.accounts),
  );
  server.registerTool(
    'wingman_cleanup',
    {
      description:
        'Remove the worktree and lock of a finished run; the run branch, when the run has one, is kept. Refused while running.',
      inputSchema: { ...runIdInput, action: z.enum(['accept', 'discard']) },
    },
    wrap(h.cleanup),
  );
  return server;
}
