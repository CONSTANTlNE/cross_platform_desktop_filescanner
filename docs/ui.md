# UI

Vanilla JS, single window (`renderer/app.js`).

## Virtual list
Fixed row height (28px). `#spacer` has height `total*28`; `#rows` is absolutely positioned at `first*28` and contains only visible rows (+6 overscan), re-rendered via `requestAnimationFrame` on scroll.
Data is fetched in pages of 200 rows (`pages` Map, page index → rows); missing rows render a placeholder until their page arrives. A `gen` counter discards stale responses after a query change.
`reload(keepScroll)` fetches count + visible pages, then swaps the cache (no flicker). Used on search/filter/sort changes (scroll reset) and while a scan streams in (scroll kept, debounced 1s).

## Icons
Per extension. Renderer asks `icon:get(ext, path)` for the first visible row of an unseen extension; main calls `app.getFileIcon(path, {size:'small'})` and caches the data URL. Until loaded (or if it fails) a colored badge is shown.

## Controls
Scan/Rescan (label depends on DB being non-empty), Stop, Folder… (scope persisted in localStorage), search (80ms debounce), extension chips (none = all), sortable headers, double-click = open, folder button = show in folder, error toast when the file is gone.
