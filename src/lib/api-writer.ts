/**
 * Memory Database API write module.
 *
 * Writes normalized Discord messages to the Memory Database API instead of
 * directly to PostgreSQL. Enabled when both MEMORY_DATABASE_API_URL and
 * MEMORY_DATABASE_API_TOKEN are set in the environment.
 *
 * Mode precedence:
 *   1. API mode  — MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN both set
 *   2. PG mode   — fallback; DATABASE_URL required
 *
 * Metric caveats (API mode):
 *   - `inserted`  → HTTP 201 (Created) response from the API
 *   - `updated`   → HTTP 200 (OK) or 409 (Conflict) responses (existing record)
 *   - `skipped`   → unrecoverable errors (bad request, exhausted retries, etc.)
 *   - If the API always returns 200 for upserts (never 201), all successful
 *     writes will appear as `updated` and `inserted` will be 0. The sum
 *     inserted + updated + skipped always equals `fetched`.
 */

/** Maximum number of retries on transient failures (429, 5xx, network errors). */
const MAX_API_RETRIES = 3;
/** Initial exponential-backoff delay in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;

/**
 * Returns true when API mode is active:
 * both MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN are set.
 */
export function isApiMode(): boolean {
  return !!(
    process.env.MEMORY_DATABASE_API_URL?.trim() &&
    process.env.MEMORY_DATABASE_API_TOKEN?.trim()
  );
}

/** Payload sent to POST /api/messages. */
export type ApiMessagePayload = {
  source: 'discord';
  sender: string;
  recipient: string;
  content: string;
  /** ISO 8601 timestamp string. */
  timestamp: string;
  external_id: string;
  metadata: Record<string, unknown>;
};

/** A Discord attachment object as returned by the Discord API. */
export type DiscordAttachmentRef = {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url?: string;
  content_type?: string;
  [k: string]: unknown;
};

/** Write result for a single message — for internal use. */
type SingleWriteOutcome = 'inserted' | 'updated' | 'skipped';

/** Aggregate write result returned to callers. */
export type ApiWriteResult = {
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
};

/**
 * Download a file from Discord CDN with retry/backoff.
 */
async function downloadDiscordFile(url: string, filename: string, maxRetries = 3): Promise<Buffer> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.warn(`[api-writer] Rate limited downloading ${filename}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`[api-writer] ✓ Downloaded ${filename} (${buf.length} bytes)`);
      return buf;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[api-writer] Attempt ${attempt + 1}/${maxRetries + 1} failed for ${filename}: ${msg}`
      );
      if (attempt >= maxRetries) throw err;
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to download ${filename} after retries`);
}

/**
 * Ingest a single file attachment via POST /api/messages/ingest (multipart).
 * Returns true on success, false on failure.
 */
async function ingestOneFile(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload,
  fileBuffer: Buffer,
  attachment: DiscordAttachmentRef,
  conflictMode?: ConflictMode
): Promise<boolean> {
  const mode = conflictMode || getConflictMode();
  const qs = `?conflict_mode=${mode}`;
  const filename = attachment.filename || 'attachment';
  const contentType = attachment.content_type || 'application/octet-stream';
  const attachmentsMeta = [
    {
      original_file_name: filename,
      created_at_source: payload.timestamp,
    },
  ];

  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      const form = new FormData();
      form.append('message', JSON.stringify(payload));
      form.append(
        'files',
        new Blob([new Uint8Array(fileBuffer)], { type: contentType }),
        filename
      );
      form.append('attachments_meta', JSON.stringify(attachmentsMeta));

      const res = await fetch(`${baseUrl}/api/messages/ingest${qs}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'openclaw-discord-ingestor/1.0',
        },
        body: form,
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.warn(
          `[api-writer] 429 rate limit on ingest for ${filename}, waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_API_RETRIES + 1})`
        );
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API returned ${res.status}: ${body.slice(0, 500)}`);
      }

      console.log(`[api-writer] ✓ Ingested attachment ${filename} for ${payload.external_id}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_API_RETRIES) {
        console.error(
          `[api-writer] Failed to ingest ${filename} for ${payload.external_id}: ${msg}`
        );
        return false;
      }
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(
        `[api-writer] Error ingesting ${filename} (attempt ${attempt + 1}), retrying in ${backoff}ms: ${msg}`
      );
      await sleep(backoff);
    }
  }

  return false;
}

/** Conflict mode for the Memory Database API. */
export type ConflictMode = 'skip_or_append' | 'skip_or_overwrite';

/** Resolve conflict_mode from env var, falling back to provided default or 'skip_or_append'. */
export function getConflictMode(override?: string): ConflictMode {
  const raw = override || process.env.CONFLICT_MODE || 'skip_or_append';
  return raw === 'skip_or_overwrite' ? 'skip_or_overwrite' : 'skip_or_append';
}

/**
 * Write a single message to the API with retry/backoff.
 * Returns 'inserted', 'updated', or 'skipped'.
 */
