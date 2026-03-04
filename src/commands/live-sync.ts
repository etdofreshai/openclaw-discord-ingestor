import 'dotenv/config';
import { loadSession } from '../lib/session.js';
import { validateToken } from '../lib/token-validator.js';
import { syncChannel } from '../lib/live-sync.js';
import { isApiMode } from '../lib/api-writer.js';

type Cli = {
  channel: string;
  limit?: number;
  before?: string;
  after?: string;
  verbose: boolean;
};

function parseArgs(argv: string[]): Cli {
  const out: Cli = { channel: '', verbose: false };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') out.channel = argv[++i] ?? '';
    else if (a === '--limit') out.limit = parseInt(argv[++i] ?? '0', 10);
    else if (a === '--before') out.before = argv[++i] ?? '';
    else if (a === '--after') out.after = argv[++i] ?? '';
    else if (a === '--verbose') out.verbose = true;
  }

  if (!out.channel) {
    console.error('Usage: npm run sync -- --channel <channel-id> [--limit N] [--before <msg-id>] [--after <msg-id>] [--verbose]');
    process.exit(1);
  }

  return out;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  // Require at least one write backend
  if (!isApiMode() && !process.env.DATABASE_URL) {
    console.error(
      'Missing write backend: set DATABASE_URL for PostgreSQL mode, ' +
      'or set MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN for API mode.'
    );
    process.exit(1);
  }

  const session = await loadSession();
  if (!session) {
    console.error('No saved Discord session found. Please log in first via the login server.');
    process.exit(1);
  }

  const user = await validateToken(session);
  if (!user) {
    console.error('Token validation failed. Please log in again via the login server.');
    process.exit(1);
  }

  if (cli.verbose) {
    const writeMode = isApiMode() ? 'api (MEMORY_DATABASE_API_URL)' : 'pg (DATABASE_URL)';
    console.log(`[live-sync] Validated session for user: ${user.username}#${user.discriminator}`);
    console.log(`[live-sync] Write mode: ${writeMode}`);
  }

  const result = await syncChannel(session, cli.channel, {
    limit: cli.limit,
    before: cli.before,
    after: cli.after,
    verbose: cli.verbose,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
