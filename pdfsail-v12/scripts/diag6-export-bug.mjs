/**
 * diag6 — check font ToUnicode presence + strip/replay failure root:
 * does the original SimSun font have /ToUnicode? What does pdf-native-adapter record?
 */
import { PDFDocument, PDFName } from "pdf-lib";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const origPath = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const doc = await PDFDocument.load(readFileSync(origPath), { ignoreEncryption: true });
const page = doc.getPages()[0];
const res = page.node.Resources();
const fontRef = res.get(PDFName.of("Font"));
const fd = doc.context.lookup(fontRef);
for (const [k, v] of fd.entries()) {
  const f = doc.context.lookup(v);
  console.log(`Font ${k}:`);
  for (const [kk, vv] of f.entries()) {
    if (kk.toString() === "/ToUnicode") {
      const s = doc.context.lookup(vv);
      let t = "";
      try { t = zlib.inflateSync(Buffer.from(s.getContents())).toString("latin1"); } catch { t = Buffer.from(s.getContents()).toString("latin1"); }
      console.log("  ToUnicode stream length:", t.length, "preview:", t.slice(0, 300).replace(/[^\x20-\x7E\n]/g, "·"));
    } else if (kk.toString() === "/DescendantFonts") {
      const dfArr = doc.context.lookup(vv);
      const df0 = doc.context.lookup(dfArr.get ? dfArr.get(0) : 0);
      for (const [dk, dv] of df0.entries()) {
        console.log("  DescendantFonts[0]", dk.toString(), dv.toString().slice(0, 80));
      }
    } else {
      console.log("  ", kk.toString(), "=", vv.toString().slice(0, 100));
    }
  }
}
