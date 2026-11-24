// Long-lived worker thread: extracts the plain text of one document per message.
//   in:  {id, path, ext}
//   out: {id, ok:true, text, chars, truncated}  |  {id, ok:false, note}
// Used only by indexer.js (timeouts, memory limits and restarts are handled there).
const { parentPort } = require('worker_threads');
const fs = require('fs');

const MAX_CHARS = 1000000; // stored text per file
const MAX_PDF_PAGES = 1500;

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

async function docx(p) {
  const mammoth = require('mammoth');
  return (await mammoth.extractRawText({ path: p })).value;
}

async function doc(p) {
  const WordExtractor = require('word-extractor');
  const d = await new WordExtractor().extract(p);
  return [d.getBody(), d.getHeaders && d.getHeaders(), d.getFootnotes && d.getFootnotes()].filter(Boolean).join('\n');
}

function sheets(p) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer', cellDates: true, cellStyles: false, bookVBA: false, dense: true });
  const out = [];
  let n = 0;
  for (const name of wb.SheetNames) {
    out.push(name);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    for (const r of rows) {
      const line = r.join(' ');
      out.push(line);
      n += line.length;
      if (n > MAX_CHARS * 2) return out.join('\n');
    }
  }
  return out.join('\n');
}

let pdfjs = null;
async function pdf(p) {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.promises.readFile(p));
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  const document = await task.promise;
  const parts = [];
  let n = 0;
  try {
    for (let i = 1; i <= Math.min(document.numPages, MAX_PDF_PAGES); i++) {
      const page = await document.getPage(i);
      const tc = await page.getTextContent();
      let line = '';
      for (const it of tc.items) line += (it.str ?? '') + (it.hasEOL ? '\n' : ' ');
      parts.push(line);
      page.cleanup();
      n += line.length;
      if (n > MAX_CHARS * 2) break;
    }
  } finally {
    await task.destroy();
  }
  return parts.join('\n');
}

parentPort.on('message', async ({ id, path: p, ext }) => {
  try {
    const raw = ext === 'docx' ? await docx(p) : ext === 'doc' ? await doc(p) : ext === 'pdf' ? await pdf(p) : sheets(p);
    const text = norm(raw);
    parentPort.postMessage({ id, ok: true, text: text.slice(0, MAX_CHARS), chars: text.length, truncated: text.length > MAX_CHARS });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, note: String((e && e.message) || e).slice(0, 200) });
  }
});
