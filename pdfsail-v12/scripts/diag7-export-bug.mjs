/**
 * diag7b — dump raw content-stream ops around the edited rows:
 *   row1 y_pdf=760.10 → y_tm≈81.75
 *   row2 y_pdf=698.05 → y_tm≈143.80 ("power 100%"), "1 passes" y_pdf=711.60 → y_tm≈130.25
 * for ORIGINAL vs EXPORTED. Shows masks (re f), emptied Tj, overlay draws.
 */
import { PDFDocument, PDFArray, decodePDFRawStream } from "pdf-lib";
import { readFileSync } from "node:fs";

const origPath = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const expPath = process.argv[2] || "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";

async function main() {
  for (const [label, path] of [["ORIGINAL", origPath], ["EXPORTED", expPath]]) {
    console.log(`\n########## ${label}`);
    const doc = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true });
    const page = doc.getPage(0);
    const csNode = page.node.Contents();
    const streams = csNode instanceof PDFArray ? csNode.asArray().map((r) => doc.context.lookup(r)) : [csNode];
    let text = "";
    for (const s of streams) {
      try { text += new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()); } catch { /* */ }
    }
    // find all Tm ops with y in [70..160] (row1/row2 zone in tm space)
    const tmRe = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g;
    // Instead: scan line by line; print ops between "BT" and "ET" whose Tm y is in zone
    const lines = text.split("\n");
    let inBT = false, buf = [];
    const zone = (s) => {
      const m = s.match(/([-\d.]+)\s+[-\d.]+\s+Tm/);
      if (!m) return false;
      const y = parseFloat(m[1]);
      return y >= 60 && y <= 160;
    };
    for (const ln of lines) {
      if (/\bBT\b/.test(ln)) { inBT = true; buf = [ln]; continue; }
      if (inBT) buf.push(ln);
      if (/\bET\b/.test(ln) && inBT) {
        inBT = false;
        const block = buf.join("\n");
        if (zone(block)) {
          // compress: only show interesting ops
          const compact = block.replace(/[^\x20-\x7E\n]/g, "·").replace(/\n+/g, " ⏎ ");
          console.log(compact.length > 900 ? compact.slice(0, 900) + "…TRUNC" : compact);
          console.log("---");
        }
      }
    }
  }
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
