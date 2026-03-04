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
- Token persisted locally (`.chrome-profile/discord-session.json`)
- Token validation against Discord API `/users/@me`
- Pull messages from any channel ID
- Idempotent upsert into messages table

### Web UI (v0.2)
- **Sync form** with Manual Run or Scheduled Job mode
- **Auth modal** — shown only when `UI_TOKEN` is set; saves token to `localStorage`
- **Scheduled jobs** — persisted to `.data/jobs/jobs.json`, auto-scheduled on server start
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
2. Fill in Channel ID and optional Limit / After / Before
3. Click **▶ Run Sync**
4. Result appears immediately below the form; run is logged to the Runs table

#### Scheduled Job

1. Select **"Scheduled Job"** in the mode dropdown
2. Fill in **Job Name** (required), **Channel ID** (required), optional params, and **Interval (minutes)** (default: 60)
3. Click **📅 Create Scheduled Job**
4. Job appears in the Scheduled Jobs table; it runs automatically at the configured interval
5. Jobs survive server restarts — timers are rehydrated from `.data/jobs/jobs.json`

#### Scheduled Jobs table

| Column | Description |
|--------|-------------|
| Name | Human-readable job name |
| Channel | Discord channel ID |
| Every | Interval in minutes |
| Status | enabled / disabled |
| Last Run | Relative time of last execution |
| Last Result | success / error / never |
| Actions | ▶ Run now · Enable/Disable · ✕ Delete |

#### Recent Runs table

| Column | Description |
|--------|-------------|
| Started | When the run began |
| Source | manual or scheduled (with job ID) |
| Channel | Channel ID synced |
| Status | success / error / running |
| Fetched | Messages retrieved from Discord API |
| Inserted | New rows written to DB |
| Updated | Existing rows updated |
| Skipped | Rows with no change (upsert no-op) |
| Attachments | Total attachments seen across fetched messages |
| Duration | Elapsed seconds |
| Error | Error message (truncated) if failed |

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
| `after` | optional | Fetch messages after this message ID |
| `before` | optional | Fetch messages before this message ID |

Response:
```json
{
  "success": true,
  "runId": "uuid",
  "channel": "123456789012345678",
  "user": "username#0",
  "fetched": 47,
  "inserted": 45,
  "updated": 2,
  "skipped": 0,
  "attachmentsSeen": 3
}
```

### `GET /api/jobs`

List all scheduled jobs.

```bash
curl http://localhost:3456/api/jobs -H "Authorization: Bearer your-token"
```

### `POST /api/jobs`

Create a scheduled job.

```bash
curl -X POST http://localhost:3456/api/jobs \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"General Hourly","channel":"123456789012345678","intervalMinutes":60,"enabled":true}'
```

Body params:

| Param | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Human-readable job name |
| `channel` | ✅ | Discord channel ID |
| `intervalMinutes` | optional | Run interval (default 60, min 1) |
| `limit` | optional | Max messages per run |
| `after` | optional | Fixed after filter |
| `before` | optional | Fixed before filter |
| `enabled` | optional | Start enabled (default true) |

### `POST /api/jobs/:id/run`

Trigger a scheduled job immediately (async, fire-and-forget). Check `/api/runs` for the result.

```bash
curl -X POST http://localhost:3456/api/jobs/<id>/run \
  -H "Authorization: Bearer your-token"
```

### `PATCH /api/jobs/:id`

Update job fields (including enable/disable).

```bash
# Disable a job
curl -X PATCH http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'

# Change interval
curl -X PATCH http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"intervalMinutes":30}'
```

### `DELETE /api/jobs/:id`

Delete a scheduled job and cancel its timer.

```bash
curl -X DELETE http://localhost:3456/api/jobs/<id> \
  -H "Authorization: Bearer your-token"
```

### `GET /api/runs`

Get recent run logs (newest first). Optional `?limit=N` (max 200, default 50).

```bash
curl http://localhost:3456/api/runs?limit=20 -H "Authorization: Bearer your-token"
```

---

## Storage Paths

All runtime data is stored relative to the server's working directory (the project root when using `npm run server`):

| Path | Contents |
|------|----------|
| `.data/jobs/jobs.json` | All scheduled jobs (JSON array) |
| `.data/runs/runs.json` | Run log history (JSON array, capped at 200 entries) |
| `.chrome-profile/discord-session.json` | Captured Discord session token |

Both `.data/` and `.chrome-profile/` are listed in `.gitignore`.

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
    ├── session.ts            # Discord session persistence (.chrome-profile/)
    ├── token-validator.ts    # Discord API token validation
    ├── login-server.ts       # Login UI + WebSocket screencast + CDP token capture
    ├── live-sync.ts          # Discord API fetch + DB upsert (returns SyncResult)
    ├── job-store.ts          # Job CRUD + .data/jobs/jobs.json persistence
    ├── run-store.ts          # Run log append/query + .data/runs/runs.json persistence
    ├── scheduler.ts          # In-process interval scheduler (rehydrates on start)
    └── sync-router.ts        # All /sync and /api/* routes + full-page HTML UI
```

---

## Scheduler Details

- Jobs are loaded from `.data/jobs/jobs.json` on server startup
- Each enabled job gets a `setTimeout` timer calculating the delay from `lastRunAt + intervalMinutes`
- If a job has never run, it starts after a 5-second delay (to let the server finish starting up)
- Overlapping runs of the same job are prevented via an in-memory `Set`
- Editing a job via `PATCH /api/jobs/:id` reschedules its timer automatically
- Disabling a job cancels its timer immediately
- `POST /api/jobs/:id/run` fires the job immediately and reschedules from that point

---

## TypeScript

```bash
npm run typecheck
```

---

## ⚠️ Security Notice

**Discord user tokens are sensitive.** They provide full access to your account.

- Never share your token
- Session stored locally at `.chrome-profile/discord-session.json` (gitignored)
- `UI_TOKEN` protects the sync API; use a strong random string
- If your token is compromised, change your Discord password immediately
