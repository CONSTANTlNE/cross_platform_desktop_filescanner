// SQLite access. Used ONLY from the main process.
const Database = require('better-sqlite3');
const path = require('path');

const isWin = process.platform === 'win32';

const SORTS = {
  name: 'f.name COLLATE NOCASE',
  ext: 'f.ext',
  size: 'f.size',
  modified: 'f.modified_at',
  folder: 'f.folder COLLATE NOCASE',
};

let db;
let upsertStmt;

function open(dir) {
  db = new Database(path.join(dir, 'files.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY,
      path        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      ext         TEXT NOT NULL,
      size        INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      folder      TEXT NOT NULL,
      scanned_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_ext  ON files(ext);
    CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
    CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);

    -- External-content FTS5 table; trigram tokenizer gives case-insensitive substring search.
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      name, content='files', content_rowid='id', tokenize='trigram'
    );
    -- Document contents (separate, optional step; see indexer.js). Word-based FTS with prefix search.
    CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
      text, tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
    CREATE TABLE IF NOT EXISTS content_status (
      file_id    INTEGER PRIMARY KEY,
      state      TEXT NOT NULL,           -- ok | empty (no text, e.g. scanned PDF) | error | toobig
      mtime      INTEGER NOT NULL,        -- files.modified_at / size when it was indexed (staleness check)
      size       INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      chars      INTEGER NOT NULL DEFAULT 0,
      note       TEXT
    );
    CREATE TRIGGER IF NOT EXISTS files_cd AFTER DELETE ON files BEGIN
      DELETE FROM content_fts WHERE rowid = old.id;
      DELETE FROM content_status WHERE file_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, name) VALUES (new.id, new.name);
    END;
    CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.id, old.name);
    END;
    CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE OF name ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.id, old.name);
      INSERT INTO files_fts(rowid, name) VALUES (new.id, new.name);
    END;
  `);

  upsertStmt = db.prepare(`
    INSERT INTO files (path, name, ext, size, modified_at, folder, scanned_at)
    VALUES (@path, @name, @ext, @size, @modified_at, @folder, @scanned_at)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name, ext = excluded.ext, size = excluded.size,
      modified_at = excluded.modified_at, folder = excluded.folder,
      scanned_at = excluded.scanned_at
  `);
}

const upsertBatch = (files, scannedAt) => {
  db.transaction((rows) => {
    for (const r of rows) upsertStmt.run({ ...r, scanned_at: scannedAt });
  })(files);
};

// Delete rows under `roots` that were not touched by the scan that started at `scanStart`.
function deleteMissing(roots, scanStart) {
  const stmt = db.prepare(
    `DELETE FROM files WHERE scanned_at < ? AND substr(path, 1, ?) = ? ${isWin ? 'COLLATE NOCASE' : ''}`
  );
  let removed = 0;
  db.transaction(() => {
    for (const root of roots) {
      const prefix = root.endsWith(path.sep) ? root : root + path.sep;
      removed += stmt.run(scanStart, prefix.length, prefix).changes;
    }
  })();
  return removed;
}

// every term is a prefix match, all terms must occur: "abc"* AND "def"*
const contentMatch = (terms) => terms.map((t) => '"' + t.replace(/"/g, '""') + '"*').join(' AND ');
const termsOf = (search) => String(search || '').trim().split(/\s+/).filter(Boolean);

function escLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// content-index state of a file as seen right now: a changed file counts as 'pending' again
const { IMAGE_EXTS } = require('./skip-rules');
const IMG_SQL = IMAGE_EXTS.map((e) => `'${e}'`).join(',');
const CSTATE = `CASE WHEN f.ext IN (${IMG_SQL}) THEN 'na' WHEN s.file_id IS NULL OR s.mtime <> f.modified_at OR s.size <> f.size THEN 'pending' ELSE s.state END`;

function buildWhere({ search, exts, folder, recursive, mode, cfilter } = {}) {
  const where = [];
  const params = [];
  if (Array.isArray(exts) && exts.length) {
    where.push(`f.ext IN (${exts.map(() => '?').join(',')})`);
    params.push(...exts);
  }
  if (typeof folder === 'string' && folder) {
    if (recursive) {
      const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
      where.push('(f.folder = ? OR (f.folder >= ? AND f.folder < ?))');
      params.push(folder, prefix, prefix + '\u{10FFFF}');
    } else {
      where.push('f.folder = ?');
      params.push(folder);
    }
  }
  if (cfilter) {
    where.push(`f.ext NOT IN (${IMG_SQL})`);
    const fresh = 's2.file_id = f.id AND s2.mtime = f.modified_at AND s2.size = f.size';
    if (cfilter === 'pending') where.push(`NOT EXISTS (SELECT 1 FROM content_status s2 WHERE ${fresh})`);
    else if (cfilter === 'notok') where.push(`NOT EXISTS (SELECT 1 FROM content_status s2 WHERE ${fresh} AND s2.state = 'ok')`);
    else if (['ok', 'empty', 'error', 'toobig'].includes(cfilter)) {
      where.push(`EXISTS (SELECT 1 FROM content_status s2 WHERE ${fresh} AND s2.state = ?)`);
      params.push(cfilter);
    }
  }
  const terms = String(search || '').trim().split(/\s+/).filter(Boolean);
  if (terms.length && mode === 'content') {
    where.push('f.id IN (SELECT rowid FROM content_fts WHERE content_fts MATCH ?)');
    params.push(contentMatch(terms));
  } else if (terms.length) {
    if (terms.every((t) => [...t].length >= 3)) {
      // trigram FTS needs >= 3 chars per term
      const match = terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND ');
      where.push('f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)');
      params.push(match);
    } else {
      for (const t of terms) {
        where.push("f.name LIKE ? ESCAPE '\\'");
        params.push('%' + escLike(t) + '%');
      }
    }
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function count(q) {
  const { sql, params } = buildWhere(q);
  return db.prepare(`SELECT COUNT(*) AS n FROM files f ${sql}`).get(...params).n;
}

function query(q) {
  const { sql, params } = buildWhere(q);
  const col = SORTS[q.sort] || SORTS.name;
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(+q.limit || 200, 1), 1000);
  const offset = Math.max(+q.offset || 0, 0);
  const rows = db
    .prepare(
      `SELECT f.id, f.path, f.name, f.ext, f.size, f.modified_at, f.folder, ${CSTATE} AS cstate
       FROM files f LEFT JOIN content_status s ON s.file_id = f.id
       ${sql} ORDER BY ${col} ${dir}, f.id ${dir} LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const terms = termsOf(q.search);
  if (q.mode === 'content' && terms.length && rows.length) {
    // hits are wrapped in U+0001 ... U+0002 (the renderer turns them into <mark>)
    const snip = db
      .prepare(
        `SELECT rowid AS id, snippet(content_fts, 0, char(1), char(2), '…', 14) AS s FROM content_fts
         WHERE content_fts MATCH ? AND rowid IN (${rows.map(() => '?').join(',')})`
      )
      .all(contentMatch(terms), ...rows.map((r) => r.id));
    const byId = new Map(snip.map((r) => [r.id, r.s]));
    for (const r of rows) r.snippet = byId.get(r.id) || '';
  }
  return rows;
}

