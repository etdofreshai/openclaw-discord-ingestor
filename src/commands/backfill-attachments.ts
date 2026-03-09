import 'dotenv/config';
import { randomUUID } from 'crypto';
import { loadSession } from '../lib/session.js';
import { validateToken } from '../lib/token-validator.js';
import { syncChannel, fetchChannelMessages } from '../lib/live-sync.js';

type CliOptions = {
  limit?: number;
  batchSize: number;
  dryRun: boolean;
  resumeFrom?: number;
  verbose: boolean;
  refetch?: boolean;  // Fetch from Discord instead of memory DB, update in-place
};

type BackfillStats = {
  messagesProcessed: number;
  messagesWithAttachments: number;
  totalAttachmentsFetched: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
  attachmentsSkipped: number;
  errors: Array<{ message: string; attachmentUrl?: string; messageId?: string }>;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    batchSize: 5,
    dryRun: false,
    verbose: false,
    refetch: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = parseInt(argv[++i] ?? '0', 10);
    else if (a === '--batch-size') opts.batchSize = parseInt(argv[++i] ?? '5', 10);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--resume-from') opts.resumeFrom = parseInt(argv[++i] ?? '1', 10);
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--refetch') opts.refetch = true;  // Fetch from Discord, update in-place
  }

  opts.batchSize = Math.max(1, opts.batchSize);

  return opts;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hasExistingAttachments(apiUrl: string, token: string, recordId: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/messages/${recordId}/attachments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = await res.json() as unknown[] | { attachments?: unknown[] };
    const list = Array.isArray(data) ? data : (data.attachments ?? []);
    return list.length > 0;
  } catch { return false; }
}

/**
 * Fetch messages from Memory DB API with attachments, paginated.
 */
