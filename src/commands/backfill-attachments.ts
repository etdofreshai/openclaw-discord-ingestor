import 'dotenv/config';
import FormData from 'form-data';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';

type CliOptions = {
  limit?: number;
  batchSize: number;
  dryRun: boolean;
  resumeFrom?: number;
  verbose: boolean;
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
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = parseInt(argv[++i] ?? '0', 10);
    else if (a === '--batch-size') opts.batchSize = parseInt(argv[++i] ?? '5', 10);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--resume-from') opts.resumeFrom = parseInt(argv[++i] ?? '1', 10);
    else if (a === '--verbose') opts.verbose = true;
  }

  opts.batchSize = Math.max(1, opts.batchSize);

  return opts;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      const res = await fetch(url);

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return buffer;
    } catch (err) {
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
  const form = new FormData();

  // Message payload
  const messagePayload = {
    source: 'discord',
    sender: messageData.sender,
    recipient: messageData.recipient,
    content: messageData.content,
    timestamp: messageData.timestamp,
    external_id: messageData.external_id,
    metadata: messageData.metadata,
  };

  form.append('message', JSON.stringify(messagePayload));

  // Attachment file
  const stream = Readable.from(attachmentBuffer);
  form.append('files', stream, {
    filename: attachmentMeta.filename,
    contentType: attachmentMeta.content_type || 'application/octet-stream',
  });

  // Attachment metadata
  const attachmentsMeta = [
    {
      original_file_name: attachmentMeta.filename,
      created_at_source: attachmentMeta.created_at_source,
    },
  ];

  form.append('attachments_meta', JSON.stringify(attachmentsMeta));

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${apiUrl}/api/messages/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        body: form as any,
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API returned ${res.status}: ${body.slice(0, 100)}`);
      }

      return true;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error('Failed to ingest attachment after retries');
}

export type BackfillOptions = {
  batchSize: number;
  limit?: number;
  dryRun: boolean;
  resumeFrom: number;
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

        stats.messagesWithAttachments++;
        stats.totalAttachmentsFetched += attachments.length;

        // Process attachments in batches
        for (let i = 0; i < attachments.length; i += options.batchSize) {
          const batch = attachments.slice(i, i + options.batchSize);
          const batchPromises = batch.map(async att => {
            try {
              const url = att.url || att.proxy_url;
              if (!url) {
                throw new Error('Attachment has no url or proxy_url');
              }
              const fileBuffer = await downloadAttachment(url, att.filename);
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
              addRecentItem({
                filename: att.filename,
                status: 'error',
                messageId: message.external_id,
                size: att.size,
              });
              stats.errors.push({
                message: String(err?.message ?? 'Unknown error'),
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

  if (readToken === writeToken) {
    console.log('[backfill] Using MEMORY_DATABASE_API_TOKEN for both read and write');
  } else {
    console.log('[backfill] Using separate read and write tokens');
  }

  try {
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
  } catch (err: any) {
    console.error('[backfill] Fatal error:', err.message);
    process.exit(1);
  }
}

// Only run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