// ---------- content index ----------
const PENDING = `(f.ext NOT IN (${IMG_SQL}) AND (s.file_id IS NULL OR s.mtime <> f.modified_at OR s.size <> f.size OR (s.state = 'toobig' AND f.size <= @max)))`;

const pendingCount = (maxBytes) =>
  db.prepare(`SELECT COUNT(*) AS n FROM files f LEFT JOIN content_status s ON s.file_id = f.id WHERE ${PENDING}`).get({ max: maxBytes }).n;

const pendingBatch = (afterId, limit, maxBytes) =>
  db
    .prepare(
      `SELECT f.id, f.path, f.name, f.ext, f.size, f.modified_at FROM files f
       LEFT JOIN content_status s ON s.file_id = f.id
       WHERE f.id > @after AND ${PENDING} ORDER BY f.id LIMIT @limit`
    )
    .all({ after: afterId, limit, max: maxBytes });

// items: [{id, state, mtime, size, text, chars, note}]; rows whose file disappeared meanwhile are skipped
function saveContent(items) {
  const exists = db.prepare('SELECT 1 FROM files WHERE id = ?');
  const del = db.prepare('DELETE FROM content_fts WHERE rowid = ?');
  const ins = db.prepare('INSERT INTO content_fts(rowid, text) VALUES (?, ?)');
  const st = db.prepare(
    `INSERT INTO content_status (file_id, state, mtime, size, indexed_at, chars, note) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET state = excluded.state, mtime = excluded.mtime, size = excluded.size,
       indexed_at = excluded.indexed_at, chars = excluded.chars, note = excluded.note`
  );
  db.transaction((list) => {
    for (const it of list) {
      if (!exists.get(it.id)) continue;
      del.run(it.id);
      if (it.text) ins.run(it.id, it.text);
      st.run(it.id, it.state, it.mtime, it.size, Date.now(), it.chars || 0, it.note || null);
    }
  })(items);
}

