# openclaw-discord-ingestor

Standalone Discord → OpenClaw memory DB ingestor.

Imports Discord messages into the existing OpenClaw PostgreSQL `messages` table using either **JSON export files** or **live API sync** with a captured user session. Includes a full-featured web UI with scheduled jobs, run logs, and optional token authentication.

---

## Features

### JSON Import
- Recursive JSON discovery under an input directory
- Detects files containing a `messages` array
- Normalizes Discord messages to the OpenClaw `messages` schema
- Idempotent upsert via `(source_id, external_id)`
- Auto-creates `discord` source in `sources` table if missing
- Dry-run mode for safe validation

### Live Sync
- Browser-driven login capture via Chromium
- Token persisted locally (`.data/chrome-profile/discord-session.json`)
- Token validation against Discord API `/users/@me`
- Pull messages from any channel ID
- Idempotent upsert into messages table

### Web UI (v0.4)
- **Sync form** with Manual Run or Scheduled Job mode
- **Auth modal** — shown only when `UI_TOKEN` is set; saves token to `localStorage`
- **Scheduled jobs** — persisted to `.data/jobs/jobs.json`, auto-scheduled on server start
- **Cadence presets** — compact-label dropdown (1M → 1Y); boundary-aligned UTC scheduling
- **Since presets** — compact-label dropdown (1M → ALL); unified format with cadence
- **Compact labels** — both cadence and since dropdowns use short labels: 1M, 5M, 15M, 30M, 1H, 2H, 4H, 6H, 12H, 1D, 3D, 1W, 2W, 1MO, 2MO, 3MO, 4MO, 6MO, 1Y, 3Y, 5Y, 10Y, 20Y, ALL
- **Auto-name** — blank job name auto-generates from channel + cadence (e.g. `#general every 1H`)
- **Run logs** — every sync recorded with metrics in `.data/runs/runs.json`
- **Jobs table** — list, run, **edit**, enable/disable, and delete scheduled jobs
- **Edit modal** — per-row ✏ Edit button opens a modal to update name, channel, cadence, since, and enabled state
- **Link cadence + since** — checkbox in the edit modal keeps Since in sync with Cadence (default ON when they match)
- **Runs table** — last 50 runs with counts (fetched, inserted, updated, skipped, attachments)
- **Auto-refresh** every 30 seconds

---

## Install

```bash
npm install
```

## Configure

Create `.env`:

```env
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
LOGIN_SERVER_PORT=3456
CDP_PORT=9222
# Optional: if set, API endpoints require Bearer token auth. Leave unset to disable auth.
UI_TOKEN=your-secret-token-here
```

---

## Usage

### 0. Web UI — Sync Interface

Start the server, then open:

```
http://localhost:3456/sync
```

#### Auth behavior

| `UI_TOKEN` set? | Behavior |
|----------------|----------|
| **No** | No auth UI — page and all API routes are open |
| **Yes** | Auth modal appears on first visit; token saved to `localStorage`; Clear Token button visible; all API calls use the saved token automatically |

> The modal validates the token against the server before saving it. Once saved, it persists in the browser until you clear it.

#### Manual Run

1. Select **"Manual Run"** in the mode dropdown (default)
2. Fill in Channel ID and optional Limit / Since / After / Before
3. Click **▶ Run Sync**
4. Result appears immediately below the form; run is logged to the Runs table

#### Scheduled Job

1. Select **"Scheduled Job"** in the mode dropdown
2. Fill in **Channel ID** (required) and select a **Cadence** (required)
3. Optionally enter a **Job Name** — if left blank, one is auto-generated as `#<channelName> every <cadence>` (e.g., `#general every 1H`)
4. Optionally select a **Since** lookback window — if left blank, defaults to the same value as cadence
5. Click **📅 Create Scheduled Job**
6. Job appears in the Scheduled Jobs table; it fires automatically at the next UTC boundary for the cadence
7. Jobs survive server restarts — timers are rehydrated from `.data/jobs/jobs.json`

