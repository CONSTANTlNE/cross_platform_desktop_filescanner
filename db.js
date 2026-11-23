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

    -- External-content FTS5 table; trigram tokenizer gives case-insensitive substring search.
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      name, content='files', content_rowid='id', tokenize='trigram'
    );
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

function escLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function buildWhere({ search, exts } = {}) {
  const where = [];
  const params = [];
  if (Array.isArray(exts) && exts.length) {
    where.push(`f.ext IN (${exts.map(() => '?').join(',')})`);
    params.push(...exts);
  }
  const terms = String(search || '').trim().split(/\s+/).filter(Boolean);
  if (terms.length) {
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
  return db
    .prepare(
      `SELECT f.id, f.path, f.name, f.ext, f.size, f.modified_at, f.folder
       FROM files f ${sql} ORDER BY ${col} ${dir}, f.id ${dir} LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
}

const total = () => db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
const removeByPath = (p) => db.prepare('DELETE FROM files WHERE path = ?').run(p);
const close = () => db && db.close();

module.exports = { open, upsertBatch, deleteMissing, count, query, total, removeByPath, close };
