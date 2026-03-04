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

### Web UI (v0.3)
- **Sync form** with Manual Run or Scheduled Job mode
- **Auth modal** — shown only when `UI_TOKEN` is set; saves token to `localStorage`
- **Scheduled jobs** — persisted to `.data/jobs/jobs.json`, auto-scheduled on server start
- **Cadence presets** — dropdown of standard intervals (1m → 1y); boundary-aligned UTC scheduling
- **Auto-name** — blank job name auto-generates from channel + cadence (e.g. `#general every 1 hour`)
- **Run logs** — every sync recorded with metrics in `.data/runs/runs.json`
- **Jobs table** — list, run, enable/disable, and delete scheduled jobs
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
3. Optionally enter a **Job Name** — if left blank, one is auto-generated as `#<channelName> every <cadence>` (e.g., `#general every 1 hour`)
4. Optionally select a **Since** lookback window — if left blank, defaults to the same value as cadence
5. Click **📅 Create Scheduled Job**
6. Job appears in the Scheduled Jobs table; it fires automatically at the next UTC boundary for the cadence
7. Jobs survive server restarts — timers are rehydrated from `.data/jobs/jobs.json`

> **Limit / After / Before fields are hidden in Scheduled Job mode.** Scheduled jobs use `channel + cadence + since` only. These fields remain supported for Manual Run mode and via the API directly.

---

## Cadence Presets

Scheduled jobs fire at **natural UTC boundaries**, not "now + interval" drift.
This means the run times are predictable and consistent across server restarts.

| Preset | Label | Boundary Rule (UTC) | `intervalMinutes` |
|--------|-------|---------------------|:-----------------:|
| `1m`   | Every 1 minute     | HH:MM:00 each minute             | 1      |
| `5m`   | Every 5 minutes    | minute % 5 == 0                  | 5      |
| `15m`  | Every 15 minutes   | :00/:15/:30/:45 each hour        | 15     |
| `30m`  | Every 30 minutes   | :00/:30 each hour                | 30     |
| `1h`   | Every 1 hour       | top of each hour                 | 60     |
| `2h`   | Every 2 hours      | hour % 2 == 0                    | 120    |
| `4h`   | Every 4 hours      | hour % 4 == 0                    | 240    |
| `6h`   | Every 6 hours      | hour % 6 == 0                    | 360    |
| `12h`  | Every 12 hours     | midnight & noon                  | 720    |
| `1d`   | Every day          | midnight UTC                     | 1440   |
| `3d`   | Every 3 days       | every 3rd day from Unix epoch, midnight UTC | 4320 |
| `1w`   | Every week         | Monday 00:00 UTC                 | 10080  |
| `2w`   | Every 2 weeks      | biweekly Monday 00:00 UTC ¹      | 20160  |
| `1mo`  | Every month        | 1st of each month, 00:00 UTC     | 43200  |
| `2mo`  | Every 2 months     | 1st of Jan/Mar/May/Jul/Sep/Nov, 00:00 UTC | 86400 |
| `3mo`  | Every quarter      | 1st of Jan/Apr/Jul/Oct, 00:00 UTC | 129600 |
| `4mo`  | Every 4 months     | 1st of Jan/May/Sep, 00:00 UTC    | 172800 |
| `6mo`  | Every 6 months     | 1st of Jan/Jul, 00:00 UTC        | 259200 |
| `1y`   | Every year         | Jan 1, 00:00 UTC                 | 525960 |

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

The **Since** dropdown in Manual mode (and optionally in Scheduled mode) controls how far back to fetch messages.

| Preset | Window |
|--------|--------|
| `1m`   | Last 1 minute |
| `5m`   | Last 5 minutes |
| `15m`  | Last 15 minutes |
| `30m`  | Last 30 minutes |
| `1h`   | Last 1 hour |
| `2h`   | Last 2 hours |
| `4h`   | Last 4 hours |
| `6h`   | Last 6 hours |
| `12h`  | Last 12 hours |
| `1d`   | Last 1 day |
| `3d`   | Last 3 days |
| `1w`   | Last 1 week |
| `2w`   | Last 2 weeks |
| `1mo`  | Last ~30 days |
| `2mo`  | Last ~60 days |
| `3mo`  | Last ~90 days |
| `4mo`  | Last ~120 days |
| `6mo`  | Last ~180 days |
| `1y`   | Last ~365 days |
| `3y`   | Last ~3 years |
| `5y`   | Last ~5 years |
| `10y`  | Last ~10 years |
| `20y`  | Last ~20 years |
| `all`  | All time (from beginning) |

**How it works:** At run time, the preset is resolved to an effective "after" Discord snowflake ID by computing `now − presetMs`. This snowflake is passed to the Discord messages API as the `after` parameter.

---

## Scheduled Jobs table

| Column | Description |
|--------|-------------|
| Name | Human-readable job name (auto-generated if left blank at creation) |
| Channel | Discord channel ID |
| Cadence | Preset label with boundary tooltip (hover for the rule). Legacy jobs without cadencePreset show raw minutes. |
| Since/After | Since preset or static after ID used for lookback |
| Status | enabled / disabled |
| Last Run | Relative time of last execution |
| Last Result | success / error / never |
| Actions | ▶ Run now · Enable/Disable · ✕ Delete |

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

```bash
# Change cadence
curl -X PATCH http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"cadencePreset":"6h"}'

# Disable a job
curl -X PATCH http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

### `DELETE /api/jobs/:id`

Delete a scheduled job and cancel its timer.

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
- Overlapping runs of the same job are prevented via an in-memory `Set`
- Editing a job via `PATCH /api/jobs/:id` reschedules its timer automatically
- Disabling a job cancels its timer immediately
- `POST /api/jobs/:id/run` fires the job immediately and reschedules for the next boundary

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

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `UI_TOKEN` | optional | — | If set, all `/api/*` routes require `Bearer` token auth. If unset, auth is disabled and no auth UI is shown. |
| `LOGIN_SERVER_PORT` | optional | `3456` | HTTP server port |
| `CDP_PORT` | optional | `9222` | Chromium remote debugging port |
| `PUPPETEER_EXECUTABLE_PATH` | optional | `/usr/bin/chromium` | Path to Chromium binary |

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

---

## Architecture

```
src/
├── index.ts                  # JSON import CLI
├── server.ts                 # Express server entry point
├── commands/
│   └── live-sync.ts          # Live sync CLI command
└── lib/
    ├── browser.ts            # Chromium CDP helpers
    ├── session.ts            # Discord session persistence (.data/chrome-profile/)
    ├── token-validator.ts    # Discord API token validation
    ├── login-server.ts       # Login UI + WebSocket screencast + CDP token capture
    ├── live-sync.ts          # Discord API fetch + DB upsert (returns SyncResult)
    ├── job-store.ts          # Job CRUD + .data/jobs/jobs.json persistence
    ├── run-store.ts          # Run log append/query + .data/runs/runs.json persistence
    ├── scheduler.ts          # Boundary-aligned scheduler (rehydrates on start)
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
