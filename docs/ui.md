# UI

Vanilla JS, single window (`renderer/app.js`).

## Virtual list
Fixed row height (28px). `#spacer` has height `total*28`; `#rows` is absolutely positioned at `first*28` and contains only visible rows (+6 overscan), re-rendered via `requestAnimationFrame` on scroll.
Data is fetched in pages of 200 rows (`pages` Map, page index → rows); missing rows render a placeholder until their page arrives. A `gen` counter discards stale responses after a query change.
`reload(keepScroll)` fetches count + visible pages, then swaps the cache (no flicker). Used on search/filter/sort changes (scroll reset) and while a scan streams in (scroll kept, debounced 1s).

## Icons
Per extension. Renderer asks `icon:get(ext, path)` for the first visible row of an unseen extension; main calls `app.getFileIcon(path, {size:'small'})` and caches the data URL. Until loaded (or if it fails) a colored badge is shown.

## Shell, tabs, i18n
`core.js` owns `window.App` (settings, `t()`, formatters, `showTab`, `set`). Modules register via `App.onReady`; events: `settings`, `langchange`, `tabshown`. Text uses `data-i18n`, `data-i18n-title`, `data-i18n-ph`.

## Columns and sorting
Column widths live in `settings.ui.cols` and feed the CSS var `--cols` (drag handle `.rs`). Sortable headers always show a faint ↕; the active one shows ▲/▼.

## Folder view
View switch List/Folders (`settings.ui.view`). The tree (lazy-loaded via `folders:children`) filters the table by folder; a folder always includes its subfolders (the old "include subfolders" checkbox / `treeSub` setting was removed). Tree is refreshed on scan completion and when the view is opened. A search box above the tree finds folders by name at any level (`folders:search` -> `db.folderSearch`): while it has text, a result list replaces the tree. Every result (name, parent path, recursive count/size, context menu, trash button) can be expanded like a tree node to browse its subfolders (`hasChildren` comes from `folderSearch`); results live in their own `searchIndex`, and `treeIndex()` picks the right node set for clicks so the normal tree keeps its expanded state. Clearing the box restores the tree.

## Panels
`#tree` and `#preview` are resizable via splitters (`#treeSplit`, `#pvSplit`); widths persist in `settings.ui.treeWidth/previewWidth`. While dragging, `#content.dragging` disables pointer events on iframes (PDF viewer). The preview width is clamped so the table keeps ≥ 560px.

## Search mode and content indexing UI
Names/Contents switch next to the search box (`settings.ui.searchMode`). In Contents mode the Folder column becomes "Match" and shows the snippet (hits wrapped in U+0001/U+0002 by SQLite `snippet()`, turned into `<mark>`); quick view shows the same snippet in `#pvHit`. The toolbar "Index contents" button, progress row (`#indexProgress`) and Settings > Content search pane live in `index-ui.js`. The About tab (`tabs.about`) holds version/data folder, instructions and limitations.

## Search spinner
`reload()` shows a spinner inside the search box when a query takes longer than ~120 ms; only the newest request clears it (`busyTicket`).

## Selection
Once a selection was built with checkboxes/Ctrl/Shift (`state.multi`), plain row clicks toggle that row instead of replacing the selection; Esc / Clear / header checkbox clear it. First column is a checkbox (header checkbox = select all/none/indeterminate). Click = single, Ctrl/Cmd+click or checkbox = toggle, Shift+click / Shift+arrows = range, Ctrl+A = all matching rows, Esc = clear. With 2+ selected a selection bar appears (count, move to trash, clear) and the status bar shows the count; quick view shows "N files selected". The `fileselect` event detail is `{row, count}`.

## Menus and shortcuts
Right-click: file rows (open, show in folder, quick view, copy path/name, rename, trash) and tree folders (open folder, copy path, scan this folder, trash). Keys: Up/Down select, Enter open, F2 rename (single only), Delete trash (single or multiple). Right-clicking inside a multi-selection offers copy paths / clear / trash N files.

## Delete UI
Trash button on each row and on tree folders (hover, not on top-level nodes); `Delete` key on the selected row. Folder modal states the recursive indexed count/size and that everything inside the folder is trashed.

## Tree rendering
Rows get vertical guide lines (`.guides`, width set from JS because the CSP blocks inline style attributes), a folder icon and an open/closed arrow.

## Compact table layout
`applyNarrow()` (files.js) adds `#table.narrow` when the full column set does not fit (tree and/or preview open, small window; recomputed on resize, settings changes and via ResizeObserver): the name column flexes and the folder column is hidden. The preview width is shrunk (`applyWidths`) so the table keeps at least ~680 px when possible.

## Fonts
Noto Sans Georgian (OFL) is bundled in `renderer/fonts`, applied with `unicode-range` so Latin text keeps the system font. CSP has `font-src 'self'`.

## Controls
Scan/Rescan (label depends on DB being non-empty), Stop, Folder… (scope persisted in localStorage), search (80ms debounce), extension chips (none = all), sortable headers, double-click = open, folder button = show in folder, error toast when the file is gone.
