import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument } from "./types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const _log = console.log.bind(console);
const SUPPRESS = /\[?(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|SignatureRotationTrace|M7\.8-022A|NATIVE_DISABLED|M7\.8-035|M7\.8-036|M7\.8-037|provenance|Provenance)/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf)) as EditableDocument;

  _log("########## A. EditableDocument block/line id 结构（跨页）##########");
  for (const page of doc.pages) {
    _log(`-- page.index=${page.index} blocks=${page.blocks.length}`);
    for (const b of page.blocks) {
      _log(`   block.id="${b.id}" lines=${b.lines.length}`);
      for (const l of b.lines) {
        const txt = l.glyphs.map((g: any) => g.char).join("").slice(0, 30);
        const opIds = new Set(l.glyphs.filter((g: any) => g.operatorId).map((g: any) => g.operatorId));
        _log(`      line.id="${l.id}" glyphs=${l.glyphs.length} distinctOperatorId=${opIds.size} sampleOpId=${[...opIds][0] ?? "NONE"} text="${txt}"`);
      }
    }
  }

  _log("\n########## B. 原始 PDF content stream per page (operator text) ##########");
  for (let pg = 0; pg < pdf.getPageCount(); pg++) {
    const recs = resolvePageShowTextWithXObjects(pdf, pg) as any[];
    _log(`-- page ${pg} ops=${recs.length}`);
    for (const r of recs) _log(`   id="${r.operatorId}" text="${String(r.operatorText).slice(0, 50)}"`);
  }
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
