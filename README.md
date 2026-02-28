# openclaw-discord-ingestor

Standalone Discord → OpenClaw memory DB ingestor.

This imports Discord export JSON files into the existing OpenClaw PostgreSQL `messages` table, independent of built-in OpenClaw channel ingestion.

## Features

- Recursive JSON discovery under an input directory
- Detects JSON files that contain a `messages` array
- Normalizes Discord messages to OpenClaw `messages` schema
- Idempotent upsert via `(source_id, external_id)`
- Auto-creates `discord` source in `sources` table if missing
- Dry-run mode for safe validation

## Install

```bash
npm install
```

## Configure

Create `.env`:

```env
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
```

## Run

```bash
npm run import -- --input /path/to/discord-export
```

Options:

- `--dry-run` : parse/normalize only, no DB writes
- `--verbose` : print per-file stats and warnings

## Notes

- Input format targets common Discord JSON export structure.
- Files that are valid JSON but not message exports are skipped.
- If a message has no text but has attachments/embeds, content is set to `[non-text discord message]`.