async function fetchDiscordMessagesWithAttachments(
  apiUrl: string,
  token: string,
  page: number,
  limit = 100
): Promise<{
  messages: Array<{
    id: string;
    external_id: string;
    sender: string;
    recipient: string;
    content: string;
    timestamp: string;
    metadata: {
      attachments?: Array<{
        id: string;
        url: string;
        proxy_url?: string;
        filename: string;
        size: number;
        content_type?: string;
      }>;
      channelId?: string;
      [key: string]: unknown;
    };
    record_id: string;
  }>;
  total: number;
  totalPages: number;
}> {
  const url = `${apiUrl}/api/messages?source=discord&limit=${limit}&page=${page}`;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.warn(`[backfill] Rate limited (429) on page ${page}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`API returned ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as any;
      return {
        messages: data.messages || [],
        total: data.total || 0,
        totalPages: data.totalPages || 1,
      };
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to fetch page ${page} after retries`);
}

/**
 * Download a file from Discord CDN.
 */
async function downloadAttachment(
  url: string,
  filename: string,
  maxRetries = 3
): Promise<Buffer> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.log(`[backfill-download] Rate limited on ${filename}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log(`[backfill-download] ✓ Downloaded ${filename} (${buffer.length} bytes)`);
      return buffer;
    } catch (err: any) {
      const errorMsg = String(err?.message ?? 'Unknown error');
      console.log(
        `[backfill-download] Attempt ${attempt + 1}/${maxRetries + 1} failed for ${filename}: ${errorMsg}`
      );
      if (attempt >= maxRetries) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to download ${filename} after retries`);
}

/**
 * Ingest attachment via Memory DB API /api/messages/ingest endpoint.
 */
async function ingestAttachment(
  apiUrl: string,
  token: string,
  messageData: {
    id: string;
    external_id: string;
    sender: string;
    recipient: string;
    content: string;
    timestamp: string;
    metadata: any;
    record_id: string;
  },
  attachmentBuffer: Buffer,
  attachmentMeta: {
    id: string;
    filename: string;
    size: number;
    content_type?: string;
    created_at_source?: string;
  }
): Promise<boolean> {
  console.log(
    `[backfill-ingest] Ingesting ${attachmentMeta.filename} (${attachmentBuffer.length} bytes) ` +
    `for message ${messageData.external_id}`
  );

  // Message payload (reuse across retries)
  const messagePayload = {
    source: 'discord',
    sender: messageData.sender,
    recipient: messageData.recipient,
    content: messageData.content,
    timestamp: messageData.timestamp,
    external_id: messageData.external_id,
    metadata: messageData.metadata,
  };

  // Attachment metadata (reuse across retries)
  const attachmentsMeta = [
    {
      original_file_name: attachmentMeta.filename,
      created_at_source: attachmentMeta.created_at_source,
    },
  ];

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      // Create fresh FormData for each attempt (don't reuse across retries)
      // Use native FormData API (available in Node 18.12+)
      const form = new FormData();
      
      console.log(`[backfill-ingest] Building FormData for ${attachmentMeta.filename}`);
      console.log(`[backfill-ingest] Message payload: ${JSON.stringify(messagePayload)}`);
      console.log(`[backfill-ingest] Attachments meta: ${JSON.stringify(attachmentsMeta)}`);
      
      form.append('message', JSON.stringify(messagePayload));
      form.append('files', new Blob([new Uint8Array(attachmentBuffer)], {
        type: attachmentMeta.content_type || 'application/octet-stream',
      }), attachmentMeta.filename);
      form.append('attachments_meta', JSON.stringify(attachmentsMeta));

      const url = `${apiUrl}/api/messages/ingest`;
      console.log(`[backfill-ingest] POSTing to ${url} with Authorization header`);
      
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: form,
      });

      console.log(`[backfill-ingest] Response status: ${res.status}`);

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.warn(
          `[backfill-ingest] 429 rate limit, waiting ${waitMs}ms (attempt ${attempt + 1}/4)`
        );
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        console.error(`[backfill-ingest] Full response (${res.status}):\n${body}`);
        const errorMsg = `API returned ${res.status}: ${body.slice(0, 500)}`;
        throw new Error(errorMsg);
      }

      console.log(
        `[backfill-ingest] ✓ Successfully ingested ${attachmentMeta.filename}`
      );
      return true;
    } catch (err) {
      if (attempt >= 3) {
        console.error(
          `[backfill-ingest] Failed after 4 attempts: ${(err as any).message}`
        );
        throw err;
      }
      const backoff = 1000 * Math.pow(2, attempt);
      console.warn(
        `[backfill-ingest] Error on attempt ${attempt + 1}, retrying in ${backoff}ms: ` +
        `${(err as any).message}`
      );
      await sleep(backoff);
    }
  }

  throw new Error('Failed to ingest attachment after retries');
}

export type BackfillOptions = {
  batchSize: number;
  limit?: number;
  dryRun: boolean;
  resumeFrom: number;
  attachmentMode?: 'missing' | 'force';
};

export type BackfillProgress = {
  runId: string;
  page: number;
  totalPages: number;
  messagesProcessed: number;
  downloadedCount: number;
  ingestedCount: number;
  skippedCount: number;
  errorCount: number;
  lastEvent?: string;
  startTime: Date;
  currentTime: Date;
  estimatedRemaining?: number;
  recentItems?: Array<{
    filename: string;
    status: 'downloaded' | 'ingested' | 'skipped' | 'error';
    messageId: string;
    size?: number;
  }>;
};

export type RefetchOptions = {
  batchSize: number;
  limit?: number;
  dryRun: boolean;
};

export type RefetchStats = {
  messagesProcessed: number;
  messagesUpdated: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
  attachmentsSkipped: number;
  errors: Array<{ message: string; attachmentUrl?: string; messageId?: string }>;
};

export type ProgressCallback = (progress: BackfillProgress) => void;

/**
 * Main backfill routine - exported for API integration.
 */
export async function backfillAttachments(
  options: BackfillOptions,
  progressCallback?: ProgressCallback
): Promise<BackfillStats> {
  // Validate env vars
  const apiUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  if (!apiUrl || !readToken) {
    throw new Error(
      'Missing environment variables: ' +
      'MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN are required'
    );
  }

  const stats: BackfillStats = {
    messagesProcessed: 0,
    messagesWithAttachments: 0,
    totalAttachmentsFetched: 0,
    attachmentsDownloaded: 0,
    attachmentsIngested: 0,
    attachmentsSkipped: 0,
    errors: [],
  };

  const runId = randomUUID();
  const startPage = options.resumeFrom ?? 1;
  const startTime = new Date();
  const recentItems: Array<{
    filename: string;
    status: 'downloaded' | 'ingested' | 'skipped' | 'error';
    messageId: string;
    size?: number;
  }> = [];
  const MAX_RECENT_ITEMS = 10;

  function addRecentItem(item: {
    filename: string;
    status: 'downloaded' | 'ingested' | 'skipped' | 'error';
    messageId: string;
    size?: number;
  }): void {
    recentItems.push(item);
    if (recentItems.length > MAX_RECENT_ITEMS) {
      recentItems.shift();
    }
  }

  try {
    // Fetch first page to get total pages
    let firstPage = await fetchDiscordMessagesWithAttachments(apiUrl, readToken, 1, 100);

    const totalPages = firstPage.totalPages;
    const maxMessages = options.limit ?? firstPage.total;

    let messagesProcessedTotal = 0;

    for (let page = startPage; page <= totalPages && messagesProcessedTotal < maxMessages; page++) {
      const pageData = await fetchDiscordMessagesWithAttachments(apiUrl, readToken, page, 100);

      for (const message of pageData.messages) {
        if (messagesProcessedTotal >= maxMessages) break;

        stats.messagesProcessed++;
        messagesProcessedTotal++;

        const attachments = message.metadata?.attachments ?? [];
        if (attachments.length === 0) continue;

        if ((options.attachmentMode ?? 'missing') === 'missing') {
          const hasAttachments = await hasExistingAttachments(apiUrl, readToken, message.record_id);
          if (hasAttachments) {
            stats.attachmentsSkipped += attachments.length;
            addRecentItem({ filename: `[skipped] ${message.external_id}`, status: 'skipped', messageId: message.external_id });
            continue;
          }
        }

        stats.messagesWithAttachments++;
        stats.totalAttachmentsFetched += attachments.length;

        // Process attachments in batches
        for (let i = 0; i < attachments.length; i += options.batchSize) {
          const batch = attachments.slice(i, i + options.batchSize);
          const batchPromises = batch.map(async att => {
            try {
              // Try url first (direct CDN), then fallback to proxy_url
              // Both should work, but url is typically more reliable
              const urlToTry = att.url || att.proxy_url;
              if (!urlToTry) {
                throw new Error('Attachment has no url or proxy_url');
              }
              console.log(
                `[backfill-download] ${att.filename} - using ${att.url ? 'url' : 'proxy_url'} (${urlToTry.substring(0, 80)}...)`
              );
              const fileBuffer = await downloadAttachment(urlToTry, att.filename);
              stats.attachmentsDownloaded++;
              addRecentItem({
                filename: att.filename,
                status: 'downloaded',
                messageId: message.external_id,
                size: att.size,
              });

              if (options.dryRun) {
                return;
              }

              await ingestAttachment(
                apiUrl,
                writeToken,
                message,
                fileBuffer,
                {
                  id: att.id,
                  filename: att.filename,
                  size: att.size,
                  content_type: att.content_type || 'application/octet-stream',
                }
              );
              stats.attachmentsIngested++;
              addRecentItem({
                filename: att.filename,
                status: 'ingested',
                messageId: message.external_id,
                size: att.size,
              });
            } catch (err: any) {
              stats.attachmentsSkipped++;
              const errorMsg = String(err?.message ?? 'Unknown error');
              console.error(
                `[backfill] Error processing ${att.filename} (${message.external_id}): ${errorMsg}`
              );
              addRecentItem({
                filename: att.filename,
                status: 'error',
                messageId: message.external_id,
                size: att.size,
              });
              stats.errors.push({
                message: errorMsg,
                attachmentUrl: att.url,
                messageId: message.external_id,
              });
            }
          });

          await Promise.all(batchPromises);
        }
      }

      // Emit progress
      const now = new Date();
      const elapsed = now.getTime() - startTime.getTime();
      const pagesPerMs = page / elapsed;
      const remainingPages = totalPages - page;
      const estimatedRemaining = remainingPages / pagesPerMs;

      if (progressCallback) {
        progressCallback({
          runId,
          page,
          totalPages,
          messagesProcessed: stats.messagesProcessed,
          downloadedCount: stats.attachmentsDownloaded,
          ingestedCount: stats.attachmentsIngested,
          skippedCount: stats.attachmentsSkipped,
          errorCount: stats.errors.length,
          lastEvent: `Page ${page} complete: ${stats.attachmentsDownloaded} downloaded, ${stats.attachmentsIngested} ingested`,
          startTime,
          currentTime: now,
          estimatedRemaining: remainingPages > 0 ? estimatedRemaining : 0,
          recentItems: [...recentItems],
        });
      }
    }

    return stats;
  } catch (err: any) {
    throw new Error(`Backfill failed: ${err.message}`);
  }
}

/**
 * Refetch attachments from Discord with fresh URLs, update in-place, download & ingest.
 * Fetches directly from Discord API (fresh URLs), updates existing rows (no SCD2),
 * downloads attachments, and ingests them in one pass.
 */
export async function refetchAndIngestAttachments(
  session: any, // DiscordSession
  apiUrl: string,
  token: string,
  options: RefetchOptions,
  progressCallback?: (progress: { messagesProcessed: number; downloadedCount: number; ingestedCount: number; lastMessage: string; recentItems?: Array<{ filename: string; messageId: string; status: string; size?: number }> }) => void
): Promise<RefetchStats> {
  console.log('[refetch] Starting refetch mode: Discord → UPDATE in-place → DOWNLOAD → INGEST');

  const stats: RefetchStats = {
    messagesProcessed: 0,
    messagesUpdated: 0,
    attachmentsDownloaded: 0,
    attachmentsIngested: 0,
    attachmentsSkipped: 0,
    errors: [],
  };

  const discordToken = session?.token ?? session?.rest_token;
  if (!session || !discordToken) {
    throw new Error('No Discord session available for refetch. Please log in via /discord-login first.');
  }

  const recentItems: Array<{ filename: string; messageId: string; status: string; size?: number }> = [];

  try {
    const { fetchChannelMessages } = await import('../lib/live-sync.js');
    
    // Get the user's guilds to find channels with attachments
    const guildsReq = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: discordToken },
    });
    
    if (!guildsReq.ok) {
      throw new Error(`Failed to fetch guilds: ${guildsReq.status}`);
    }

    const guilds = await guildsReq.json() as Array<{ id: string; name: string }>;
    console.log(`[refetch] Found ${guilds.length} guilds`);

    let messagesWithAttachmentsCount = 0;
    const maxMessages = options.limit ?? Infinity;

    // Iterate through guilds and channels
    for (const guild of guilds) {
      if (stats.messagesProcessed >= maxMessages) break;

      console.log(`[refetch] Guild: ${guild.name} (${guild.id})`);

      // Get channels in this guild
      const channelsReq = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        headers: { Authorization: discordToken },
      });

      if (!channelsReq.ok) continue;
      
      const channels = await channelsReq.json() as Array<{ id: string; name: string; type: number }>;

      // Type 0 = text channel
      for (const channel of channels.filter((c: any) => c.type === 0)) {
        if (stats.messagesProcessed >= maxMessages) break;

        console.log(`[refetch]   Channel: #${channel.name}`);

        // Fetch messages from this channel
        let hasMore = true;
        let before: string | undefined;
        let pageCount = 0;

        while (hasMore && stats.messagesProcessed < maxMessages) {
          pageCount++;
          const messagesReq = await fetch(
            `https://discord.com/api/v10/channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ''}`,
            { headers: { Authorization: discordToken } }
          );

          if (!messagesReq.ok) break;

          const messages = await messagesReq.json() as Array<any>;
          if (messages.length === 0) break;

          hasMore = messages.length === 100;
          before = messages[messages.length - 1]?.id;

          // Process messages with attachments
          for (const msg of messages) {
            if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) continue;
            if (stats.messagesProcessed >= maxMessages) break;

            stats.messagesProcessed++;
            messagesWithAttachmentsCount++;

            console.log(`[refetch] Message ${msg.id}: ${msg.attachments.length} attachments`);

            // Process each attachment
            for (const att of msg.attachments) {
              if (options.dryRun) {
                console.log(`[refetch-dry-run] Would download & ingest: ${att.filename}`);
                stats.attachmentsSkipped++;
                continue;
              }

              try {
                // Download attachment with fresh URL
                const attBuffer = await downloadAttachment(att.url, att.filename);
                stats.attachmentsDownloaded++;

                // Ingest into memory DB
                await ingestAttachment(
                  apiUrl,
                  token,
                  {
                    id: msg.id,
                    external_id: msg.id,
                    sender: msg.author?.username ?? 'unknown',
                    recipient: `discord-channel:${channel.id}`,
                    content: msg.content ?? '[message with attachments]',
                    timestamp: msg.timestamp,
                    metadata: {
                      channelId: channel.id,
                      author: msg.author,
                      attachments: msg.attachments,
                      embeds: msg.embeds ?? [],
                      mentions: msg.mentions ?? [],
                    },
                    record_id: msg.id, // Placeholder for in-place update
                  },
                  attBuffer,
                  {
                    id: att.id,
                    filename: att.filename,
                    size: att.size,
                    content_type: att.content_type || 'application/octet-stream',
                    created_at_source: msg.timestamp,
                  }
                );

                stats.attachmentsIngested++;
                recentItems.unshift({ filename: att.filename, messageId: msg.id, status: 'ingested', size: att.size });
                if (recentItems.length > 10) recentItems.pop();
              } catch (err: any) {
                const errorMsg = String(err?.message ?? 'Unknown error');
                console.error(`[refetch] Error ingesting ${att.filename}: ${errorMsg}`);
                stats.attachmentsSkipped++;
                stats.errors.push({
                  message: errorMsg,
                  attachmentUrl: att.url,
                  messageId: msg.id,
                });
                recentItems.unshift({ filename: att.filename, messageId: msg.id, status: 'error', size: att.size });
                if (recentItems.length > 10) recentItems.pop();
              }
            }

            // Progress callback
            if (progressCallback) {
              progressCallback({
                messagesProcessed: stats.messagesProcessed,
                downloadedCount: stats.attachmentsDownloaded,
                ingestedCount: stats.attachmentsIngested,
                lastMessage: `Processed message ${msg.id} with ${msg.attachments.length} attachments`,
                recentItems: recentItems.slice(0, 10),
              });
            }
          }
        }

        console.log(`[refetch]   Channel #${channel.name}: ${pageCount} pages fetched`);
      }
    }

    console.log(`[refetch] Complete: ${stats.messagesProcessed} messages with attachments, ${stats.attachmentsIngested} ingested`);
    return stats;
  } catch (err: any) {
    throw new Error(`Refetch failed: ${err.message}`);
  }
}