> **Limit / After / Before fields are hidden in Scheduled Job mode.** Scheduled jobs use `channel + cadence + since` only. These fields remain supported for Manual Run mode and via the API directly.

#### Editing a Scheduled Job

Each row in the Scheduled Jobs table has a **✏ Edit** button that opens the Edit modal:

1. Click **✏ Edit** on any job row
2. In the modal, update any combination of:
   - **Job Name** — human-readable label stored with the job
   - **Channel ID** — Discord channel to sync
   - **Cadence** — how often the job runs (compact dropdown: 1M → 1Y)
   - **Since** — lookback window per run (compact dropdown: 1M → ALL)
   - **Enabled** — checkbox to pause or resume the job
3. The **Link 🔗** checkbox (between Cadence and Since) keeps Since in sync with Cadence:
   - **Link ON**: Since is disabled and always mirrors Cadence. Changing Cadence also updates Since.
   - **Link OFF**: Since is independent and freely selectable.
   - **Default**: Link is ON automatically when the job's current Cadence and Since match (or Since is unset and inherits from Cadence).
4. Click **Save Changes** — the job is updated and the scheduler re-schedules it immediately.
5. Click **Cancel** or click outside the modal to dismiss without saving.

---

## Cadence Presets

Scheduled jobs fire at **natural UTC boundaries**, not "now + interval" drift.
This means the run times are predictable and consistent across server restarts.

The UI uses compact labels in all dropdowns. The compact format: `1M`, `5M`, `15M`, `30M`, `1H`, `2H`, `4H`, `6H`, `12H`, `1D`, `3D`, `1W`, `2W`, `1MO`, `2MO`, `3MO`, `4MO`, `6MO`, `1Y`.

| Preset | UI Label | Boundary Rule (UTC) | `intervalMinutes` |
|--------|----------|---------------------|:-----------------:|
| `1m`   | 1M  | HH:MM:00 each minute             | 1      |
| `5m`   | 5M  | minute % 5 == 0                  | 5      |
| `15m`  | 15M | :00/:15/:30/:45 each hour        | 15     |
| `30m`  | 30M | :00/:30 each hour                | 30     |
| `1h`   | 1H  | top of each hour                 | 60     |
| `2h`   | 2H  | hour % 2 == 0                    | 120    |
| `4h`   | 4H  | hour % 4 == 0                    | 240    |
| `6h`   | 6H  | hour % 6 == 0                    | 360    |
| `12h`  | 12H | midnight & noon                  | 720    |
| `1d`   | 1D  | midnight UTC                     | 1440   |
| `3d`   | 3D  | every 3rd day from Unix epoch, midnight UTC | 4320 |
| `1w`   | 1W  | Monday 00:00 UTC                 | 10080  |
| `2w`   | 2W  | biweekly Monday 00:00 UTC ¹      | 20160  |
| `1mo`  | 1MO | 1st of each month, 00:00 UTC     | 43200  |
| `2mo`  | 2MO | 1st of Jan/Mar/May/Jul/Sep/Nov, 00:00 UTC | 86400 |
| `3mo`  | 3MO | 1st of Jan/Apr/Jul/Oct, 00:00 UTC | 129600 |
| `4mo`  | 4MO | 1st of Jan/May/Sep, 00:00 UTC    | 172800 |
| `6mo`  | 6MO | 1st of Jan/Jul, 00:00 UTC        | 259200 |
| `1y`   | 1Y  | Jan 1, 00:00 UTC                 | 525960 |

¹ Biweekly anchor: **1970-01-05** (Monday, 4 days after Unix epoch). Two-week cycles count forward from this date.

### Boundary Examples

