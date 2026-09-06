import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFStream, PDFRef, PDFArray } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument, renderDocumentToExportCommands } from "./export-renderer";
import { mutateLineText } from "./document-mutation";
import type { EditableDocument } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
const out: string[] = [];
const origLog = console.log;
const log = (...a: any[]) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); out.push(s); origLog(s); };
const S = /NATIVE_REPLAY|EDITED_LINE|fully stripped|文本层清理/;
console.log = ((orig: any) => (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (S.test(s)) origLog(...a); })(console.log);

function decodePageContent(pdf: PDFDocument, pageIdx: number): string {
  try {
    const page = pdf.getPage(pageIdx) as any;
    const node = page.node.Contents?.();
    const streamBytes = (obj: any): Uint8Array | null => {
      if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
        try { const b = decodePDFRawStream(obj).decode(); if (b && b.length) return b; } catch {}
        try { const b = decodePDFRawStream(obj).getBytes(); if (b && b.length) return b; } catch {}
      }
      return null;
    };
    if (!node) return "";
    const collect = (n: any): string => {
      if (n instanceof PDFArray) { let s = ""; for (const item of n.asArray()) { const o = item instanceof PDFRef ? pdf.context.lookup(item) : item; const b = streamBytes(o); if (b) s += new TextDecoder("latin1").decode(b) + "\n"; } return s; }
      const o = n instanceof PDFRef ? pdf.context.lookup(n) : n;
      const b = streamBytes(o); return b ? new TextDecoder("latin1").decode(b) : "";
    };
    return collect(node);
  } catch { return ""; }
}

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
  log(`目标行: block=${blockId} line=${lineId} text="${lineText}" start=${start}`);

  // 强制 replay 失败：改成 "69€"（€ 不在子集）
  const newText = lineText.slice(0, start) + "69€" + lineText.slice(start + 2);
  const res = mutateLineText(doc, blockId, lineId, newText, { start, end: start + 1 });
  const editedLine = res.document.pages.flatMap(p => p.blocks).find(b => b.id === blockId)!.lines.find(l => l.id === lineId)!;
  log(`\n编辑后: "${editedLine.glyphs.map(g => g.char).join("")}"`);
  log(`\n=== 编辑后 glyph 几何（看 originalBBox / glyphMetrics.pdfTransform 是否保留原文位置）===`);
  editedLine.glyphs.forEach((g: any, i: number) => {
    const tm = g.glyphMetrics?.pdfTransform;
    log(`  [${i}] char=${JSON.stringify(g.char)} origCh=${JSON.stringify(g.originalChar)} mod=${g.modified} opId=${JSON.stringify(g.operatorId)} pdfCharCode=${g.pdfCharCode ?? "undef"}`);
    log(`       bbox=${g.bbox ? JSON.stringify({x:+g.bbox.x.toFixed(1),y:+g.bbox.y.toFixed(1),w:+g.bbox.width.toFixed(1),h:+g.bbox.height.toFixed(1)}) : "none"}`);
    log(`       origBBox=${g.originalBBox ? JSON.stringify({x:+g.originalBBox.x.toFixed(1),y:+g.originalBBox.y.toFixed(1),w:+g.originalBBox.width.toFixed(1)}) : "none"}`);
    log(`       glyphMetrics.pdfTransform=${tm ? JSON.stringify(tm.map((n:number)=>+n.toFixed(1))) : "none"}`);
  });

  const ctx: any = { renderScale: 1.5, cssScale: 1, pageHeightPt: 792 };
  const cmds: any[] = renderDocumentToExportCommands(res.document, ctx) as any[];
  const masks = cmds.filter(c => c.type === "drawLine" && c.purpose === "mask" && c.blockId === blockId && c.lineIndex === editedLine.index);
  log(`\n=== 生成的 mask (${masks.length}) ===`);
  masks.forEach((m: any) => log(`  mask x=${m.x?.toFixed?.(1)} y=${m.y?.toFixed?.(1)} w=${m.width?.toFixed?.(1)} h=${m.height?.toFixed?.(1)}`));

  const exported = await exportEditableDocument(res.document, bytes as unknown as ArrayBuffer);
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_fail_export.pdf", exported);
  const expPdf = await PDFDocument.load(exported);
  const expRaw = decodePageContent(expPdf, 0);
  const c69 = (expRaw.match(/\(69\)/g) || []).length;
  const c69e = (expRaw.match(/\(69.*€|€/g) || []).length;
  log(`\n=== 结果: 残留 "(69)"=${c69} 含€=${(expRaw.match(/€/g)||[]).length} ===`);
  log(`  → 旧"69"是否残留显示: ${c69 > 0 ? "是(需修复)" : "否"}`);
}
main().catch(e => { origLog("ERR", e); process.exit(1); });
