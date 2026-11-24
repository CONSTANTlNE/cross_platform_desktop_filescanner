# Quick view

Eye button in the Files toolbar toggles a right-hand panel (`settings.ui.preview`). Selecting a row (click, or Up/Down arrows) previews it; "Open" opens the file in its default app.

## Formats
| Ext | Library | Result |
|---|---|---|
| docx | mammoth | Formatted HTML (headings, bold/italic, lists, tables, images ≤ ~700 KB each); capped at 1.5 MB of HTML |
| doc | word-extractor | Plain text only (old binary format), capped at 200 KB |
| xlsx, xls | SheetJS (CDN 0.20.3) | Sheet tabs (≤ 20), first 200 rows × 30 columns, cells ≤ 200 chars; row/column labels shown |
| pdf | Chromium PDF viewer | Embedded `<iframe src=file://...>` (toolbar hidden); main only checks the file is indexed and exists |

## Safety
- PDF: the CSP allows `frame-src file:` for this; the viewer runs in Chromium's own sandboxed PDF plugin process.
- Main only previews files that are in the index and ≤ 30 MB.
- Parsing happens in `preview-worker.js` (worker thread): 15 s timeout, 768 MB heap, terminated afterwards; only the latest request is kept.
- The renderer never inserts raw document HTML: `preview.js` rebuilds it from an allow-list of tags (links removed, only `data:image/png|jpeg|gif|bmp|webp` images, no styles/scripts). Sheets/text are built with `textContent`.
- On the narrow layout (panel open) the table drops the Folder column and the Name column flexes.

## Images
Image files preview as an `<img src="file://...">` (`kind: 'image'` from `preview:get`; CSP `img-src` allows `file:`). No parsing worker involved.