function contentStats(maxBytes) {
  const by = Object.fromEntries(
    db.prepare(`SELECT ${CSTATE} AS c, COUNT(*) AS n FROM files f LEFT JOIN content_status s ON s.file_id = f.id GROUP BY c`).all().map((r) => [r.c, r.n])
  );
  const byExt = db
    .prepare(
      `SELECT ext, COUNT(*) AS total, SUM(c = 'ok') AS ok, SUM(c = 'pending') AS pending, SUM(c = 'empty') AS empty,
              SUM(c = 'error') AS error, SUM(c = 'toobig') AS tooBig
       FROM (SELECT f.ext AS ext, ${CSTATE} AS c FROM files f LEFT JOIN content_status s ON s.file_id = f.id)
       WHERE ext NOT IN (${IMG_SQL}) GROUP BY ext ORDER BY ext`
    )
    .all();
  const emptyPdf = db
    .prepare(`SELECT COUNT(*) AS n FROM files f JOIN content_status s ON s.file_id = f.id WHERE f.ext = 'pdf' AND s.state = 'empty' AND s.mtime = f.modified_at AND s.size = f.size`)
    .get().n;
  const agg = db.prepare('SELECT COALESCE(SUM(chars), 0) AS chars, MAX(indexed_at) AS last FROM content_status').get();
  return {
    total: total() - (by.na || 0), ok: by.ok || 0, pending: by.pending || 0, empty: by.empty || 0, emptyPdf, error: by.error || 0, tooBig: by.toobig || 0,
    chars: agg.chars, lastIndexedAt: agg.last || 0, byExt,
    toIndex: pendingCount(maxBytes), // what "Index contents" would process now (includes files that are no longer too big)
  };
}

const clearContent = () => db.transaction(() => { db.exec('DELETE FROM content_fts'); db.exec('DELETE FROM content_status'); })();

// Rename one file row (path + name; folder/ext unchanged). A stale row already holding the new path is dropped.
const renameFile = (oldPath, newPath, newName) =>
  db.transaction(() => {
    db.prepare('DELETE FROM files WHERE path = ? AND path <> ?').run(newPath, oldPath);
    return db.prepare('UPDATE files SET path = ?, name = ? WHERE path = ?').run(newPath, newName, oldPath).changes;
  })();

// ids only, same ordering as query(); no limit when q.limit is absent (used for range / select-all)
function ids(q) {
  const { sql, params } = buildWhere(q);
  const col = SORTS[q.sort] || SORTS.name;
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const limit = q.limit > 0 ? Math.min(+q.limit, 2000000) : -1;
  const offset = Math.max(+q.offset || 0, 0);
  return db.prepare(`SELECT f.id FROM files f ${sql} ORDER BY ${col} ${dir}, f.id ${dir} LIMIT ? OFFSET ?`).pluck().all(...params, limit, offset);
}

