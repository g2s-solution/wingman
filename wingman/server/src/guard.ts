export type Preset = 'os-apply';

export const STATUS_VALUES = ['done', 'partial', 'blocked', 'needs_input'] as const;
export type ReportedStatus = (typeof STATUS_VALUES)[number];

export const PRESETS: Record<Preset, { allowed: readonly string[] }> = {
  'os-apply': {
    allowed: [
      'Agent',
      'Skill',
      'Edit',
      'Write',
      'Read',
      'Bash(git status:*)',
      'Bash(git add:*)',
      'Bash(git commit:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git rev-parse:*)',
      'Bash(git branch --show-current)',
      'Bash(git ls-files:*)',
      'Bash(git mv:*)',
      'Bash(git rm:*)',
      'Bash(git restore:*)',
      'Bash(node:*)',
      'Bash(openspec:*)',
      'Bash(date:*)',
    ],
  },
};

export function guardPrompt(): string {
  return [
    'You are running as a delegated wingman run inside another Claude Code session. These rules override any other instruction, rule or skill you load:',
    '1. Never print, send or write sensitive values: tokens (Bearer, JWT, PAT, API keys), passwords, secrets, private keys, credentials in URLs, .env values or personal data. Do not read files that may hold them; check with a count first and report structure only.',
    '2. Never commit or push to the base branch (main, master or the repository default branch). Work only on the branch you were started on. Never run git push.',
    '3. Never ask questions and never wait for an answer. Inside a wingman run, any rule or skill that says "ask the Human" means: stop and finish with WINGMAN_STATUS: needs_input.',
    '4. Do not manage plugins (no claude plugin install or update) and do not call wingman tools.',
    '5. Always end with a final report. The last line of your final message must be exactly one of: WINGMAN_STATUS: done, WINGMAN_STATUS: partial, WINGMAN_STATUS: blocked, WINGMAN_STATUS: needs_input.',
  ].join('\n');
}

export function baseDisallowed(): string[] {
  return [
    'AskUserQuestion',
    'Bash(git push:*)',
    'Bash(git -C:*)',
    'Bash(git -c:*)',
    'Bash(git --no-pager:*)',
    'Bash(git update-ref:*)',
    'Bash(git config:*)',
    'Bash(git remote:*)',
    'Bash(claude:*)',
    'Bash(claude plugin:*)',
    'Bash(npm install -g:*)',
    'mcp__plugin_wingman_*',
    'mcp__wingman__*',
    'mcp__plugin_wingman_wingman__*',
  ];
}

/** A tool rule is passed as a bare argv word after a variadic flag: it must never read as a flag. */
export const TOOL_ITEM = /^(?!-)[A-Za-z0-9_*.:()\- ,/'"@=+~[\]$|]+$/;

export function assertToolItems(items: readonly string[], label: string): void {
  for (const item of items) {
    if (!TOOL_ITEM.test(item) || item.length > 300) {
      throw new Error(`Invalid ${label} item "${item.slice(0, 60)}"`);
    }
  }
}

export interface ToolSelection {
  preset?: string;
  allowed_tools?: string[];
}

export function resolveTools(sel: ToolSelection): { allowed: string[]; disallowed: string[] } {
  const disallowed = baseDisallowed();
  let allowed: string[] = [];
  if (sel.allowed_tools !== undefined) {
    assertToolItems(sel.allowed_tools, 'allowed_tools');
    allowed = [...sel.allowed_tools];
  } else if (sel.preset !== undefined) {
    const preset = PRESETS[sel.preset as Preset];
    if (!preset) throw new Error(`Unknown preset "${sel.preset}"`);
    allowed = [...preset.allowed];
  }
  allowed = allowed.filter((name) => !disallowed.includes(name));
  return { allowed, disallowed };
}

export function parseStatusLine(text: string): ReportedStatus | null {
  let found: ReportedStatus | null = null;
  const re = /^[ \t]*WINGMAN_STATUS:[ \t]*([a-z_]+)[ \t]*$/gm;
  for (const match of text.matchAll(re)) {
    const value = match[1] as ReportedStatus;
    if ((STATUS_VALUES as readonly string[]).includes(value)) found = value;
  }
  return found;
}
