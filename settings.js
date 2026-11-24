// User settings: one JSON file in userData. Main process only; the renderer goes through IPC.
const fs = require('fs');
const path = require('path');
const { ALL_IDS } = require('./skip-rules');

const DEFAULTS = {
  language: 'ka', // 'ka' | 'en'
  theme: 'system', // 'system' | 'light' | 'dark'
  scan: {
    images: true, // also list photos (jpg png gif bmp webp); name search only, never content-indexed
    scope: { mode: 'all', folder: null }, // used by the scheduler and the tray
    include: Object.fromEntries(ALL_IDS.map((id) => [id, false])), // true = scan this skip group
  },
  schedule: { mode: 'off', time: '03:00', lastRun: 0 }, // mode: 'off' | 'startup' | 'daily'
  tray: { enabled: false },
  index: { maxMb: 50 }, // content indexing: skip files larger than this
  updates: { check: true, lastCheck: 0, skipVersion: '', notified: '' }, // new-version notification (updates.js)
  ui: { view: 'list', preview: false, searchMode: 'name', previewWidth: 420, treeWidth: 320, cols: { name: 320, ext: 60, size: 90, modified: 150 } },
};

const ENUMS = {
  language: ['ka', 'en'],
  theme: ['system', 'light', 'dark'],
};

let file;
let data = clone(DEFAULTS);

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Only keys that exist in the defaults, and only values of the same type, are accepted.
function merge(target, patch) {
  for (const k of Object.keys(patch || {})) {
    if (!(k in target)) continue;
    if (isObj(target[k]) && isObj(patch[k])) merge(target[k], patch[k]);
    else if (target[k] === null || patch[k] === null || typeof target[k] === typeof patch[k]) target[k] = patch[k];
  }
}

function sanitize() {
  if (!ENUMS.language.includes(data.language)) data.language = DEFAULTS.language;
  if (!ENUMS.theme.includes(data.theme)) data.theme = DEFAULTS.theme;
  if (!['off', 'startup', 'daily'].includes(data.schedule.mode)) data.schedule.mode = 'off';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.schedule.time)) data.schedule.time = DEFAULTS.schedule.time;
  if (!['list', 'folders'].includes(data.ui.view)) data.ui.view = 'list';
  if (!['name', 'content'].includes(data.ui.searchMode)) data.ui.searchMode = 'name';
  data.index.maxMb = Math.min(Math.max(Math.round(data.index.maxMb) || 50, 5), 1000);
  for (const k of ['previewWidth', 'treeWidth']) data.ui[k] = Math.min(Math.max(Math.round(data.ui[k]) || DEFAULTS.ui[k], 200), 1400);
  for (const [k, v] of Object.entries(data.ui.cols)) {
    data.ui.cols[k] = Math.min(Math.max(Math.round(v) || DEFAULTS.ui.cols[k], 40), 900);
  }
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // settings are a convenience; never crash because the disk write failed
  }
}

function load(dir) {
  file = path.join(dir, 'settings.json');
  try {
    merge(data, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // first run or corrupt file: use defaults
  }
  sanitize();
}

const get = () => clone(data);

function set(patch) {
  merge(data, patch);
  sanitize();
  save();
  return get();
}

module.exports = { load, get, set };
