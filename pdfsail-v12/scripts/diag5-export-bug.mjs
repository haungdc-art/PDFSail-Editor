/**
 * diag5 — verify scan+invisible-OCR hypothesis:
 * 1. page image XObject (Do) coverage
 * 2. text render mode Tr 3 in original vs exported
 * 3. fill rects (re ... f) = masks in exported
 * 4. font dicts of exported (f1/f2 types)
 */
import { PDFDocument, PDFName } from "pdf-lib";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

function inflate(s) {
  const buf = Buffer.from(s.getContents());
  try { return zlib.inflateSync(buf).toString("latin1"); } catch { return buf.toString("latin1"); }
}

function stats(text, label) {
  const tr = {};
  for (const m of text.matchAll(/(\d)\s+Tr/g)) tr[m[1]] = (tr[m[1]] || 0) + 1;
  const dos = (text.match(/\bDo\b/g) || []).length;
  const refills = (text.match(/re\s*\n?\s*f\b/g) || []).length + (text.match(/\bre f\b/g) || []).length;
  const gs = (text.match(/\/(GS\d+|gs\d+)\s+gs/g) || []).length;
  console.log(`${label}: Tr modes=${JSON.stringify(tr)} Do=${dos} re-f=${refills} gs=${gs}`);
}

const origPath = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const expPath = process.argv[2] || "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";

for (const [label, path] of [["ORIGINAL", origPath], ["EXPORTED", expPath]]) {
  console.log(`\n########## ${label}`);
  const doc = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true });
  for (const [pi, page] of doc.getPages().entries()) {
    const cs = page.node.Contents();
    const streams = cs.constructor.name === "PDFArray" ? cs.asArray().map((r) => doc.context.lookup(r)) : [cs];
    const text = streams.map(inflate).join("\n");
    stats(text, `page${pi + 1} len=${text.length}`);
    if (pi === 0) {
      // image XObjects
      const res = page.node.Resources();
      const xoRef = res?.get(PDFName.of("XObject"));
      if (xoRef) {
        const xo = doc.context.lookup(xoRef);
        if (xo?.dict) {
          for (const [k, v] of xo.entries()) {
            const f = doc.context.lookup(v);
            console.log(`  XObject ${k}: Subtype=${f?.get?.(PDFName.of("Subtype"))}, ${f?.get?.(PDFName.of("Width"))}x${f?.get?.(PDFName.of("Height"))}`);
          }
        }
      }
      // fonts
      const fontRef = res?.get(PDFName.of("Font"));
      if (fontRef) {
        const fd = doc.context.lookup(fontRef);
        if (fd?.dict || fd instanceof Map || fd?.entries) {
          for (const [k, v] of fd.entries()) {
            const f = doc.context.lookup(v);
            const sub = f?.get?.(PDFName.of("Subtype"));
            const base = f?.get?.(PDFName.of("BaseFont"));
            const df = f?.get?.(PDFName.of("DescendantFonts"));
            let wInfo = "";
            if (df) {
              const df0 = doc.context.lookup(df.get ? df.get(0) : df?.[0]);
              const w = df0?.get?.(PDFName.of("W"));
              if (w) {
                const arr = w.asArray ? w.asArray() : [];
                wInfo = ` W=${arr.length} entries, first20=[${arr.slice(0, 20).map((x) => x.toString()).join(",")}]`;
              }
            }
            const widths = f?.get?.(PDFName.of("Widths"));
            if (widths) {
              const arr = widths.asArray ? widths.asArray() : [];
              wInfo += ` Widths(first10)=[${arr.slice(0, 10).map((x) => x.toString()).join(",")}]`;
            }
            console.log(`  Font ${k}: ${sub} ${base}${wInfo}`);
          }
        }
      }
      // dump a visible-text sample region: find "BT" blocks containing Tr 0 or no Tr near first f2 usage
      // count BT blocks and how many contain "3 Tr"
      const bts = text.split("BT").length - 1;
      const tr3 = (text.match(/3\s+Tr/g) || []).length;
      console.log(`  BT blocks=${bts}, Tr3=${tr3}`);
      // sample: first 3 BT blocks fully
      const blocks = text.split(/(?=BT)/).filter((b) => b.includes("BT")).slice(0, 2);
      for (const b of blocks) {
        console.log("  --- BT block sample ---");
        console.log("  " + b.slice(0, 400).replace(/[^\x20-\x7E\n]/g, "·").replace(/\n/g, " | "));
      }
    }
  }
}
