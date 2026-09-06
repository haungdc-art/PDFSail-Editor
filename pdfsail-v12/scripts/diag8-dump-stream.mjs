// diag8c: definitive raw-op <-> pdf.js item correspondence
// - Correct ToUnicode parsing (bfchar + bfrange)
// - Group ops by (streamRef, raw Tm y); print groups with decoded text
// - Dump pdf.js items with transforms for pairing
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream, PDFArray } from "pdf-lib";
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const SRC = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const bytes = readFileSync(SRC);
const doc = await PDFDocument.load(new Uint8Array(bytes.slice(0).buffer, 0), { ignoreEncryption: true });
const page = doc.getPage(0);

// ---- collect font dicts + ToUnicode maps (page + forms, recursive) ----
const u2cMaps = new Map(); // fontName -> Map(code -> unicode)
const resourceToBase = new Map(); // resource key (FT8) -> BaseFont (LNUHNF+SimSun)
function collectFonts(resDict, depth) {
  if (!resDict || depth > 8) return;
  const fonts = resDict.get(PDFName.of("Font"));
  const fontDict = fonts instanceof PDFDict ? fonts : (fonts ? doc.context.lookup(fonts) : undefined);
  if (fontDict instanceof PDFDict) {
    for (const [k, v] of fontDict.entries()) {
      const fd = v instanceof PDFDict ? v : doc.context.lookup(v);
      if (!(fd instanceof PDFDict)) continue;
      const base = String(fd.get(PDFName.of("BaseFont")) ?? k);
      const key = String(k).replace(/^\//, "");
      resourceToBase.set(key, base);
      if (u2cMaps.has(base)) continue;
      const tu = fd.get(PDFName.of("ToUnicode"));
      const tuStream = tu ? doc.context.lookup(tu) : undefined;
      if (tuStream instanceof PDFRawStream) {
        const txt = new TextDecoder("latin1").decode(decodePDFRawStream(tuStream).decode());
        const map = new Map();
        // bfchar blocks
        const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
        let bm;
        while ((bm = bfcharRe.exec(txt))) {
          const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
          let pm;
          while ((pm = pairRe.exec(bm[1]))) {
            const code = parseInt(pm[1], 16);
            let uni = "";
            const hex = pm[2];
            for (let i = 0; i + 4 <= hex.length; i += 4) uni += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
            map.set(code, uni);
          }
        }
        // bfrange blocks
        const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
        while ((bm = bfrangeRe.exec(txt))) {
          // <lo> <hi> <dst>  |  <lo> <hi> [<d1> <d2> ...]
          const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
          let rm;
          while ((rm = rangeRe.exec(bm[1]))) {
            const lo = parseInt(rm[1], 16), hi = parseInt(rm[2], 16);
            if (rm[4] !== undefined) {
              const dstHex = rm[4];
              for (let c = lo; c <= hi && c - lo < 65536; c++) {
                let uni = "";
                for (let i = 0; i + 4 <= dstHex.length; i += 4) uni += String.fromCharCode(parseInt(dstHex.slice(i, i + 4), 16) + (c - lo));
                map.set(c, uni);
              }
            } else if (rm[5] !== undefined) {
              const dsts = rm[5].match(/<([0-9A-Fa-f]+)>/g) || [];
              for (let c = lo; c <= hi && (c - lo) < dsts.length; c++) {
                const dstHex = dsts[c - lo].slice(1, -1);
                let uni = "";
                for (let i = 0; i + 4 <= dstHex.length; i += 4) uni += String.fromCharCode(parseInt(dstHex.slice(i, i + 4), 16));
                map.set(c, uni);
              }
            }
          }
        }
        u2cMaps.set(base, map);
      }
    }
  }
  const xo = resDict.get(PDFName.of("XObject"));
  const xod = xo instanceof PDFDict ? xo : (xo ? doc.context.lookup(xo) : undefined);
  if (xod instanceof PDFDict) {
    for (const [, v] of xod.entries()) {
      const xobj = v instanceof PDFDict ? v : doc.context.lookup(v);
      const d = xobj instanceof PDFDict ? xobj : (xobj)?.dict;
      const sub = d?.get?.(PDFName.of("Subtype"));
      if (String(sub) === "/Form") {
        const xres = d.get(PDFName.of("Resources"));
        const xresDict = xres instanceof PDFDict ? xres : (xres ? doc.context.lookup(xres) : undefined);
        const mtx = d.get(PDFName.of("Matrix"));
        collectFonts(xresDict, depth + 1);
        if (mtx) console.log("[FORM] Matrix:", String(mtx));
      }
    }
  }
}
const pageRes = page.node.Resources?.();
collectFonts(pageRes instanceof PDFDict ? pageRes : (pageRes ? doc.context.lookup(pageRes) : undefined), 0);
console.log("ToUnicode maps:", [...u2cMaps.keys()].map((k) => `${k}:${u2cMaps.get(k).size}`).join(", "));

const decodeWith = (fontName, codes) => {
  // fontName = resource key (e.g. "FT8"); map to BaseFont via collected alias table
  const base = resourceToBase.get(fontName) ?? fontName;
  const m = u2cMaps.get(base) ?? u2cMaps.get("/" + base);
  if (!m) return null;
  return codes.map((c) => m.get(c) ?? `?${c.toString(16)}`).join("");
};

// ---- page streams + forms (same recursion as resolver) ----
function getPageContentsStreams(pg) {
  // simplified: page.node.Contents() array or single
  const out = [];
  const c = pg.node.Contents();
  if (c instanceof PDFArray) {
    for (const r of c.asArray()) out.push(doc.context.lookup(r));
  } else if (c) out.push(c);
  return out;
}

const groups = new Map(); // key: streamRef|y -> {streamRef, y, xs:[], text, ops}
function addOp(streamRef, y, x, fontName, codes) {
  const key = `${streamRef}|${y.toFixed(1)}`;
  let g = groups.get(key);
  if (!g) { g = { streamRef, y, min: Infinity, max: -Infinity, chars: [] }; groups.set(key, g); }
  g.min = Math.min(g.min, x); g.max = Math.max(g.max, x);
  g.chars.push({ x, text: decodeWith(fontName, codes) ?? `(${codes.join(",")})` });
}

function walkTokens(text, streamRef) {
  // track Tm and per-op char codes; decode with current font's ToUnicode
  const tokRe = /\/(F[A-Za-z0-9]+)\s+([\d.]+)\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|<([0-9A-Fa-f]+)>\s*Tj|\(([^\)]*)\)\s*Tj|(-?[\d.]+)\s+(-?[\d.]+)\s+TD/g;
  let m;
  let curFont = null;
  let tm = null;
  while ((m = tokRe.exec(text))) {
    if (m[1] !== undefined) { curFont = m[1]; continue; }
    if (m[3] !== undefined) { tm = { a: +m[3], d: +m[6], e: +m[7], f: +m[8] }; continue; }
    if (m[9] !== undefined && tm) {
      const hex = m[9];
      const codes = [];
      for (let i = 0; i + 4 <= hex.length; i += 4) codes.push(parseInt(hex.slice(i, i + 4), 16));
      // position: e + f; advance for subsequent chars handled crudely (2-byte code width unknown) — record op start only
      addOp(streamRef, tm.f, tm.e, curFont, codes);
      continue;
    }
    if (m[11] !== undefined && tm) {
      addOp(streamRef, tm.f, tm.e, curFont, Array.from(m[11]).map((ch) => ch.charCodeAt(0)));
      continue;
    }
  }
}

