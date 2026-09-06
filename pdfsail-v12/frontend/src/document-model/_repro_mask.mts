import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument } from "./export-renderer";
import { mutateLineText } from "./document-mutation";
import type { EditableDocument } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
const FIX = process.argv.includes("--nofix") ? false : true;
const origLog = console.log;
const log = (...a: any[]) => { origLog(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;

  let blockId = "", lineId = "", lineText = "", start = -1;
  outer:
  for (const page of doc.pages) for (const block of page.blocks) for (const line of block.lines) {
    const t = line.glyphs.map(g => g.char).join("");
    if (t.includes("4 Bidens 69")) { blockId = block.id; lineId = line.id; lineText = t; start = t.indexOf("69"); break outer; }
  }
  log(`目标行: "${lineText}" start=${start}`);

  // 编辑 "69"→"888"：新文本不含 "69" 子串 → 文本兜底剥离失败（旧"69"留在流里）；
  // 且 "8" 不在子集 → native replay 失败。→ strip+replay 双失败，旧"69"残留，正是用户 bug。
  const res = mutateLineText(doc, blockId, lineId, lineText.slice(0, start) + "888" + lineText.slice(start + 2), { start, end: start + 2 });
  const editedLine = res.document.pages.flatMap(p => p.blocks).find(b => b.id === blockId)!.lines.find(l => l.id === lineId)!;
  log(`editedOriginalBounds = ${JSON.stringify(editedLine.editedOriginalBounds)}`);
  if (!FIX) (editedLine as any).editedOriginalBounds = undefined;

  log(`FIX=${FIX ? "启用" : "禁用"}`);
  const exported = await exportEditableDocument(res.document, bytes as unknown as ArrayBuffer);
  const fn = FIX ? "_mask_fixed.pdf" : "_mask_nofix.pdf";
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/" + fn, exported);
  log(`已写出 ${fn}（残留旧"69"应被盖住 → 渲染后查看是否有重影）`);
}
main().catch(e => { origLog("ERR", e); process.exit(1); });
