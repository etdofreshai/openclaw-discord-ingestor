import pg from 'pg';
import type { DiscordSession } from './session.js';
import { isApiMode, writeMessagesViaApi, type ApiMessagePayload, type DiscordAttachmentRef } from './api-writer.js';

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

/** Normalized Discord message ready to be written to any backend. */
export type Normalized = {
  externalId: string;
  timestamp: Date;
  sender: string;
  recipient: string;
  content: string;
  metadata: Record<string, unknown>;
  attachmentCount: number;
  /** Raw Discord attachment objects (url, filename, size, content_type, etc.) */
  attachments: DiscordAttachmentRef[];
};

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
}

/**
 * Post channel metadata to the Memory Database API for name resolution.
 */
async function postChannelMetadata(channelId: string, channelName: string | null, guildId: string | null, guildName: string | null): Promise<void> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;
  if (!baseUrl || !writeToken) return;

  try {
    const res = await fetch(`${baseUrl}/api/discord/channels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeToken}`,
      },
      body: JSON.stringify({ channelId, channelName, guildId, guildName }),
    });
    if (res.ok) {
      console.log(`[live-sync] ✓ Posted channel metadata: #${channelName || channelId}`);
    } else {
      console.warn(`[live-sync] Failed to post channel metadata: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[live-sync] Error posting channel metadata:`, err);
  }
}

/**
 * Fetch full channel info (name + guild) from Discord API.
 */
async function fetchChannelInfo(
  session: DiscordSession,
  channelId: string
): Promise<{ channelName: string | null; guildId: string | null }> {
  const url = `https://discord.com/api/v10/channels/${channelId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: session.token } });
    if (!res.ok) return { channelName: null, guildId: null };
    const data = await res.json() as any;
    return {
      channelName: data.name?.trim() || null,
      guildId: data.guild_id?.trim() || null,
    };
  } catch {
    return { channelName: null, guildId: null };
  }
}

/**
 * Fetch guild name from Discord API.
 */
async function fetchGuildName(session: DiscordSession, guildId: string): Promise<string | null> {
  const url = `https://discord.com/api/v10/guilds/${guildId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: session.token } });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.name?.trim() || null;
  } catch {
    return null;
  }
}

export async function fetchChannelName(
  session: DiscordSession,
  channelId: string
): Promise<string | null> {
  const url = `https://discord.com/api/v10/channels/${channelId}`;

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: session.token },
    });

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) return null;
      await waitForRateLimit(res, attempt, channelId);
      continue;
    }

    if (!res.ok) return null;

    const data = (await res.json()) as {
      name?: string;
      id?: string;
      type?: number;
      recipients?: Array<{ username?: string }>;
    };
    if (data.name && data.name.trim()) return data.name.trim();
    if (Array.isArray(data.recipients) && data.recipients.length > 0) {
      const names = data.recipients.map(r => r.username).filter(Boolean) as string[];
      if (names.length) return names.join(', ');
    }
    return data.id || null;
  }

  return null;
}

/** Maximum number of times to retry after a 429 rate-limit response. */
const MAX_429_RETRIES = 3;

/**
 * Wait for the delay indicated by the Discord rate-limit headers.
 * Uses `Retry-After` (seconds, integer) or `X-RateLimit-Reset-After` (seconds, float).
 * Falls back to 5 seconds if no header is present.
 * Adds a 500 ms safety buffer on top of the indicated wait.
 */
async function waitForRateLimit(res: Response, attempt: number, channelId: string): Promise<void> {
  const retryHeader =
    res.headers.get('retry-after') ??
    res.headers.get('x-ratelimit-reset-after') ??
    '5';
  const retrySecs = parseFloat(retryHeader);
  const waitMs = Math.ceil((Number.isFinite(retrySecs) ? retrySecs : 5) * 1000) + 500;

  console.warn(
    `[live-sync] 429 rate-limited — channel=${channelId} ` +
    `retry-after=${retryHeader}s — waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_429_RETRIES}`
  );

  await new Promise<void>(resolve => setTimeout(resolve, waitMs));
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

  const url = `https://discord.com/api/v10/channels/${channelId}/messages?${params}`;

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: session.token },
    });

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        throw new Error(
          `Discord rate-limited (429) on channel ${channelId} — ` +
          `exhausted ${MAX_429_RETRIES} retries`
        );
      }
      await waitForRateLimit(res, attempt, channelId);
      continue; // retry
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch messages: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as DiscordAPIMessage[];
  }

  // Unreachable — the loop above always returns or throws
  throw new Error(`fetchChannelMessages: unexpected exit from retry loop (channel=${channelId})`);
}

