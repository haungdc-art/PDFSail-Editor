/** diag9 — check operatorId presence right after parsePdfToEditableDocument */
import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import type { EditableDocument } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, throwOnInvalidObject: false });
  const doc = (await parsePdfToEditableDocument(new Uint8Array(bytes).buffer as ArrayBuffer, pdf0)) as EditableDocument;

  let total = 0, withOpId = 0, withFontId = 0, withCharCode = 0;
  for (const page of doc.pages) {
    for (const b of page.blocks) {
      for (const line of b.lines) {
        for (const g of line.glyphs) {
          total++;
          if ((g as any).operatorId) withOpId++;
          if ((g as any).fontIdentity || (g as any).metrics?.fontIdentity) withFontId++;
          if ((g as any).pdfCharCode ?? (g as any).metrics?.pdfCharCode) withCharCode++;
        }
      }
    }
  }
  console.log(`total=${total} withOpId=${withOpId} withFontId=${withFontId} withCharCode=${withCharCode}`);
  // sample edited line 0 of page1 block0
  const line = doc.pages[0].blocks.find((b) => b.id === "pdf_p1_block0")?.lines[0];
  if (line) {
    console.log("line0 text:", JSON.stringify(line.glyphs.map((g) => g.char).join("")));
    for (const g of line.glyphs.slice(0, 6)) {
      const fi: any = (g as any).fontIdentity ?? (g as any).metrics?.fontIdentity;
      console.log(`  ${JSON.stringify(g.char)} opId=${(g as any).operatorId ?? "-"} code=${(g as any).pdfCharCode ?? (g as any).metrics?.pdfCharCode ?? "-"} fontRef=${fi?.fontRef ?? "-"} emb=${fi?.embedded ?? "-"}`);
    }
  }
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