function byIds(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    out.push(...db.prepare(`SELECT id, path, name, size FROM files WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  return out;
}

const removePaths = (paths) =>
  db.transaction((list) => {
    const stmt = db.prepare('DELETE FROM files WHERE path = ?');
    for (const p of list) stmt.run(p);
  })(paths);

const hasPath = (p) => db.prepare('SELECT 1 FROM files WHERE path = ?').get(p) !== undefined;

function underWhere(folder) {
  const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
  return { sql: 'folder = ? OR (folder >= ? AND folder < ?)', params: [folder, prefix, prefix + '\u{10FFFF}'] };
}
const folderStats = (folder) => {
  const w = underWhere(folder);
  return db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM files WHERE ${w.sql}`).get(...w.params);
};
const deleteUnder = (folder) => {
  const w = underWhere(folder);
  return db.prepare(`DELETE FROM files WHERE ${w.sql}`).run(...w.params).changes;
};

const total = () => db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
const removeByPath = (p) => db.prepare('DELETE FROM files WHERE path = ?').run(p);
const close = () => db && db.open && db.close();

// Find folders by name (case-insensitive substring of the folder's own name), at every level of the tree.
// Best matches first (name starts with the text, then shorter paths). Includes recursive file count / size.
function folderSearch(term, limit = 100) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return [];
  const seen = new Set();
  const found = [];
  for (const folder of db.prepare('SELECT DISTINCT folder FROM files').pluck().all()) {
    for (let p = folder; p && !seen.has(p); ) {
      seen.add(p);
      const name = path.basename(p);
      if (name && name.toLowerCase().includes(needle)) found.push({ path: p, name });
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }
  const rank = (f) => (f.name.toLowerCase().startsWith(needle) ? 0 : 1);
  found.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const direct = db.prepare('SELECT COUNT(*) AS n FROM files WHERE folder = ?');
  return found.slice(0, limit).map((f) => {
    const st = folderStats(f.path);
    // has subfolders when it holds more files (recursively) than directly inside it
    return { path: f.path, name: f.name, parent: path.dirname(f.path), count: st.n, size: st.s, hasChildren: st.n > direct.get(f.path).n };
  });
}

// Immediate subfolders of `parent` (that contain files, directly or deeper) with recursive
// file count and total size. parent '' = top level: drives on Windows, a single '/' on Linux.
function folderChildren(parent) {
  const sep = path.sep;
  let prefix;
  let mk;
  if (!parent) {
    if (isWin) {
      prefix = '';
      mk = (seg) => seg + sep;
    } else {
      const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM files').get();
      if (!r.n) return [];
      const deeper = db.prepare('SELECT 1 FROM files WHERE folder <> ? LIMIT 1').get('/') !== undefined;
      return [{ path: '/', name: '/', count: r.n, size: r.s, hasChildren: deeper }];
    }
  } else {
    prefix = parent.endsWith(sep) ? parent : parent + sep;
    mk = (seg) => prefix + seg;
  }
  const start = [...prefix].length + 1; // SQLite substr/instr count characters
  const rows = db
    .prepare(
      `SELECT seg, COUNT(*) AS n, SUM(size) AS s, SUM(direct) AS d FROM (
         SELECT CASE WHEN p > 0 THEN substr(rest, 1, p - 1) ELSE rest END AS seg,
                (p = 0) AS direct, size
         FROM (SELECT substr(folder, ?) AS rest, instr(substr(folder, ?), ?) AS p, size
               FROM files WHERE folder > ? AND folder < ?)
       ) GROUP BY seg ORDER BY seg COLLATE NOCASE`
    )
    .all(start, start, sep, prefix, prefix + '\u{10FFFF}');
  return rows.map((r) => ({ path: mk(r.seg), name: r.seg, count: r.n, size: r.s || 0, hasChildren: r.n > r.d }));
}

module.exports = { open, upsertBatch, deleteMissing, count, query, total, removeByPath, close, folderChildren, hasPath, folderStats, folderSearch, deleteUnder, renameFile, ids, byIds, removePaths,
  pendingCount, pendingBatch, saveContent, contentStats, clearContent };
