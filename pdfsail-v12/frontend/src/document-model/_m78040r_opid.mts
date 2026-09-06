import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument } from "./types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const _log = console.log.bind(console);

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const doc = await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, await PDFDocument.load(bytes)) as EditableDocument;
  const recs = resolvePageShowTextWithXObjects(await PDFDocument.load(bytes), 0) as any[];
  // 取 l27 (10MM Plywood 行)
  const line = doc.pages[0].blocks.flatMap((b: any) => b.lines).find((l: any) => l.id === "pdf_pdf_p1_block0_l27");
  const opIds = new Set(line.glyphs.filter((g: any) => g.operatorId).map((g: any) => g.operatorId));
  _log(`l27 glyph数=${line.glyphs.length} 不同operatorId数=${opIds.size}`);
  _log(`l27 示例glyph.operatorId=${line.glyphs.slice(0, 3).map((g: any) => g.operatorId)}`);
  let matchNull = 0, matchOk = 0, noMatch = 0;
  for (const opId of opIds) {
    const rec = recs.find((r) => r.operatorId === opId);
    if (!rec) { noMatch++; _log(`  无匹配rec: ${opId}`); continue; }
    if (rec.charCodes === null) matchNull++; else matchOk++;
    _log(`  ${opId} -> byteStart=${rec.byteStart} byteEnd=${rec.byteEnd} charCodes=${rec.charCodes === null ? "NULL" : "len=" + rec.charCodes.length} operatorText="${rec.operatorText?.slice(0, 20)}"`);
  }
  _log(`汇总: 匹配且charCodes有效=${matchOk} 匹配但charCodes=NULL(会被strip跳过)=${matchNull} 无匹配=${noMatch}`);
  // 全局：resolver 中 charCodes=null 的算子比例
  const total = recs.length;
  const nullCC = recs.filter((r: any) => r.charCodes === null).length;
  _log(`全局resolver: 算子数=${total} charCodes=NULL=${nullCC} (${(nullCC / total * 100).toFixed(1)}%)`);
  // 全局：import 后 glyph 有 operatorId 的比例
  const allG = doc.pages[0].blocks.flatMap((b: any) => b.lines).flatMap((l: any) => l.glyphs);
  const withOp = allG.filter((g: any) => g.operatorId).length;
  _log(`全局glyph: 总数=${allG.length} 有operatorId=${withOp} (${(withOp / allG.length * 100).toFixed(1)}%)`);
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
