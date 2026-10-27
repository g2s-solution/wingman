import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { maybeRunCli } from './cli.js';
import { maybeRunSupervisor } from './runner.js';
import { pruneOldEvents } from './runs.js';
import { currentDepth } from './self.js';
import { buildServer } from './tools.js';
import { pruneOrphans } from './worktree.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The bundled entry doubles as the supervisor process and as the CLI; stdout there is not ours to use.
if (!maybeRunSupervisor(process.argv)) {
  const cliCode = await maybeRunCli(process.argv);
  if (cliCode !== undefined) {
    process.exitCode = cliCode;
  } else {
    // a child run loads this server too; only a top-level server may remove worktrees
    if (currentDepth() === 0) {
      pruneOrphans({ minAgeMs: DAY_MS }).catch(() => undefined);
      try {
        pruneOldEvents();
      } catch {
        // retention is best effort
      }
    }
    await buildServer().connect(new StdioServerTransport());
  }
}
