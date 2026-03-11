/**
 * Seed DM channels into the channel cache by querying the memory DB
 * for discord channels that only have 2 distinct senders (i.e. DMs).
 *
 * Usage: npx tsx src/commands/seed-dm-channels.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChannelCache, ChannelInfo } from '../lib/channel-cache.js';

const CACHE_FILE = path.resolve(process.cwd(), '.data', 'channel-cache.json');

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:bmm34neuoh99j8v6@ai-applications-openclaw-database-nztjfr:5432/postgres';

interface DMCandidate {
  channel_id: string;
  senders: string[];
}

async function findDMChannels(): Promise<DMCandidate[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT
        m.recipient AS channel_id,
        array_agg(DISTINCT m.sender) AS senders
      FROM messages m
      JOIN sources s ON m.source_id = s.id
      WHERE s.name = 'discord'
        AND m.recipient LIKE 'discord-channel:%'
      GROUP BY m.recipient
      HAVING COUNT(DISTINCT m.sender) = 2
    `);

    return rows.map((r: any) => ({
      channel_id: r.channel_id.replace('discord-channel:', ''),
      senders: r.senders,
    }));
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('Querying memory DB for DM channels...');
  const candidates = await findDMChannels();
  console.log(`Found ${candidates.length} potential DM channels`);

  // Load existing cache
  let cache: ChannelCache;
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch {
    cache = { updatedAt: '2020-01-01T00:00:00.000Z', channels: {} };
  }

  let added = 0;
  for (const dm of candidates) {
    if (!cache.channels[dm.channel_id]) {
      // Use the non-bot sender name, or join both
      const displayName = dm.senders.filter(s => s !== 'ETdoFresh').join(', ') || dm.senders.join(', ');
      cache.channels[dm.channel_id] = {
        channelName: `${displayName} (DM)`,
        guildId: null,
        guildName: 'Direct Messages',
      };
      added++;
      console.log(`  Added: ${dm.channel_id} → ${displayName} (DM) [senders: ${dm.senders.join(', ')}]`);
    }
  }

  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`Done. Added ${added} DM channels to cache.`);
}

main().catch(console.error);
