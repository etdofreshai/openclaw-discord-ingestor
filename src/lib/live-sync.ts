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
  attachmentCount: number;
};

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
}

export async function fetchChannelName(
  session: DiscordSession,
  channelId: string
): Promise<string | null> {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
    headers: {
      Authorization: session.token,
    },
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { name?: string; id?: string; type?: number; recipients?: Array<{ username?: string }> };
  if (data.name && data.name.trim()) return data.name.trim();
  if (Array.isArray(data.recipients) && data.recipients.length > 0) {
    const names = data.recipients.map(r => r.username).filter(Boolean) as string[];
    if (names.length) return names.join(', ');
  }
  return data.id || null;
}

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
  const attachmentCount = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
  const hasRich = attachmentCount > 0 || (msg.embeds?.length ?? 0) > 0;
  const content = msg.content?.trim() || (hasRich ? '[non-text discord message]' : '');

  return {
    externalId: msg.id,
    timestamp,
    sender,
    recipient,
    content,
    attachmentCount,
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
): Promise<SyncResult> {
  const requested = Math.max(1, options?.limit || 100);

  const messages: DiscordAPIMessage[] = [];
  const seenIds = new Set<string>();

  // Pagination strategy:
  // - Default / before-mode: paginate backwards using `before` cursor
  // - after-mode (no before): paginate forwards using `after` cursor
  let cursorBefore = options?.before;
  let cursorAfter = options?.after;

  while (messages.length < requested) {
    const remaining = requested - messages.length;
    const page = await fetchChannelMessages(session, channelId, {
      limit: Math.min(remaining, 100),
      before: cursorBefore,
      after: cursorAfter,
    });

    if (page.length === 0) break;

    for (const msg of page) {
      if (!seenIds.has(msg.id)) {
        seenIds.add(msg.id);
        messages.push(msg);
      }
    }

    // Advance cursor for next page
    if (cursorAfter && !cursorBefore) {
      // forward pagination: move `after` to newest id seen on this page
      let maxId = page[0]?.id;
      for (const m of page) {
        if (maxId === undefined || BigInt(m.id) > BigInt(maxId)) maxId = m.id;
      }
      cursorAfter = maxId;
    } else {
      // backward pagination: move `before` to oldest id seen on this page
      let minId = page[0]?.id;
      for (const m of page) {
        if (minId === undefined || BigInt(m.id) < BigInt(minId)) minId = m.id;
      }
      cursorBefore = minId;
    }

    // Safety break if page was short; likely reached boundary
    if (page.length < Math.min(remaining, 100)) break;
  }

  const normalized = messages.map(normalize);

  const sourceId = await ensureSourceId(pool);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;

  for (const msg of normalized) {
    attachmentsSeen += msg.attachmentCount;

    const res = await pool.query<{ xmax: string }>(
      `INSERT INTO messages (source_id, external_id, timestamp, sender, recipient, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_id, external_id)
       DO UPDATE SET
         timestamp = EXCLUDED.timestamp,
         sender = EXCLUDED.sender,
         recipient = EXCLUDED.recipient,
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata
       RETURNING xmax`,
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

    if ((res.rowCount ?? 0) > 0) {
      // xmax = '0' means a fresh insert; non-zero means an update
      if (res.rows[0].xmax === '0') {
        inserted++;
      } else {
        updated++;
      }
    } else {
      skipped++;
    }
  }

  const result: SyncResult = {
    fetched: messages.length,
    inserted,
    updated,
    skipped,
    attachmentsSeen,
  };

  if (options?.verbose) {
    console.log(
      `[live-sync] Channel ${channelId}: fetched ${result.fetched}, inserted ${result.inserted}, updated ${result.updated}, skipped ${result.skipped}, attachmentsSeen ${result.attachmentsSeen}`
    );
  }

  return result;
}
