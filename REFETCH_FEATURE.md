# Backfill --refetch Mode

## Goal
Unify sync + backfill into a single pass that:
1. Fetches messages from Discord (fresh attachment URLs)
2. Updates existing message rows **in-place** (no SCD2 versioning)
3. Downloads attachments with fresh URLs
4. Ingests attachments
5. All in one command

## Command
```bash
npm run backfill-attachments -- --refetch [--limit N] [--batch-size N] [--dry-run] [--verbose]
```

## How It Works

### Current (two-pass):
```
1. sync → messages stored with old URLs in DB
2. backfill → tries to download, gets 404s on expired URLs
```

### New (--refetch mode):
```
1. Load Discord session
2. For each Discord channel with attachments:
   - Fetch messages from Discord API (fresh URLs)
   - UPDATE existing message rows with new metadata (not INSERT)
   - For each message with attachments:
     - Download files with fresh URLs
     - Ingest into memory DB
3. Done!
```

## Implementation Steps

### Phase 1: Framework
- [ ] Add `backfillAttachmentsRefetch()` function
- [ ] Add CLI flag parsing for `--refetch`
- [ ] Split `main()` into refetch vs. normal mode

### Phase 2: Discord Fetching
- [ ] Fetch all channels with attachments
- [ ] Iterate messages with fresh URLs
- [ ] No SCD2: UPDATE instead of INSERT

### Phase 3: Download & Ingest
- [ ] Use existing `downloadAttachment()` function
- [ ] Use existing `ingestAttachment()` function
- [ ] Track progress (messages processed, downloaded, ingested)

## Data Structure
```typescript
type RefetchStats = {
  messagesProcessed: number;
  messagesUpdated: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
  errors: Array<{filename: string; messageId: string; error: string}>;
};
```

## Key Differences from Original Backfill
| Aspect | Original | --refetch |
|--------|----------|-----------|
| **Data Source** | Memory DB API | Discord API |
| **Message Update** | None (read-only) | UPDATE in-place |
| **SCD2 Versioning** | N/A | Disabled (direct UPDATE) |
| **Requires Session** | No | Yes |
| **URL Freshness** | Old (days old) | Fresh (current) |
| **Success Rate** | ~50% (404s) | ~100% (fresh URLs) |

## Benefits
- ✅ Single command instead of two
- ✅ Fresh attachment URLs from Discord
- ✅ No SCD2 rows added
- ✅ Clean in-place metadata updates
- ✅ Unifies sync + backfill workflows
