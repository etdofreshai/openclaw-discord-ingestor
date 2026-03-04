import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { isApiMode, writeMessagesViaApi, type ApiMessagePayload } from './lib/api-writer.js';

type Cli = {
  input: string;
  dryRun: boolean;
  verbose: boolean;
};

type DiscordMessage = {
  id?: string;
  timestamp?: string;
  content?: string;
  author?: { id?: string; name?: string; username?: string; global_name?: string };
  attachments?: unknown[];
  embeds?: unknown[];
  mentions?: unknown[];
  [k: string]: unknown;
};

type DiscordExportFile = {
  guild?: { id?: string; name?: string };
  channel?: { id?: string; name?: string };
  messages?: DiscordMessage[];
  [k: string]: unknown;
};

type Normalized = {
  externalId: string;
  timestamp: Date;
  sender: string;
  recipient: string;
  content: string;
  metadata: Record<string, unknown>;
};

function parseArgs(argv: string[]): Cli {
  const out: Cli = { input: '', dryRun: false, verbose: false };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i] ?? '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
  }

  if (!out.input) {
    console.error('Usage: npm run import -- --input /path/to/discord-export [--dry-run] [--verbose]');
    process.exit(1);
  }

  return out;
}

async function walkJsonFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) results.push(p);
    }
  }

  await walk(root);
  return results;
}

function normalize(file: DiscordExportFile, msg: DiscordMessage): Normalized | null {
  const externalId = msg.id?.trim();
  const tsRaw = msg.timestamp?.trim();
  if (!externalId || !tsRaw) return null;

  const timestamp = new Date(tsRaw);
  if (Number.isNaN(timestamp.getTime())) return null;

  const sender =
    msg.author?.global_name?.trim() ||
    msg.author?.name?.trim() ||
    msg.author?.username?.trim() ||
    msg.author?.id?.trim() ||
    'unknown';

  const channelName = file.channel?.name?.trim();
  const channelId = file.channel?.id?.trim();
  const guildName = file.guild?.name?.trim();

  const recipient =
    (guildName && channelName && `${guildName}#${channelName}`) ||
    channelName ||
    channelId ||
    'discord-channel';

  const hasRich = (msg.attachments?.length ?? 0) > 0 || (msg.embeds?.length ?? 0) > 0;
  const content = msg.content?.trim() || (hasRich ? '[non-text discord message]' : '');

  return {
    externalId,
    timestamp,
    sender,
    recipient,
    content,
    metadata: {
      guild: file.guild ?? null,
      channel: file.channel ?? null,
      author: msg.author ?? null,
      attachments: msg.attachments ?? [],
      embeds: msg.embeds ?? [],
      mentions: msg.mentions ?? [],
      raw: msg,
    },
  };
}

async function ensureSourceId(pool: pg.Pool): Promise<number> {
  const existing = await pool.query<{ id: number }>('SELECT id FROM sources WHERE name = $1 LIMIT 1', ['discord']);
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const inserted = await pool.query<{ id: number }>(
    'INSERT INTO sources (name) VALUES ($1) RETURNING id',
    ['discord']
  );
  return inserted.rows[0].id;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (!cli.dryRun && !isApiMode() && !databaseUrl) {
    console.error(
      'Missing write backend: set DATABASE_URL for PostgreSQL mode, ' +
      'or set MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN for API mode.'
    );
    process.exit(1);
  }

  const files = await walkJsonFiles(cli.input);
  let filesParsed = 0;
  let messagesSeen = 0;
  let messagesNormalized = 0;
  let skipped = 0;

  const normalized: Normalized[] = [];

  for (const filePath of files) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as DiscordExportFile;

      if (!Array.isArray(parsed.messages)) continue;
      filesParsed++;

      for (const msg of parsed.messages) {
        messagesSeen++;
        const n = normalize(parsed, msg);
        if (!n) {
          skipped++;
          continue;
        }
        if (!n.content && !(msg.attachments?.length || msg.embeds?.length)) {
          skipped++;
          continue;
        }
        normalized.push(n);
        messagesNormalized++;
      }

      if (cli.verbose) {
        console.log(`Parsed ${filePath}: ${parsed.messages.length} messages`);
      }
    } catch (err) {
      skipped++;
      if (cli.verbose) console.warn(`Skipping invalid JSON: ${filePath}`, err);
    }
  }

  if (cli.dryRun) {
    console.log(JSON.stringify({ filesScanned: files.length, filesParsed, messagesSeen, messagesNormalized, skipped, dryRun: true }, null, 2));
    return;
  }

  if (isApiMode()) {
    // ── API write mode ─────────────────────────────────────────────────────
    const inputs = normalized.map(msg => ({
      payload: {
        source: 'discord' as const,
        sender: msg.sender,
        recipient: msg.recipient,
        content: msg.content,
        timestamp: msg.timestamp.toISOString(),
        external_id: msg.externalId,
        metadata: msg.metadata,
      } satisfies ApiMessagePayload,
      attachmentCount: 0, // JSON imports don't track attachment counts separately
    }));

    const writeResult = await writeMessagesViaApi(inputs);
    console.log(JSON.stringify({
      filesScanned: files.length,
      filesParsed,
      messagesSeen,
      messagesNormalized,
      normalizeSkipped: skipped,
      ...writeResult,
      writeMode: 'api',
      dryRun: false,
    }, null, 2));
  } else {
    // ── PostgreSQL write mode ──────────────────────────────────────────────
    const pool = new pg.Pool({ connectionString: databaseUrl! });

    try {
      const sourceId = await ensureSourceId(pool);
      let upserted = 0;

      for (const msg of normalized) {
        const res = await pool.query(
          `INSERT INTO messages (source_id, external_id, timestamp, sender, recipient, content, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (source_id, external_id)
           DO UPDATE SET
             timestamp = EXCLUDED.timestamp,
             sender = EXCLUDED.sender,
             recipient = EXCLUDED.recipient,
             content = EXCLUDED.content,
             metadata = EXCLUDED.metadata`,
          [sourceId, msg.externalId, msg.timestamp.toISOString(), msg.sender, msg.recipient, msg.content, JSON.stringify(msg.metadata)]
        );
        if ((res.rowCount ?? 0) > 0) upserted++;
      }

      console.log(JSON.stringify({
        filesScanned: files.length,
        filesParsed,
        messagesSeen,
        messagesNormalized,
        normalizeSkipped: skipped,
        upserted,
        sourceId,
        writeMode: 'pg',
        dryRun: false,
      }, null, 2));
    } finally {
      await pool.end();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