| It is… | Cadence | Next run |
|--------|---------|----------|
| 14:03:47 UTC | `1h`  | 15:00:00 UTC |
| 14:03:47 UTC | `15m` | 14:15:00 UTC |
| 14:03:47 UTC | `1d`  | 2024-02-01 00:00:00 UTC (next midnight) |
| Wed 14:03 UTC | `1w`  | Mon 00:00 UTC (next Monday) |
| Jan 15 UTC | `1mo` | Feb 1 00:00 UTC |
| Feb 15 UTC | `3mo` | Apr 1 00:00 UTC |

### Timezone

All boundaries are computed in **UTC**. The server has no concept of local timezone for scheduling.
If you need a local-timezone anchor (e.g., midnight CST), schedule the job manually via `POST /api/jobs` with the desired `intervalMinutes` and no `cadencePreset` — that falls back to interval-drift scheduling.

### Determinism & Drift

- `computeNextBoundary(cadence, now)` always returns the **next** UTC boundary strictly after `now`.
- The scheduler calls this fresh on every reschedule, so a 3-second overrun at 14:00:00 still schedules the next run at 15:00:00 (not 15:00:03).
- Server restarts recalculate the next boundary from current time — no drift accumulates.

---

## Since Preset + Cadence Defaults

The **Since** field sets how far back to fetch messages on each scheduled run.

### Precedence

| `sincePreset` provided? | Behavior |
|------------------------|----------|
| **Yes** | Uses the explicit since preset |
| **No (scheduled job)** | Defaults to the cadencePreset (e.g., hourly job → fetch last 1 hour each run) |
| **No (manual run)** | Fetches the latest messages (no lookback limit unless `after` is set) |

### Cadence → Default Since Mapping

All cadence presets are also valid since presets, so the mapping is 1:1 with no exceptions:

| Cadence | Default Since | What each run fetches |
|---------|---------------|-----------------------|
| `1m`  | `1m`  | Messages from the last 1 minute  |
| `5m`  | `5m`  | Messages from the last 5 minutes |
| `15m` | `15m` | Messages from the last 15 minutes |
| `30m` | `30m` | Messages from the last 30 minutes |
| `1h`  | `1h`  | Messages from the last 1 hour |
| `2h`  | `2h`  | Messages from the last 2 hours |
| … | … | … |
| `1y`  | `1y`  | Messages from the last year |

You can override Since to a different value — for example, a daily job could use `since=1w` to fetch a week's worth of messages on each daily run (useful for backfill or tolerance of missed runs).

**Precedence rule (detail):** `sincePreset` **overrides** any explicit `after` value when both are set.
The static `after` field is ignored and the `sincePreset`-derived snowflake is used instead.
The UI disables the `after` field when a preset is selected.

---

## Auto-Name Behavior

When creating a scheduled job with an empty **Job Name**, the server auto-generates one:

```
#<channelName-or-id> every <since label>
```