async function writeOneMessage(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload,
  conflictMode?: ConflictMode
): Promise<SingleWriteOutcome> {
  const mode = conflictMode || getConflictMode();
  const qs = mode !== 'skip_or_append' ? `?conflict_mode=${mode}` : '';
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    let res: Response;

    try {
      res = await fetch(`${baseUrl}/api/messages${qs}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      // Network-level error (ECONNREFUSED, DNS, timeout, etc.)
      if (attempt >= MAX_API_RETRIES) {
        console.error(
          `[api-writer] Network error for external_id=${payload.external_id} — ` +
            `exhausted ${MAX_API_RETRIES} retries:`,
          err
        );
        return 'skipped';
      }
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(
        `[api-writer] Network error for external_id=${payload.external_id} — ` +
          `retry ${attempt + 1}/${MAX_API_RETRIES} in ${backoff}ms`
      );
      await sleep(backoff);
      continue;
    }

    // 429 — rate limited
    if (res.status === 429) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(
          `[api-writer] 429 rate-limited for external_id=${payload.external_id} — ` +
            `exhausted ${MAX_API_RETRIES} retries`
        );
        return 'skipped';
      }
      const retryHeader =
        res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset-after') ?? '5';
      const waitMs = Math.ceil((parseFloat(retryHeader) || 5) * 1_000) + 500;
      console.warn(
        `[api-writer] 429 rate-limited — external_id=${payload.external_id} ` +
          `retry-after=${retryHeader}s — waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_API_RETRIES}`
      );
      await sleep(waitMs);
      continue;
    }

    // 5xx — transient server error
    if (res.status >= 500) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(
          `[api-writer] API error ${res.status} for external_id=${payload.external_id} — ` +
            `exhausted ${MAX_API_RETRIES} retries`
        );
        return 'skipped';
      }
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(
        `[api-writer] API error ${res.status} for external_id=${payload.external_id} — ` +
          `retry ${attempt + 1}/${MAX_API_RETRIES} in ${backoff}ms`
      );
      await sleep(backoff);
      continue;
    }

    // 201 Created — new record inserted
    if (res.status === 201) return 'inserted';

    // 200 OK — upsert returned existing record (treat as updated)
    if (res.status === 200) return 'updated';

    // 409 Conflict — already exists, treat as updated
    if (res.status === 409) return 'updated';

    // Other 4xx — unrecoverable (bad payload, auth failure, etc.)
    const body = await res.text().catch(() => '');
    console.error(
      `[api-writer] Unrecoverable API error ${res.status} for ` +
        `external_id=${payload.external_id}: ${body.slice(0, 200)}`
    );
    return 'skipped';
  }

  // Exhausted retry loop without resolving (should not reach here, but safe fallback)
  return 'skipped';
}

/**
 * Write a message that has Discord file attachments.
 *
 * For each attachment:
 *   1. Download from Discord CDN
 *   2. POST to /api/messages/ingest (multipart) to link it to the message
 *
 * If ALL attachments fail, falls back to plain JSON write so the message text
 * is still persisted.
 */
async function writeMessageWithAttachments(
  baseUrl: string,
  writeToken: string,
  payload: ApiMessagePayload,
  attachments: DiscordAttachmentRef[],
  conflictMode?: ConflictMode
): Promise<{
  outcome: SingleWriteOutcome;
  downloaded: number;
  ingested: number;
}> {
  let downloaded = 0;
  let ingested = 0;

  for (const att of attachments) {
    const downloadUrl = att.url || att.proxy_url;
    if (!downloadUrl) {
      console.warn(
        `[api-writer] No URL for attachment ${att.filename} in message ${payload.external_id} — skipping`
      );
      continue;
    }

    let fileBuffer: Buffer;
    try {
      fileBuffer = await downloadDiscordFile(downloadUrl, att.filename);
      downloaded++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[api-writer] Failed to download ${att.filename} for ${payload.external_id}: ${msg} — skipping`
      );
      continue;
    }

    const ok = await ingestOneFile(baseUrl, writeToken, payload, fileBuffer, att, conflictMode);
    if (ok) ingested++;
  }

  // If at least one attachment ingested, the message is written (ingest upserts it)
  if (ingested > 0) {
    return { outcome: 'updated', downloaded, ingested };
  }

  // All attachments failed — fall back to plain JSON write so message text is preserved
  console.warn(
    `[api-writer] All attachment ingests failed for ${payload.external_id} — falling back to plain JSON write`
  );
  const outcome = await writeOneMessage(baseUrl, writeToken, payload, conflictMode);
  return { outcome, downloaded, ingested };
}

/**
 * Write a batch of normalized Discord messages to the Memory Database API.
 * Messages with attachments are ingested via multipart /api/messages/ingest
 * so the files are downloaded, stored, and linked in message_attachment_links.
 * Messages without attachments are written via plain JSON POST /api/messages.
 *
 * @param payloads     - Array of `{ payload, attachmentCount, attachments? }` pairs to write.
 * @returns            - Aggregate result: inserted, updated, skipped, attachmentsSeen,
 *                       attachmentsDownloaded, attachmentsIngested.
 */
export async function writeMessagesViaApi(
  payloads: Array<{
    payload: ApiMessagePayload;
    attachmentCount: number;
    attachments?: DiscordAttachmentRef[];
  }>,
  conflictMode?: ConflictMode
): Promise<ApiWriteResult> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;
  const mode = conflictMode || getConflictMode();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;
  let attachmentsDownloaded = 0;
  let attachmentsIngested = 0;

  for (const { payload, attachmentCount, attachments } of payloads) {
    attachmentsSeen += attachmentCount;

    if (attachmentCount > 0 && attachments && attachments.length > 0) {
      const { outcome, downloaded, ingested } = await writeMessageWithAttachments(
        baseUrl,
        writeToken,
        payload,
        attachments,
        mode
      );
      attachmentsDownloaded += downloaded;
      attachmentsIngested += ingested;
      if (outcome === 'inserted') inserted++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    } else {
      const outcome = await writeOneMessage(baseUrl, writeToken, payload, mode);
      if (outcome === 'inserted') inserted++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    }
  }

  return { inserted, updated, skipped, attachmentsSeen, attachmentsDownloaded, attachmentsIngested };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
