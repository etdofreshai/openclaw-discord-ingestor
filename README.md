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
```

## Usage

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

- `DATABASE_URL` : PostgreSQL connection string (required for all commands)
- `LOGIN_SERVER_PORT` : Port for login server (default: 3456)
- `CDP_PORT` : Chromium remote debugging port (default: 9222)
- `PUPPETEER_EXECUTABLE_PATH` : Path to Chromium binary (default: /usr/bin/chromium)

## Architecture

```
src/
├── index.ts              # JSON import CLI
├── server.ts             # Login server entry point
├── commands/
│   └── live-sync.ts      # Live sync CLI
└── lib/
    ├── browser.ts        # Chromium CDP helpers
    ├── session.ts        # Session persistence
    ├── token-validator.ts # Discord API validation
    ├── login-server.ts   # Express + WebSocket login UI
    └── live-sync.ts      # Discord API message sync
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
