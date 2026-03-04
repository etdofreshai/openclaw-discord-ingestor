---
name: openclaw-discord-ingestor
description: Import Discord data into OpenClaw Postgres (JSON archive import + live session sync).
---

# openclaw-discord-ingestor

## Purpose
Ingest Discord messages into the OpenClaw `messages` table.

## Modes
- **Archive import**: parse Discord export JSON files
- **Live sync**: use captured Discord web session/token to pull channel history

## Setup
```bash
npm install
cp .env.example .env
```

Required env:
- `DATABASE_URL`

## Run
```bash
# Archive import
npm run import -- --input /path/to/discord-export [--dry-run] [--verbose]

# Start auth/login server
npm run server

# Live channel sync
npm run sync -- --channel <CHANNEL_ID>
```

## Notes
- Upserts idempotently into `messages` (by source+external id)
- Creates `discord` source in `sources` table if missing
- If session expires, re-run login flow