/**
 * CLI entry point for backwards compatibility.
 */
async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const apiUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  if (!apiUrl || !readToken) {
    console.error(
      'Missing environment variables: ' +
      'MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN are required'
    );
    process.exit(1);
  }

  try {
    if (opts.refetch) {
      // Refetch mode: fetch from Discord API, update in-place, download & ingest
      console.log('[refetch] Refetch mode: Discord API → UPDATE in-place → DOWNLOAD → INGEST');
      
      const session = await loadSession();
      if (!session) {
        console.error('[refetch] No Discord session found. Please log in via /discord-login first.');
        process.exit(1);
      }
      
      const user = await validateToken(session);
      if (!user) {
        console.error('[refetch] Discord token validation failed. Please log in again.');
        process.exit(1);
      }
      
      console.log(`[refetch] Authenticated as ${user.username}#${user.discriminator}`);
      
      const stats = await refetchAndIngestAttachments(
        session,
        apiUrl,
        writeToken,
        {
          batchSize: opts.batchSize,
          limit: opts.limit,
          dryRun: opts.dryRun,
        },
        (progress) => {
          if (opts.verbose) {
            console.log(
              `[refetch] ${progress.messagesProcessed} messages, ` +
              `${progress.downloadedCount} downloaded, ${progress.ingestedCount} ingested`
            );
          }
        }
      );

      console.log('');
      console.log('[refetch] Refetch complete!');
      console.log(JSON.stringify(stats, null, 2));

      if (stats.errors.length > 0) {
        console.warn(`[refetch] ${stats.errors.length} errors encountered`);
        process.exit(1);
      }
    } else {
      // Original backfill mode: read from memory DB API
      if (readToken === writeToken) {
        console.log('[backfill] Using MEMORY_DATABASE_API_TOKEN for both read and write');
      } else {
        console.log('[backfill] Using separate read and write tokens');
      }

      const stats = await backfillAttachments(
        {
          batchSize: opts.batchSize,
          limit: opts.limit,
          dryRun: opts.dryRun,
          resumeFrom: opts.resumeFrom ?? 1,
        },
        (progress) => {
          if (opts.verbose) {
            console.log(
              `[backfill] Page ${progress.page}/${progress.totalPages}: ` +
              `${progress.downloadedCount} downloaded, ${progress.ingestedCount} ingested`
            );
          }
        }
      );

      console.log('');
      console.log('[backfill] Backfill complete!');
      console.log(JSON.stringify(stats, null, 2));

      if (stats.errors.length > 0) {
        process.exit(1);
      }
    }
  } catch (err: any) {
    console.error('[backfill/refetch] Fatal error:', err.message);
    process.exit(1);
  }
}

// Only run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
