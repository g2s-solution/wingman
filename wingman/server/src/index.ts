import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { maybeRunSupervisor } from './runner.js';
import { currentDepth } from './self.js';
import { buildServer } from './tools.js';
import { pruneOrphans } from './worktree.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The bundled entry doubles as the supervisor process; stdout there belongs to the run log.
if (!maybeRunSupervisor(process.argv)) {
  // a child run loads this server too; only a top-level server may remove worktrees
  if (currentDepth() === 0) pruneOrphans({ minAgeMs: DAY_MS }).catch(() => undefined);
  await buildServer().connect(new StdioServerTransport());
}
