# REQUEST.md — openclaw-discord-ingestor

## Goal
Ingest Discord message history into the OpenClaw PostgreSQL messages database as a standalone repo/service (separate from any built-in OpenClaw ingester behavior).

## Background
OpenClaw currently supports Discord through built-in channel/plugin flows, but we want a dedicated external ingestor repository with explicit import behavior, repeatable runs, and independent deployment/versioning.

## Input Source (v1)
Primary input is Discord data export JSON files (user-exported archives), imported from a local directory.

Expected file shape (common Discord export format):
- Root JSON object with channel metadata and a `messages` array
- Message fields typically include:
  - `id`
  - `timestamp`
  - `content`
  - `author.id` / `author.name`
  - `channel.id` / `channel.name`
  - optional `attachments`, `embeds`, `mentions`, etc.

Importer should recursively scan an input directory for `*.json`, detect files containing a `messages` array, and ingest them.

## Stack
- TypeScript + Node.js
- PostgreSQL (`pg`)
- CLI importer script (no web UI required in v1)

## Database Target
Insert/upsert into existing `messages` table:
- `source_id` = source row for `discord` (auto-create in `sources` if missing)
- `external_id` = Discord message ID
- `sender` = Discord username/display name (fallback author id)
- `recipient` = channel name/id (or guild/channel composite)
- `content` = message text content
- `timestamp` = Discord message timestamp
- `metadata` = raw useful JSON (author/channel/guild/attachments/embeds/mentions)

## Behavior
- Recursively discover candidate JSON files under `--input`
- Parse safely; skip invalid JSON with warnings
- For each message:
  - normalize fields
  - skip messages with no timestamp or no id
  - allow empty content if attachments/embeds exist (store placeholder content)
- Upsert idempotently by `(source_id, external_id)`
- Print summary: files scanned, files parsed, messages seen, inserted/updated, skipped

## CLI
```bash
npm run import -- --input /path/to/discord-export
```

Optional flags:
- `--dry-run` (parse + normalize without DB writes)
- `--verbose`

## Environment Variables
```env
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
```

## Notes
- v1 is archive-import focused (simple + reliable)
- Future v2 can support live ingestion through Discord APIs/bot gateway and watermark-based incremental sync
- Keep repo independent so OpenClaw core can remove built-in Discord ingester behavior cleanly
