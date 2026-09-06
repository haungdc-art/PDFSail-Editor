/**
 * diag2 — decode CID text via ToUnicode, locate edited lines in content stream,
 * dump surrounding operators (Tm/Tf/Tj) for original vs exported PDF.
 */
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

function inflate(s) {
  let raw;
  try { raw = s.getContents(); } catch { return ""; }
  const buf = Buffer.from(raw);
  try { return zlib.inflateSync(buf).toString("latin1"); } catch { return buf.toString("latin1"); }
}

/** minimal ToUnicode CMap parser: returns Map<code(hexnum), string> */
function parseToUnicode(fontDict, doc) {
  const out = new Map();
  const toU = fontDict.get?.("ToUnicode") ?? fontDict.Context?.lookup?.("ToUnicode");
  if (!toU) return out;
  let text = "";
  try { text = inflate(toU); } catch { return out; }
  // bfchar blocks
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const src = parseInt(p[1], 16);
      const dstHex = p[2];
      let dst = "";
      for (let i = 0; i < dstHex.length; i += 4) dst += String.fromCharCode(parseInt(dstHex.slice(i, i + 4), 16));
      out.set(src, dst);
    }
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16), base = parseInt(p[3], 16);
      for (let c = lo; c <= hi; c++) out.set(c, String.fromCharCode(base + (c - lo)));
    }
  }
  return out;
}

function analyze(path, label) {
  const doc = PDFDocument.load(readFileSync(path), { ignoreEncryption: true });
  return doc;
}

function getFontMaps(page, doc) {
  const maps = new Map(); // font name -> {map, subType, baseFont}
  try {
    const res = page.node.Resources();
    const fontRes = res?.lookup?.("Font", PDFDocument) ?? res?.get?.("Font");
    if (!fontRes) return maps;
    const dict = fontRes.dict ?? fontRes;
    for (const [name, ref] of Object.entries(dict.entries ?? {})) {
      const f = doc.context.lookup(ref);
      if (!f) continue;
      const sub = f.get?.("Subtype")?.toString?.() ?? "";
      const base = f.get?.("BaseFont")?.toString?.() ?? "";
      maps.set(name, { map: parseToUnicode(f, doc), sub, base });
    }
  } catch (e) { console.log("fontmap err", e.message); }
  return maps;
}

/** tokenize content stream into text ops with context */
function extractTextOps(stream) {
  const ops = [];
  // match Tf / Tm / Td / TD / Tj sequences
  const re = /\/(F\d+\w*|F\w+)\s+[\d.]+\s+Tf|((?:[-.\d]+\s+){6})Tm|<([0-9A-Fa-f]+)>\s*Tj|\(([^)]*)\)\s*Tj|[-.\d]+\s+TD|[-.\d]+\s+[-.\d]+\s+Td/g;
  let curFont = null, curTm = null;
  let m;
  while ((m = re.exec(stream))) {
    if (m[1]) { curFont = m[1]; ops.push({ t: "Tf", font: m[1] }); }
    else if (m[2]) { curTm = m[2].trim(); ops.push({ t: "Tm", tm: curTm }); }
    else if (m[3]) ops.push({ t: "Tj", hex: m[3], font: curFont, tm: curTm, at: m.index });
    else if (m[4]) ops.push({ t: "Tj", lit: m[4], font: curFont, tm: curTm, at: m.index });
  }
  return ops;
}

function decodeHex(hex, map) {
  let s = "";
  for (let i = 0; i + 1 < hex.length; i += hex.length >= 8 ? 4 : 2) {
    const code = parseInt(hex.slice(i, i + (hex.length >= 8 ? 4 : 2)), 16);
    s += map.get(code) ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : "?");
  }
  return s;
}

const origPath = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const expPath = process.argv[2] || "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";

for (const [label, path] of [["ORIGINAL", origPath], ["EXPORTED", expPath]]) {
  console.log(`\n########## ${label}: ${path}`);
  const doc = await analyze(path, label);
  const page = doc.getPages()[0];
  const cs = page.node.Contents();
  const streams = cs.constructor.name === "PDFArray" ? cs.asArray().map((r) => doc.context.lookup(r)) : [cs];
  const text = streams.map(inflate).join("\n");
  console.log("stream len:", text.length);
  const fontMaps = getFontMaps(page, doc);
  console.log("fonts:", [...fontMaps.entries()].map(([n, f]) => `${n}:${f.base}`).join(", "));
  const ops = extractTextOps(text);
  // decode all Tj and find lines containing S30/S33/power
  const decoded = ops.filter((o) => o.t === "Tj").map((o) => {
    const fm = fontMaps.get(o.font);
    const str = o.hex ? decodeHex(o.hex, fm?.map ?? new Map()) : (o.lit ?? "");
    return { ...o, str };
  });
  const joined = decoded.map((d, i) => ({ i, ...d }));
  // find runs containing keywords
  for (const kw of ["S30", "S33", "power", "POWER", "Power"]) {
    const hits = joined.filter((d) => d.str.includes(kw));
    console.log(`\n-- keyword "${kw}": ${hits.length} Tj hits`);
    for (const h of hits.slice(0, 3)) {
      // dump neighbors: from previous Tf/Tm to next few Tj
      const from = Math.max(0, h.i - 4);
      const to = Math.min(joined.length - 1, h.i + 6);
      for (let k = from; k <= to; k++) {
        const d = joined[k];
        console.log(`   [${d.i}] ${d.t} ${d.t === "Tj" ? `hex=${(d.hex ?? d.lit ?? "").slice(0, 60)} -> "${d.str.slice(0, 40)}" font=${d.font} tm=(${d.tm})` : d.t === "Tm" ? `(${d.tm})` : d.font}`);
      }
      console.log("   --- raw stream around offset ---");
      console.log(text.slice(Math.max(0, h.at - 300), h.at + 200).replace(/[^\x20-\x7E\n]/g, "·"));
    }
  }
}
