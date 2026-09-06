import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { mutateLineText } from "./document-mutation";
import type { EditableDocument } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
(async () => {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;
  let blockId = "", lineId = "", lineText = "", start = -1;
  outer:
  for (const page of doc.pages) for (const block of page.blocks) for (const line of block.lines) {
    const t = line.glyphs.map(g => g.char).join("");
    if (t.includes("4 Bidens 69")) { blockId = block.id; lineId = line.id; lineText = t; start = t.indexOf("69"); break outer; }
  }
  const res = mutateLineText(doc, blockId, lineId, lineText.slice(0, start) + "69€" + lineText.slice(start + 2), { start, end: start + 2 });
  const editedLine = res.document.pages.flatMap(p => p.blocks).find(b => b.id === blockId)!.lines.find(l => l.id === lineId)!;
  console.log("editedOriginalBounds =", JSON.stringify(editedLine.editedOriginalBounds));
  console.log("glyphs:");
  editedLine.glyphs.forEach((g: any, i: number) => {
    console.log(`  [${i}] char=${JSON.stringify(g.char)} mod=${g.modified} bbox=${g.bbox ? JSON.stringify({x:+g.bbox.x.toFixed(1),w:+g.bbox.width.toFixed(1)}) : "none"} origBBox=${g.originalBBox ? "yes" : "none"}`);
  });
})().catch(e => { console.error("ERR", e); process.exit(1); });
