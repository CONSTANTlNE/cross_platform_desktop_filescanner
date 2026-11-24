# Content search

Searches inside Word, Excel and PDF documents. It is intentionally a **separate step from scanning**: scan finds files; "Index contents" reads their text in the background.

## Flow
1. Scan (names only, fast).
2. Press **Index contents** (toolbar or Settings > Content search). `indexer.js` selects pending files (new/changed/previously too big), sends them to 2 worker threads running `content-worker.js`, and stores the text in `content_fts`. Progress row + Stop; unfinished files stay pending, so it is resumable. When done: toast, and an OS notification if the window is not focused.
3. Switch the search box to **Contents**.

## Extraction (content-worker.js)
| Type | How |
|---|---|
| docx | mammoth `extractRawText` |
| doc | word-extractor (body, headers, footnotes) |
| xlsx / xls | SheetJS, every sheet name + cell text (formatted) |
| pdf | pdfjs-dist legacy build, text layer only, up to 1500 pages |
Text is whitespace-normalized and capped at 1,000,000 characters per file.

## States (`content_status.state`)
- `ok` – text stored and searchable.
- `empty` – no text found. For PDFs: fewer than 20 characters = no text layer, i.e. a scanned/picture PDF. **No OCR.**
- `error` – could not be read (corrupt, password-protected, timeout 90 s, worker crash).
- `toobig` – larger than `settings.index.maxMb` (default 50 MB).

## Visibility of the index state
- Every row has a status icon (column after Name); the state is computed live (`CSTATE` in db.js): a file changed since indexing counts as `pending` again. Tooltips explain each state.
- The list filter `cfilter` (all, ok, notok, pending, empty, error, toobig) is applied in `buildWhere`, so counts, ids and range selection all respect it. There is no toolbar dropdown for it (removed on request); it is driven by the notice bar.
- In Contents mode a notice bar (`#idxNotice`) lists how many files are not searchable and why, with "Index now" and "Show them" (= filter `notok`). While the filter is active "Show them" turns into "Cancel filter". Leaving Contents mode resets the filter.
- Starting indexing shows a toast with the file count; progress row + completion toast/OS notification follow. Rows refresh every ~2.5 s while indexing.
- Settings > Content search shows totals, a coverage bar, counts per state, scanned-PDF count, text volume, last indexed time and a per-extension table (`db.contentStats`).

## Known limitations (also written on the About page, in Georgian and English)
- Scanned PDFs cannot be searched by content.
- Georgian text must be Unicode. Old non-Unicode Georgian fonts (e.g. AcadNusx, LitNusx) store Latin letters under the hood, so Georgian searches do not find them and the extracted text is gibberish. Unicode fonts (Sylfaen, Segoe UI, Noto Sans Georgian) work.
- Word-prefix search only (not arbitrary substrings): "ანგარ" finds "ანგარიში", "gar" does not find "ანგარიში"-like words in the middle.
- Index size grows with text volume; "Clear content index" in Settings removes only the stored text.