// walk page streams and forms
const pageStreams = getPageContentsStreams(page);
const queue = [];
let si = 0;
for (const s of pageStreams) {
  const t = new TextDecoder("latin1").decode(decodePDFRawStream(s).decode());
  queue.push({ ref: `page${si++}`, text: t, res: pageRes instanceof PDFDict ? pageRes : doc.context.lookup(pageRes) });
}
const seen = new Set();
while (queue.length) {
  const cur = queue.shift();
  walkTokens(cur.text, cur.ref);
  // find Do forms
  const doRe = /\/([A-Za-z0-9]+)\s+Do/g;
  let dm;
  const res = cur.res;
  const xo = res?.get?.(PDFName.of("XObject"));
  const xod = xo instanceof PDFDict ? xo : (xo ? doc.context.lookup(xo) : undefined);
  while ((dm = doRe.exec(cur.text))) {
    if (!xod) continue;
    const xref = xod.get(PDFName.of(dm[1]));
    if (!xref) continue;
    const xobj = doc.context.lookup(xref);
    const d = xobj instanceof PDFDict ? xobj : xobj?.dict;
    if (String(d?.get?.(PDFName.of("Subtype"))) !== "/Form") continue;
    const key = String(xref);
    if (seen.has(key)) continue;
    seen.add(key);
    const xb = new TextDecoder("latin1").decode(decodePDFRawStream(xobj).decode());
    const xres = d.get(PDFName.of("Resources"));
    queue.push({ ref: key, text: xb, res: xres instanceof PDFDict ? xres : (xres ? doc.context.lookup(xres) : undefined) });
  }
}

// print groups sorted by y desc
const sorted = [...groups.values()].sort((a, b) => b.y - a.y);
console.log(`\n=== raw op groups (y desc): ${sorted.length} ===`);
for (const g of sorted) {
  const chars = g.chars.map((c) => c.text).join("");
  console.log(`y=${g.y.toFixed(1)} x=[${g.min.toFixed(1)}..${g.max.toFixed(1)}] stream=${g.streamRef} chars=${g.chars.length} text=${JSON.stringify(chars.slice(0, 80))}`);
}

// ---- pdf.js items ----
const pdfjsDoc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
const p1 = await pdfjsDoc.getPage(1);
const tc = await p1.getTextContent();
console.log(`\n=== pdf.js items (y desc, first 40) ===`);
const items = tc.items
  .filter((it) => it.str && it.str.trim())
  .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
for (const it of items.slice(0, 40)) {
  console.log(`y=${it.transform[5].toFixed(2)} x=${it.transform[4].toFixed(2)} w=${it.width.toFixed(2)} font=${it.fontName} ${JSON.stringify(it.str.slice(0, 40))}`);
}
await pdfjsDoc.destroy();