function normalize(msg: DiscordAPIMessage): Normalized {
  const timestamp = new Date(msg.timestamp);
  const sender =
    msg.author.global_name?.trim() ||
    msg.author.username?.trim() ||
    msg.author.id ||
    'unknown';

  const recipient = `discord-channel:${msg.channel_id}`;
  const rawAttachments = Array.isArray(msg.attachments) ? (msg.attachments as DiscordAttachmentRef[]) : [];
  const attachmentCount = rawAttachments.length;
  const hasRich = attachmentCount > 0 || (msg.embeds?.length ?? 0) > 0;
  const content = msg.content?.trim() || (hasRich ? '[non-text discord message]' : '');

  return {
    externalId: msg.id,
    timestamp,
    sender,
    recipient,
    content,
    attachmentCount,
    attachments: rawAttachments,
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

/**
 * Fetch and normalize messages from a Discord channel.
 * Pure fetch/normalize — no side effects on any backend.
 */
async function fetchAndNormalize(
  session: DiscordSession,
  channelId: string,
  options?: { limit?: number; before?: string; after?: string }
): Promise<Normalized[]> {
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

  return messages.map(normalize);
}

/**
 * Write normalized messages to PostgreSQL via direct upsert.
 */
async function writeToPostgres(
  pool: pg.Pool,
  normalized: Normalized[]
): Promise<{ inserted: number; updated: number; skipped: number; attachmentsSeen: number; attachmentsDownloaded: number; attachmentsIngested: number }> {
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

  return { inserted, updated, skipped, attachmentsSeen, attachmentsDownloaded: 0, attachmentsIngested: 0 };
}

/**
 * Unified channel sync: fetch from Discord and write to the configured backend.
 *
 * Write mode is selected automatically based on environment variables:
 *   - API mode  (preferred): MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN
 *   - PG mode   (fallback) : DATABASE_URL
 *
 * In PG mode a short-lived `pg.Pool` is created and destroyed per call.
 * In API mode no database connection is needed.
 */
export async function syncChannel(
  session: DiscordSession,
  channelId: string,
  options?: { limit?: number; before?: string; after?: string; verbose?: boolean; conflictMode?: string }
): Promise<SyncResult> {
  const normalized = await fetchAndNormalize(session, channelId, options);

    let result: SyncResult;

  if (isApiMode()) {
    // ── API write mode ───────────────────────────────────────────────────────
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
      attachmentCount: msg.attachmentCount,
      attachments: msg.attachments,
    }));

    const writeResult = await writeMessagesViaApi(inputs, options?.conflictMode as any);
    result = { fetched: normalized.length, ...writeResult };
  } else {
    // ── PostgreSQL write mode ────────────────────────────────────────────────
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not configured and API mode (MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN) is not active.'
      );
    }

    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const writeResult = await writeToPostgres(pool, normalized);
      result = { fetched: normalized.length, ...writeResult };
    } finally {
      await pool.end();
    }
  }

  if (options?.verbose) {
    const mode = isApiMode() ? 'api' : 'pg';
    console.log(
      `[live-sync] Channel ${channelId} [${mode}]: fetched ${result.fetched}, ` +
      `inserted ${result.inserted}, updated ${result.updated}, ` +
      `skipped ${result.skipped}, attachmentsSeen ${result.attachmentsSeen}, ` +
      `attachmentsDownloaded ${result.attachmentsDownloaded}, attachmentsIngested ${result.attachmentsIngested}`
    );
  }

  return result;
}

/**
 * PG-only channel sync (legacy — requires an explicit pg.Pool).
 * Prefer `syncChannel()` for new code; it selects the write backend automatically.
 */
export async function syncChannelToDB(
  pool: pg.Pool,
  session: DiscordSession,
  channelId: string,
  options?: { limit?: number; before?: string; after?: string; verbose?: boolean }
): Promise<SyncResult> {
  const normalized = await fetchAndNormalize(session, channelId, options);
  const writeResult = await writeToPostgres(pool, normalized);
  const result: SyncResult = { fetched: normalized.length, ...writeResult };

  if (options?.verbose) {
    console.log(
      `[live-sync] Channel ${channelId} [pg]: fetched ${result.fetched}, ` +
      `inserted ${result.inserted}, updated ${result.updated}, ` +
      `skipped ${result.skipped}, attachmentsSeen ${result.attachmentsSeen}`
    );
  }

  return result;
}
