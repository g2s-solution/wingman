export interface Account {
  id: string;
  label: string;
  config_dir: string;
  /** default 'claude' */
  provider: string;
  /** default 'claude' */
  command: string;
  /** Absent or 'active' means usable; anything else disables the account. */
  status?: string;
  /** ISO time; with status 'rate_limited', the account is skipped until then. */
  limited_until?: string;
  /** Provider model name for each tier, so a caller can ask for haiku, sonnet or opus on any provider. */
  models?: Partial<Record<ModelTier, string>>;
}

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export type RunStatus =
  | 'running'
  | 'done'
  | 'partial'
  | 'blocked'
  | 'needs_input'
  | 'needs_caller'
  | 'failed'
  | 'failed_no_report'
  | 'rate_limited'
  | 'cancelled';

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'done',
  'partial',
  'blocked',
  'needs_input',
  'needs_caller',
  'failed',
  'failed_no_report',
  'rate_limited',
  'cancelled',
];

export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

export interface RefSnapshot {
  /** `refs/heads/<name>` of the base branches and the caller branch. */
  refs: string[];
  refs_hash: string;
  config_hash: string;
  /** Absent in snapshots written before hooks were tracked. */
  hooks_hash?: string;
}

export interface RunMeta {
  id: string;
  account: string;
  cwd: string;
  branch?: string;
  run_branch?: string;
  worktree?: string;
  /** Refs and local config as they were when the run started. */
  ref_snapshot?: RefSnapshot;
  /** Toplevel of the caller's repository; keys the run lock. */
  repo?: string;
  /** Directory the agent runs in: the worktree plus the caller's offset inside the repo. */
  run_cwd?: string;
  session_id: string;
  status: RunStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  pid?: number;
  pid_start_time?: string;
  exit_code?: number | null;
  permission_denials: string[];
  rate_limit?: RateLimitInfo;
  depth: number;
  lock_key?: string;
  preset?: string;
  prompt_chars: number;
}

export type AgentEvent =
  | { kind: 'started'; session_id: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'rate_limited'; info: RateLimitInfo }
  | {
      kind: 'finished';
      result: string | null;
      is_error: boolean;
      permission_denials: string[];
      /** The agent stopped at its turn limit. */
      max_turns?: boolean;
    };

export interface StartSpec {
  prompt: string;
  cwd: string;
  model?: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  max_turns?: number;
  session_id: string;
  append_system_prompt: string;
  /** Preset name the caller chose; adapters without tool-rule syntax map it to their own sandbox. */
  preset: string;
}

export interface AdapterCapabilities {
  /** Accepts Claude tool-rule strings in `allowed_tools`. */
  allowedTools: boolean;
  /** Has a turn limit flag, so `max_turns` is enforced. */
  maxTurns: boolean;
  /** Can run `git commit` itself inside the run worktree; if not, wingman commits its changes afterwards. */
  agentCommits: boolean;
}

export interface Adapter {
  provider: string;
  capabilities: AdapterCapabilities;
  /** The text sent on stdin; default is `spec.prompt` (a provider without a system-prompt flag prepends the guardrail). */
  buildPrompt?(spec: StartSpec): string;
  /** A parser with per-run state, for providers whose final result needs earlier lines. Default: `parseLine`. */
  createLineParser?(): (line: string) => AgentEvent[];
  buildCommand(account: Account, spec: StartSpec): { command: string; args: string[] };
  buildEnv(
    parent: NodeJS.ProcessEnv,
    account: Account,
    depth: number,
    /** Absent when the environment is for a setup command rather than the agent. */
    spec?: StartSpec,
  ): Record<string, string>;
  parseLine(line: string): AgentEvent[];
  /** True when the rate-limit info from this provider means the run was refused. */
  isRateLimitRejected(info: RateLimitInfo): boolean;
}
