# Database

File: `<userData>/files.db`, WAL mode. Opened only in main (`db.js`).

## Schema
`files(id, path UNIQUE, name, ext, size, modified_at, folder, scanned_at)`; indexes on `ext` and `name`.
`ext` is lowercase without dot; `modified_at` is epoch ms; `scanned_at` is the epoch ms of the scan start that last saw the row.

## FTS
`files_fts` = FTS5 external-content table on `files.name` (`content='files'`), `tokenize='trigram'` (case-insensitive substring match). Kept in sync by AFTER INSERT / DELETE / UPDATE OF name triggers.
Search rule (`buildWhere`): all terms ≥3 chars → `MATCH '"a" AND "b"'`; otherwise `LIKE '%t%'` per term. Extension filter is `ext IN (...)`.

## Upsert / prune
- `upsertBatch`: `INSERT ... ON CONFLICT(path) DO UPDATE`, set `scanned_at = scanStart`, one transaction per batch.
- `deleteMissing(roots, scanStart)`: for each scanned root delete rows with `scanned_at < scanStart` and path prefix = root. Called only after a completed (not stopped) scan.

## Queries
`query({search, exts, sort, dir, offset, limit})` — sort whitelist: name, ext, size, modified, folder; tie-break by id; limit capped at 1000. `count(q)` uses the same filter.