Examples:
- `#general every 1 hour`
- `#1234567890 every 15 minutes` (when channel name can't be resolved)
- `#announcements every 1 day`

The channel name is resolved via the Discord API at creation time. If resolution fails, the channel ID is used as a fallback. The name is stored in the job and can be updated later via `PATCH /api/jobs/:id`.

---

## Since Presets (Lookback Windows)

The **Since** dropdown in Manual mode (and optionally in Scheduled mode) controls how far back to fetch messages. Both the cadence and since dropdowns use the same compact label format for consistency.

| Preset | UI Label | Window |
|--------|----------|--------|
| `1m`   | 1M   | Last 1 minute |
| `5m`   | 5M   | Last 5 minutes |
| `15m`  | 15M  | Last 15 minutes |
| `30m`  | 30M  | Last 30 minutes |
| `1h`   | 1H   | Last 1 hour |
| `2h`   | 2H   | Last 2 hours |
| `4h`   | 4H   | Last 4 hours |
| `6h`   | 6H   | Last 6 hours |
| `12h`  | 12H  | Last 12 hours |
| `1d`   | 1D   | Last 1 day |
| `3d`   | 3D   | Last 3 days |
| `1w`   | 1W   | Last 1 week |
| `2w`   | 2W   | Last 2 weeks |
| `1mo`  | 1MO  | Last ~30 days |
| `2mo`  | 2MO  | Last ~60 days |
| `3mo`  | 3MO  | Last ~90 days |
| `4mo`  | 4MO  | Last ~120 days |
| `6mo`  | 6MO  | Last ~180 days |
| `1y`   | 1Y   | Last ~365 days |
| `3y`   | 3Y   | Last ~3 years |
| `5y`   | 5Y   | Last ~5 years |
| `10y`  | 10Y  | Last ~10 years |
| `20y`  | 20Y  | Last ~20 years |
| `all`  | ALL  | All time (from beginning) |

**How it works:** At run time, the preset is resolved to an effective "after" Discord snowflake ID by computing `now − presetMs`. This snowflake is passed to the Discord messages API as the `after` parameter.

---

## Scheduled Jobs table

| Column | Description |
|--------|-------------|
| Name | Human-readable job name (auto-generated if left blank at creation) |
| Channel | Discord channel ID |
| Cadence | Compact preset label with boundary tooltip (hover for the rule). Legacy jobs without cadencePreset show raw minutes. |
| Since | Compact since preset label, or static after ID used for lookback |
| Status | enabled / disabled |
| Last Run | Relative time of last execution |
| Last Result | success / error / never |
| Actions | ▶ Run now · ✏ Edit · Enable/Disable · ✕ Delete |

---

## API Reference

All endpoints require `Authorization: Bearer <UI_TOKEN>` when `UI_TOKEN` is configured.
When `UI_TOKEN` is unset, all routes are open.

### `POST /api/sync`

Trigger a manual sync immediately.

```bash
curl -X POST http://localhost:3456/api/sync \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"channel":"123456789012345678","limit":50}'
```

Body params:

| Param | Required | Description |
|-------|----------|-------------|
| `channel` | ✅ | Discord channel ID |
| `limit` | optional | Max messages to fetch (1–100, default 100) |
| `sincePreset` | optional | Relative lookback window (e.g. `"1h"`, `"1d"`). **Overrides `after` when set.** |
| `after` | optional | Fetch messages after this message ID. Ignored when `sincePreset` is set. |
| `before` | optional | Fetch messages before this message ID |

### `GET /api/jobs`

List all scheduled jobs.

### `POST /api/jobs`

Create a scheduled job.

```bash
curl -X POST http://localhost:3456/api/jobs \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"channel":"123456789012345678","cadencePreset":"1h","enabled":true}'
```

Body params:

| Param | Required | Description |
|-------|----------|-------------|
| `channel` | ✅ | Discord channel ID |
| `cadencePreset` | recommended | Cadence preset (e.g. `"1h"`, `"1d"`). Derives `intervalMinutes` automatically. Enables boundary-aligned scheduling. |
| `name` | optional | Job name. If blank, auto-generated as `#channelName every label`. |
| `sincePreset` | optional | Lookback window per run. Defaults to `cadencePreset` if omitted. |
| `intervalMinutes` | optional | Override interval in minutes. Used only when `cadencePreset` is absent (legacy). |
| `enabled` | optional | Start enabled (default `true`) |
| `limit` | optional | Max messages per run (advanced / manual use) |
| `after` | optional | Static after-message-ID filter (advanced / manual use) |
| `before` | optional | Static before-message-ID filter (advanced / manual use) |

**Example with cadencePreset (recommended):**
```bash
curl -X POST http://localhost:3456/api/jobs \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"channel":"123456789012345678","cadencePreset":"1h"}'
# → name auto-generated, sincePreset defaults to "1h"
```

**Legacy example (intervalMinutes only — no boundary alignment):**
```bash
curl -X POST http://localhost:3456/api/jobs \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Job","channel":"123456789012345678","intervalMinutes":60,"sincePreset":"1h","enabled":true}'
```

### `POST /api/jobs/:id/run`

Trigger a scheduled job immediately (async, fire-and-forget). Check `/api/runs` for the result.

### `PATCH /api/jobs/:id`

Update job fields. Supports `cadencePreset` (re-derives `intervalMinutes` automatically).
The scheduler re-schedules the job immediately after a successful update.
In the UI, the **✏ Edit** button per job row opens a modal backed by this endpoint.

```bash
# Change cadence and since together
curl -X PATCH http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"cadencePreset":"6h","sincePreset":"6h"}'

# Change name and channel
curl -X PATCH http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Renamed Job","channel":"111222333444555666"}'

# Disable a job
curl -X PATCH http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

Supported patch fields: `name`, `channel`, `cadencePreset`, `sincePreset`, `enabled`, `intervalMinutes` (legacy), `limit`, `after`, `before`.

### `DELETE /api/jobs/:id`

Delete a scheduled job and cancel its timer.

### `GET /api/scheduler/status`

Get the current scheduler queue state.

```bash
curl http://localhost:3456/api/scheduler/status \
  -H "Authorization: Bearer your-token"
```

Response:
```json
{
  "concurrency": 1,
  "spacingMs": 1000,
  "runningIds": [],
  "queuedIds": [],
  "runningCount": 0,
  "queuedCount": 0
}
```

### `GET /api/runs`

Get recent run logs (newest first). Optional `?limit=N` (max 200, default 50).

---

## Job Model

```typescript
interface Job {
  id: string;
  name: string;
  channel: string;
  // Scheduling
  cadencePreset?: CadencePreset;   // e.g. "1h" — drives boundary-aligned scheduling
  intervalMinutes: number;         // derived from cadencePreset, or explicit for legacy jobs
  // Lookback
  sincePreset?: SincePreset;       // e.g. "1h" — defaults to cadencePreset for new jobs
  after?: string;                  // static after snowflake (advanced)
  before?: string;                 // static before snowflake (advanced)
  limit?: number;                  // max messages per run (advanced)
  // State
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: 'success' | 'error' | 'running';
}
```

### Backward Compatibility

Old jobs (pre-v0.3) stored in `.data/jobs/jobs.json` with only `intervalMinutes` and no `cadencePreset` continue to work — the scheduler falls back to interval-drift scheduling (`lastRun + intervalMinutes`).

New jobs created via the UI or API with `cadencePreset` use boundary-aligned UTC scheduling.

---

## Scheduler Details

- Jobs are loaded from `.data/jobs/jobs.json` on server startup via `startScheduler()`
- Each enabled job with `cadencePreset` is scheduled for the next UTC boundary via `computeNextBoundary(cadence, now)`
- Each enabled job without `cadencePreset` (legacy) uses `lastRunAt + intervalMinutes` drift scheduling
- Overlapping runs of the same job are prevented via the global queue's per-job guard
- Editing a job via `PATCH /api/jobs/:id` reschedules its timer automatically
- Disabling a job cancels its timer immediately
- `POST /api/jobs/:id/run` enqueues the job and reschedules for the next boundary

### Global Scheduler Queue

All sync operations — scheduled triggers, manual runs, and run-all — go through a shared in-process queue (`scheduler-queue.ts`) before executing. This prevents simultaneous Discord API calls when multiple jobs fire at the same boundary.

**Queue semantics:**

| Behaviour | Detail |
|-----------|--------|
| Concurrency | Controlled by `SCHEDULER_CONCURRENCY` (default **1** — single worker) |
| Job spacing | `SCHEDULER_JOB_SPACING_MS` (default **1000 ms**) — minimum delay after one job finishes before the next starts |
| FIFO order | Jobs due at the same boundary are enqueued in arrival order and run sequentially |
| Per-job guard | A job already in the queue or running will not be enqueued again (duplicate boundary ticks are dropped) |
| Manual runs | `POST /api/sync`, `POST /api/jobs/:id/run`, and `POST /api/jobs/:id/run-all` all go through the queue — they do not bypass it |
| `/api/sync` | Blocks until the queued job completes and returns the full result (fetched/inserted/updated/skipped counts) |

**Queue status endpoint:**

```
GET /api/scheduler/status
```

Returns:
```json
{
  "concurrency": 1,
  "spacingMs": 1000,
  "runningIds": ["job-uuid-1"],
  "queuedIds": ["job-uuid-2", "manual:run-uuid-3"],
  "runningCount": 1,
  "queuedCount": 2
}
```

The `/sync` page also shows a live **Scheduler Queue** widget (refreshed every 30 s) with running count, queue depth, concurrency, and spacing values.

### Discord 429 Retry / Backoff

`fetchChannelMessages` and `fetchChannelName` in `live-sync.ts` automatically retry on HTTP 429 responses:

- Reads the `Retry-After` (or `X-RateLimit-Reset-After`) header to determine wait time
- Adds a 500 ms safety buffer on top of the indicated wait
- Retries up to **3 times** with clear log output on each retry
- Raises an error after the retry budget is exhausted

This is independent of the queue — rate-limits within a single page fetch are handled inline, while the queue prevents concurrent fetches from multiple jobs firing at once.

---

## Storage Paths

All runtime data is stored relative to the server's working directory:

| Path | Contents |
|------|----------|
| `.data/jobs/jobs.json` | All scheduled jobs (JSON array) |
| `.data/runs/runs.json` | Run log history (JSON array, capped at 200 entries) |
| `.data/chrome-profile/discord-session.json` | Captured Discord session token |

`.data/` is listed in `.gitignore` and should be mounted as a persistent volume in Docker.

---

## Write Mode Selection

The ingestor supports two write backends. Mode is selected automatically based on environment variables.

### Precedence

| Priority | Condition | Mode |
|----------|-----------|------|
| **1 (preferred)** | `MEMORY_DATABASE_API_URL` **and** `MEMORY_DATABASE_API_TOKEN` both set | **API mode** — writes via `POST /api/messages` |
| **2 (fallback)** | `DATABASE_URL` set (and API vars absent/incomplete) | **PG mode** — direct PostgreSQL upsert |

If neither is configured the server/CLI exits with an error.

### API Mode

When `MEMORY_DATABASE_API_URL` + `MEMORY_DATABASE_API_TOKEN` are present, each normalized Discord message is POSTed to:

```
POST {MEMORY_DATABASE_API_URL}/api/messages
Authorization: Bearer {MEMORY_DATABASE_API_TOKEN}
Content-Type: application/json

{
  "source": "discord",
  "sender": "...",
  "recipient": "discord-channel:<id>",
  "content": "...",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "external_id": "<discord-message-id>",
  "metadata": { ... }
}
```

#### Retry / Backoff

API writes automatically retry on transient failures:
- **429 Rate-limit** — reads `Retry-After` (or `X-RateLimit-Reset-After`) header; waits + 500 ms safety buffer; up to 3 retries.
- **5xx Server errors** — exponential backoff starting at 1 s; up to 3 retries.
- **Network errors** — same exponential backoff; up to 3 retries.
- **4xx (non-429)** — not retried; message counted as `skipped`.

#### Metric caveats (API mode)

| Metric | Mapping |
|--------|---------|
| `fetched` | Total messages fetched from Discord API — always accurate |
| `inserted` | HTTP 201 (Created) responses — new record written |
| `updated` | HTTP 200 (OK) or 409 (Conflict) responses — existing record |
| `skipped` | Unrecoverable errors or exhausted retries |
| `attachmentsSeen` | Count of Discord attachments across all messages — always accurate |

> ⚠️ If the API always returns `200` for upserts (never `201`), `inserted` will be `0` and all successful writes appear as `updated`. The sum `inserted + updated + skipped` always equals `fetched`.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMORY_DATABASE_API_URL` | ✅ (API mode) | — | Base URL of the Memory Database API (e.g. `http://host:3000`). When set together with `MEMORY_DATABASE_API_TOKEN`, API mode is activated and `DATABASE_URL` is not needed. |
| `MEMORY_DATABASE_API_TOKEN` | ✅ (API mode) | — | Bearer token for the Memory Database API. Sent as `Authorization: Bearer <token>`. |
| `DATABASE_URL` | ✅ (PG mode) | — | PostgreSQL connection string. Required when API mode is not active. |
| `UI_TOKEN` | optional | — | If set, all `/api/*` routes require `Bearer` token auth. If unset, auth is disabled and no auth UI is shown. |
| `LOGIN_SERVER_PORT` | optional | `3456` | HTTP server port |
| `CDP_PORT` | optional | `9222` | Chromium remote debugging port |
| `PUPPETEER_EXECUTABLE_PATH` | optional | `/usr/bin/chromium` | Path to Chromium binary |
| `SCHEDULE_SINCE_OVERLAP_PERCENT` | optional | `10` | Extra lookback applied to scheduled `since` runs to avoid edge misses (e.g. `1h` + 10% => 66m). |
| `SCHEDULER_CONCURRENCY` | optional | `1` | Max concurrent jobs the scheduler queue runs simultaneously. Increase with caution — higher values may trigger Discord 429 rate-limits. |
| `SCHEDULER_JOB_SPACING_MS` | optional | `1000` | Minimum delay (ms) between jobs after one finishes and before the next starts. Acts as a rate-limit buffer between sequential job runs. |

### Example: API mode `.env`

```env
MEMORY_DATABASE_API_URL=http://dokploy-memory-database-api-lxfp0i:3000
MEMORY_DATABASE_API_TOKEN=your-read-write-api-token
UI_TOKEN=your-ui-token-here
LOGIN_SERVER_PORT=3456
```

### Example: PG mode `.env` (legacy)

```env
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
UI_TOKEN=your-ui-token-here
LOGIN_SERVER_PORT=3456
```

---

## CLI Usage

### 1. JSON Import

```bash
npm run import -- --input /path/to/discord-export
# Options: --dry-run, --verbose
```

### 2. Live Sync CLI

```bash
# Step 1: Start the server
npm run server

# Step 2: Log in via browser at http://localhost:3456/discord-login

# Step 3: Sync from CLI
npm run sync -- --channel 123456789012345678 --limit 50 --verbose
npm run sync -- --channel 123456789012345678 --after 987654321098765432
```

Options for `npm run sync`:

| Flag | Description |
|------|-------------|
| `--channel` | Discord channel ID (required) |
| `--limit N` | Max messages to fetch |
| `--before <id>` | Fetch messages before this ID |
| `--after <id>` | Fetch messages after this ID |
| `--verbose` | Print progress |

### 3. Attachment Backfill

Backfill attachments from all existing Discord messages in the memory database. Downloads actual attachment files from Discord CDN and re-ingests them via the memory DB ingest API.

**Requires:**
- `MEMORY_DATABASE_API_URL` - Memory DB API base URL
- `MEMORY_DATABASE_API_TOKEN` - Token for reading messages (required)
- `MEMORY_DATABASE_API_WRITE_TOKEN` (optional) - Token for writing attachments; defaults to `MEMORY_DATABASE_API_TOKEN` if not set

**Token Permissions:**
The write token must have `permissions='admin'` or `permissions='write'` with `write_sources` including `'discord'`. If you encounter `403 Insufficient permissions`, ensure:
- The token is active and not rate-limited
- For `write` tokens: `write_sources` array includes `'discord'`
- For `admin` tokens: No source restrictions apply
- Recommended: Use an admin token for backfill operations

**Basic usage (dry-run first):**

```bash
# Preview what would be backfilled
npm run backfill-attachments -- --limit 100 --dry-run --verbose

# Start actual backfill with concurrent downloads (batch-size=5)
MEMORY_DATABASE_API_URL="http://dokploy-memory-database-api-lxfp0i:3000" \
MEMORY_DATABASE_API_TOKEN="your-token" \
npm run backfill-attachments -- --limit 1000 --batch-size 5 --verbose

# Resume from a specific page (if interrupted)
npm run backfill-attachments -- --resume-from 50 --batch-size 10
```

Options for `npm run backfill-attachments`:

| Flag | Description | Default |
|------|-------------|---------|
| `--limit N` | Max messages to process | all (104,697) |
| `--batch-size N` | Concurrent attachment downloads per message | 5 |
| `--dry-run` | Preview without writing to API | false |
| `--resume-from <page>` | Start from specific page (1–1047) | 1 |
| `--verbose` | Print detailed progress | false |

**How it works:**

1. **Query phase:** Paginates through Discord messages (100 per page) from memory DB API
2. **Filter:** Only processes messages with `metadata.attachments`
3. **Download phase:** Downloads each attachment file from Discord CDN (with 429 rate-limit retry)
4. **Ingest phase:** Posts attachment + metadata to `/api/messages/ingest` endpoint
5. **Error handling:** Tracks errors per attachment; continues on transient failures (429, 5xx)

**Expected runtime:**

- **Dry-run (50 messages):** ~10–30 seconds (depends on attachment sizes and network)
- **Full backfill (104,697 messages):** ~2–6 hours (with 5 concurrent downloads)

**Output (JSON):**

```json
{
  "messagesProcessed": 1000,
  "messagesWithAttachments": 45,
  "totalAttachmentsFetched": 67,
  "attachmentsDownloaded": 66,
  "attachmentsIngested": 66,
  "attachmentsSkipped": 1,
  "errors": [
    {
      "message": "HTTP 404: Not Found",
      "attachmentUrl": "https://...",
      "messageId": "123456789"
    }
  ]
}
```

**Recovery strategy:**

- Some Discord CDN files may expire (404 errors) — these are safely skipped
- Use `--resume-from <page>` to continue from the last successful page if interrupted
- Ingest is idempotent — re-running the backfill will skip already-ingested attachments (via SHA256 deduplication in memory DB)

---

## Architecture

```
src/
├── index.ts                  # JSON import CLI
├── server.ts                 # Express server entry point
├── commands/
│   ├── live-sync.ts          # Live sync CLI command
│   └── backfill-attachments.ts # Attachment backfill CLI command
└── lib/
    ├── browser.ts            # Chromium CDP helpers
    ├── session.ts            # Discord session persistence (.data/chrome-profile/)
    ├── token-validator.ts    # Discord API token validation
    ├── login-server.ts       # Login UI + WebSocket screencast + CDP token capture
    ├── live-sync.ts          # Discord API fetch + DB upsert (returns SyncResult)
    ├── api-writer.ts         # Memory DB API write with retry/backoff
    ├── job-store.ts          # Job CRUD + .data/jobs/jobs.json persistence
    ├── run-store.ts          # Run log append/query + .data/runs/runs.json persistence
    ├── scheduler.ts          # Boundary-aligned scheduler (rehydrates on start; enqueues via queue)
    ├── scheduler-queue.ts    # Global FIFO job queue (concurrency + spacing control)
    ├── since-presets.ts      # SincePreset + CadencePreset types, labels, boundary computation
    └── sync-router.ts        # All /sync and /api/* routes + full-page HTML UI
```

---

## TypeScript

```bash
npm run typecheck
```

---

## ⚠️ Security Notice

**Discord user tokens are sensitive.** They provide full access to your account.

- Never share your token
- Session stored locally at `.data/chrome-profile/discord-session.json` (gitignored)
- `UI_TOKEN` protects the sync API; use a strong random string
- If your token is compromised, change your Discord password immediately
