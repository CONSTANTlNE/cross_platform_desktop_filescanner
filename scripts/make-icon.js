// Generates build/icon.png (512x512) and build/icon.ico (16..256) with no dependencies.
// Run: node scripts/make-icon.js
const zlib = require('zlib'), fs = require('fs');
const SS = 3;
const path = require('path');
const N = 512; // design space
const rr = (x, y, x0, y0, x1, y1, r) => { // inside rounded rect
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
// "File Scanner": a page inside viewfinder corner brackets, with an amber scan beam across it, on teal.
function sample(x, y) {
  if (!rr(x, y, 8, 8, 504, 504, 110)) return null;
  let c = mix([20, 184, 166], [15, 118, 110], y / N); // teal gradient
  // viewfinder corner brackets (white)
  const T = 14, L = 62, lo = 82, hi = 430;
  const brackets = [
    [lo, lo, lo + L, lo + T], [lo, lo, lo + T, lo + L],
    [hi - L, lo, hi, lo + T], [hi - T, lo, hi, lo + L],
    [lo, hi - T, lo + L, hi], [lo, hi - L, lo + T, hi],
    [hi - L, hi - T, hi, hi], [hi - T, hi - L, hi, hi],
  ];
  if (brackets.some((r) => inRect(x, y, ...r))) c = [255, 255, 255];
  // page with a cut top-right corner
  const px0 = 150, px1 = 362, py0 = 112, py1 = 400, cut = 64;
  const cutCorner = x > px1 - cut && y < py0 + cut && (x - (px1 - cut)) + (py0 + cut - y) > cut;
  if (inRect(x, y, px0, py0, px1, py1) && !cutCorner) {
    c = [255, 255, 255];
    if (x > px1 - cut && y < py0 + cut) c = [203, 213, 225]; // folded corner
    for (const ly of [168, 208]) if (y >= ly && y < ly + 16 && x >= 186 && x <= (ly === 208 ? 290 : 326)) c = [148, 163, 184];
    if (inRect(x, y, px0, 286, px1, 316)) c = [254, 243, 199]; // soft glow under the beam
    for (const ly of [336, 366]) if (y >= ly && y < ly + 14 && x >= 186 && x <= (ly === 366 ? 270 : 326)) c = [226, 232, 240];
  }
  // scan beam (amber), longer than the page
  if (rr(x, y, 104, 262, 408, 288, 13)) c = [251, 191, 36];
  return c;
}

const crc = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return b => { let c = ~0; for (const v of b) c = t[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };

function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const k = N / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const c = sample((x + (i + .5) / SS) * k, (y + (j + .5) / SS) * k);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = (y * size + x) * 4;
    if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; px[o + 3] = Math.round(255 * a / (SS * SS)); }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ICO container with PNG-compressed entries (supported since Windows Vista).
function ico(sizes) {
  const imgs = sizes.map(png);
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12); offset += imgs[i].length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...imgs]);
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(512));
fs.writeFileSync(path.join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
console.log('wrote build/icon.png and build/icon.ico');
