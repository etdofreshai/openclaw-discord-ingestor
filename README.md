# openclaw-discord-ingestor

Standalone Discord → OpenClaw memory DB ingestor.

This imports Discord messages into the existing OpenClaw PostgreSQL `messages` table, using either **JSON export files** or **live API sync** with a captured user session.

## Features

### JSON Import (existing)
- Recursive JSON discovery under an input directory
- Detects JSON files that contain a `messages` array
- Normalizes Discord messages to OpenClaw `messages` schema
- Idempotent upsert via `(source_id, external_id)`
- Auto-creates `discord` source in `sources` table if missing
- Dry-run mode for safe validation

### Live Sync (new)
- Browser-driven login capture via Chromium
- Token persisted locally (`.chrome-profile/discord-session.json`)
- Token validation against Discord API `/users/@me`
- Pull messages from specified channel ID
- Idempotent upsert into messages table

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
# Optional: if set, /sync and /api/sync require Bearer token auth
UI_TOKEN=your-secret-token-here
```

## Usage

### 0. Web UI — Sync Interface

After starting the server, a protected web interface is available at:

```
http://localhost:3456/sync
```

It lets you trigger live syncs without the CLI by filling in:

| Field | Required | Description |
|-------|----------|-------------|
| Channel ID | ✅ | Numeric Discord channel ID (right-click channel → Copy Channel ID) |
| Limit | optional | Max messages to fetch (1–100, default 100) |
| After | optional | Fetch messages after this message ID (for incremental syncs) |
| Before | optional | Fetch messages before this message ID (for paginating backwards) |

**Auth:** If `UI_TOKEN` is set, `/sync` and `/api/sync` require it. If `UI_TOKEN` is unset, auth is disabled.
The page stores your token in browser `localStorage` so you only have to enter it once when auth is enabled.

To access the page via a query param (e.g. in a bookmarked URL):

```
http://localhost:3456/sync?token=your-secret-token-here
```

To trigger a sync programmatically:

```bash
curl -X POST http://localhost:3456/api/sync \
  -H "Authorization: Bearer your-secret-token-here" \
  -H "Content-Type: application/json" \
  -d '{"channel":"123456789012345678","limit":50}'

# With after/before filters
curl -X POST http://localhost:3456/api/sync \
  -H "Authorization: Bearer your-secret-token-here" \
  -H "Content-Type: application/json" \
  -d '{"channel":"123456789012345678","after":"987654321098765432"}'
```

Returns JSON:

```json
{
  "success": true,
  "channel": "123456789012345678",
  "user": "username#0",
  "fetched": 47,
  "upserted": 47
}
```

### 1. JSON Import

Import from Discord export JSON files:

```bash
npm run import -- --input /path/to/discord-export
```

Options:

- `--dry-run` : parse/normalize only, no DB writes
- `--verbose` : print per-file stats and warnings

### 2. Live Sync

#### Step 1: Start the Login Server

```bash
npm run server
```

This starts an Express server with WebSocket support at `http://localhost:3456` (or port specified by `LOGIN_SERVER_PORT`).

#### Step 2: Log in via Browser UI

1. Open `http://localhost:3456/discord-login` in your browser
2. Click "Start Login" to launch a Chromium instance
3. Log in to your Discord account in the remote browser
4. The server will automatically capture your token and save it locally
5. You'll see a success message when complete

#### Step 3: Sync Messages

```bash
npm run sync -- --channel <channel-id> [--limit 100] [--verbose]
```

Options:

- `--channel` : Discord channel ID to sync (required)
- `--limit` : Max messages to fetch (default: 100, max: 100)
- `--before` : Message ID to sync messages before
- `--after` : Message ID to sync messages after
- `--verbose` : Print detailed progress

Examples:

```bash
# Sync latest 50 messages from a channel
npm run sync -- --channel 123456789012345678 --limit 50 --verbose

# Sync all messages after a specific message
npm run sync -- --channel 123456789012345678 --after 987654321098765432

# Sync messages between two points (requires multiple calls)
npm run sync -- --channel 123456789012345678 --before 987654321098765432 --limit 100
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `UI_TOKEN` | optional | — | If set, required to access `/sync` and `POST /api/sync` (Bearer token). If unset, UI/API are open. |
| `LOGIN_SERVER_PORT` | optional | `3456` | Port for the Express server |
| `CDP_PORT` | optional | `9222` | Chromium remote debugging port |
| `PUPPETEER_EXECUTABLE_PATH` | optional | `/usr/bin/chromium` | Path to Chromium binary |

## Architecture

```
src/
├── index.ts              # JSON import CLI
├── server.ts             # Express server entry point (login + sync)
├── commands/
│   └── live-sync.ts      # Live sync CLI
└── lib/
    ├── browser.ts        # Chromium CDP helpers
    ├── session.ts        # Session persistence
    ├── token-validator.ts # Discord API validation
    ├── login-server.ts   # Express + WebSocket login UI
    ├── live-sync.ts      # Discord API message sync
    └── sync-router.ts    # Authenticated sync web UI + /api/sync endpoint
```

## ⚠️ Security Notice

**User tokens are sensitive.** Your Discord user token provides full access to your account.

- Never share your token with anyone
- The token is stored locally in `.chrome-profile/discord-session.json`
- This file should be in `.gitignore`
- If you suspect your token has been compromised, change your Discord password immediately (this invalidates all tokens)

## Notes

- JSON import targets common Discord JSON export structure
- Live sync uses Discord API v10
- Messages are deduplicated on `(source_id, external_id)` to prevent duplicates
- Files that are valid JSON but not message exports are skipped
- If a message has no text but has attachments/embeds, content is set to `[non-text discord message]`

## TypeScript

All code is written in TypeScript. To type-check:

```bash
npm run typecheck
```

## Development

The login server uses:
- Express for HTTP routes
- ws for WebSocket communication
- Chromium CDP for browser automation
- Runtime.evaluate to extract token from localStorage

The sync command uses:
- Native fetch for Discord API calls
- pg for PostgreSQL upserts
