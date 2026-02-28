import pg from 'pg';
import type { DiscordSession } from './session.js';

type DiscordAPIMessage = {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    global_name?: string;
    discriminator: string;
  };
  content: string;
  timestamp: string;
  attachments: unknown[];
  embeds: unknown[];
  mentions?: unknown[];
};

type Normalized = {
  externalId: string;
  timestamp: Date;
  sender: string;
  recipient: string;
  content: string;
  metadata: Record<string, unknown>;
};

export async function fetchChannelMessages(
  session: DiscordSession,
  channelId: string,
  options?: { limit?: number; before?: string; after?: string }
): Promise<DiscordAPIMessage[]> {
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(options?.limit || 100, 100)));
  if (options?.before) params.set('before', options.before);
  if (options?.after) params.set('after', options.after);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?${params}`, {
    headers: {
      Authorization: session.token,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch messages: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as DiscordAPIMessage[];
}

function normalize(msg: DiscordAPIMessage): Normalized {
  const timestamp = new Date(msg.timestamp);
  const sender =
    msg.author.global_name?.trim() ||
    msg.author.username?.trim() ||
    msg.author.id ||
    'unknown';

  const recipient = `discord-channel:${msg.channel_id}`;
  const hasRich = (msg.attachments?.length ?? 0) > 0 || (msg.embeds?.length ?? 0) > 0;
  const content = msg.content?.trim() || (hasRich ? '[non-text discord message]' : '');

  return {
    externalId: msg.id,
    timestamp,
    sender,
    recipient,
    content,
    metadata: {
      channelId: msg.channel_id,
      author: msg.author,
      attachments: msg.attachments ?? [],
      embeds: msg.embeds ?? [],
      mentions: msg.mentions ?? [],
    },
  };
}

async function ensureSourceId(pool: pg.Pool): Promise<number> {
  const existing = await pool.query<{ id: number }>(
    'SELECT id FROM sources WHERE name = $1 LIMIT 1',
    ['discord']
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const inserted = await pool.query<{ id: number }>(
    'INSERT INTO sources (name) VALUES ($1) RETURNING id',
    ['discord']
  );
  return inserted.rows[0].id;
}

export async function syncChannelToDB(
  pool: pg.Pool,
  session: DiscordSession,
  channelId: string,
  options?: { limit?: number; before?: string; after?: string; verbose?: boolean }
): Promise<{ fetched: number; upserted: number }> {
  const messages = await fetchChannelMessages(session, channelId, options);
  const normalized = messages.map(normalize);

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
      [
        sourceId,
        msg.externalId,
        msg.timestamp.toISOString(),
        msg.sender,
        msg.recipient,
        msg.content,
        JSON.stringify(msg.metadata),
      ]
    );
    if ((res.rowCount ?? 0) > 0) upserted++;
  }

  if (options?.verbose) {
    console.log(
      `[live-sync] Channel ${channelId}: fetched ${messages.length}, upserted ${upserted}`
    );
  }

  return { fetched: messages.length, upserted };
}
