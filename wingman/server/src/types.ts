export interface Account {
  id: string;
  label: string;
  config_dir: string;
  /** default 'claude' */
  provider: string;
  /** default 'claude' */
  command: string;
}

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

export interface RunMeta {
  id: string;
  account: string;
  cwd: string;
  branch?: string;
  run_branch?: string;
  worktree?: string;
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
  change?: string;
  preset?: string;
  prompt_chars: number;
}

export type AgentEvent =
  | { kind: 'started'; session_id: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'rate_limited'; info: RateLimitInfo }
  | { kind: 'finished'; result: string | null; is_error: boolean; permission_denials: string[] };

export interface StartSpec {
  prompt: string;
  cwd: string;
  model?: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  max_turns?: number;
  session_id: string;
  append_system_prompt: string;
  resume?: boolean;
}

export interface Adapter {
  provider: string;
  buildCommand(account: Account, spec: StartSpec): { command: string; args: string[] };
  buildEnv(parent: NodeJS.ProcessEnv, account: Account, depth: number): Record<string, string>;
  parseLine(line: string): AgentEvent[];
}
