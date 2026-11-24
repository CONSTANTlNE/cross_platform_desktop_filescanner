// Runs in a worker thread (with a timeout + memory limit set by main.js).
// Parses ONE untrusted document and posts a small, size-capped result:
//   {kind:'html', html, truncated}            .docx
//   {kind:'text', text, truncated}            .doc
//   {kind:'sheets', sheets:[{name, rows, total, startRow, startCol}]}   .xlsx / .xls
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const MAX_ROWS = 200;
const MAX_COLS = 30;
const MAX_CELL = 200;
const MAX_SHEETS = 20;
const MAX_HTML = 1500000;
const MAX_IMAGE_B64 = 700000;
const MAX_TEXT = 200000;

async function docx(p) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml(
    { path: p },
    {
      convertImage: mammoth.images.imgElement(async (img) => {
        const b64 = await img.read('base64');
        return b64.length > MAX_IMAGE_B64 ? { src: '' } : { src: `data:${img.contentType};base64,${b64}` };
      }),
    }
  );
  let html = r.value;
  let truncated = false;
  if (html.length > MAX_HTML) {
    const cut = Math.max(html.lastIndexOf('</p>', MAX_HTML), html.lastIndexOf('</table>', MAX_HTML));
    html = html.slice(0, cut > 0 ? cut + 8 : MAX_HTML);
    truncated = true;
  }
  return { kind: 'html', html, truncated };
}

async function doc(p) {
  const WordExtractor = require('word-extractor');
  const d = await new WordExtractor().extract(p);
  let text = d.getBody();
  const truncated = text.length > MAX_TEXT;
  if (truncated) text = text.slice(0, MAX_TEXT);
  return { kind: 'text', text, truncated };
}

function sheets(p) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(fs.readFileSync(p), {
    type: 'buffer',
    sheetRows: MAX_ROWS + 1, // stop parsing early on huge sheets
    cellDates: true,
    cellStyles: false,
    cellHTML: false,
    bookVBA: false,
  });
  const out = wb.SheetNames.slice(0, MAX_SHEETS).map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'];
    const full = ws['!fullref'] || ref;
    const start = ref ? XLSX.utils.decode_range(ref).s : { r: 0, c: 0 };
    const total = full ? XLSX.utils.decode_range(full).e.r - start.r + 1 : 0;
    const rows = XLSX.utils
      .sheet_to_json(ws, { header: 1, raw: false, defval: '' })
      .slice(0, MAX_ROWS)
      .map((r) => r.slice(0, MAX_COLS).map((c) => String(c).slice(0, MAX_CELL)));
    return { name, rows, total, startRow: start.r + 1, startCol: start.c };
  });
  return { kind: 'sheets', sheets: out, moreSheets: wb.SheetNames.length > MAX_SHEETS };
}

(async () => {
  const { path: p, ext } = workerData;
  try {
    const res = ext === 'docx' ? await docx(p) : ext === 'doc' ? await doc(p) : sheets(p);
    parentPort.postMessage({ ok: true, ...res });
  } catch (e) {
    parentPort.postMessage({ ok: false, code: 'failed', message: String((e && e.message) || e).slice(0, 200) });
  }
})();
