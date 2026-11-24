// Skip rules, grouped so the user can include each group in scans from Settings.
// Shared by main (settings defaults, UI list) and the scanner worker (via workerData.skip).
// Windows values are lowercase; drive letters are stripped before comparing.
const isWin = process.platform === 'win32';

const common = [
  { id: 'nodeModules', names: ['node_modules'] },
  { id: 'git', names: ['.git'] },
];

const WIN_GROUPS = [
  { id: 'win_windows', abs: ['\\windows'] },
  { id: 'win_programFiles', abs: ['\\program files', '\\program files (x86)'] },
  { id: 'win_programData', abs: ['\\programdata'] },
  { id: 'win_recycle', names: ['$recycle.bin', 'system volume information'] },
  { id: 'win_temp', suffix: ['\\appdata\\local\\temp'] },
  ...common,
];

const LINUX_GROUPS = [
  { id: 'linux_virtual', abs: ['/proc', '/sys', '/dev', '/run'], warn: true },
  { id: 'linux_system', abs: ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot'] },
  ...common,
];

const GROUPS = isWin ? WIN_GROUPS : LINUX_GROUPS;
const ALL_IDS = [...new Set([...WIN_GROUPS, ...LINUX_GROUPS].map((g) => g.id))];

// include: { groupId: true } means "scan it anyway". Returns plain arrays (structured-cloneable).
function buildSkip(include = {}) {
  const out = { names: [], abs: [], suffix: [] };
  for (const g of GROUPS) {
    if (include[g.id] === true) continue;
    out.names.push(...(g.names || []));
    out.abs.push(...(g.abs || []));
    out.suffix.push(...(g.suffix || []));
  }
  return out;
}

// Photos are found by file name only (never content-indexed). Tiny images are almost always UI assets, so they are skipped.
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
const IMAGE_MIN_BYTES = 20 * 1024;

module.exports = { GROUPS, ALL_IDS, buildSkip, IMAGE_EXTS, IMAGE_MIN_BYTES };
