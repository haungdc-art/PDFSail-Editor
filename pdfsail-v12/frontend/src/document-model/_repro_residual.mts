import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFStream, PDFRef, PDFArray } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument, renderDocumentToExportCommands } from "./export-renderer";
import { mutateLineText } from "./document-mutation";
import type { EditableDocument } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
const FIX = process.argv.includes("--nofix") ? false : true;
const out: string[] = [];
const origLog = console.log;
const log = (...a: any[]) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); out.push(s); origLog(s); };

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
  log(`目标行: "${lineText}" start=${start}`);

  // 编辑 "69"→"69€"（€ 不在子集 → replay 必然失败）
  const res = mutateLineText(doc, blockId, lineId, lineText.slice(0, start) + "69€" + lineText.slice(start + 2), { start, end: start + 1 });
  const editedLine = res.document.pages.flatMap(p => p.blocks).find(b => b.id === blockId)!.lines.find(l => l.id === lineId)!;

  // 模拟 provenance 缺失：清掉 operatorId / pdfCharCode / originalBBox → strip 也失败
  for (const g of editedLine.glyphs) {
    (g as any).operatorId = undefined;
    (g as any).operatorCharIndex = undefined;
    (g as any).pdfCharCode = undefined;
    (g as any).originalBBox = undefined;
    g.modified = true;
  }

  const ctx: any = { renderScale: 1.5, cssScale: 1, pageHeightPt: 792 };
  const cmds: any[] = renderDocumentToExportCommands(res.document, ctx) as any[];
  const masks = cmds.filter(c => c.type === "drawLine" && c.purpose === "mask" && c.blockId === blockId && c.lineIndex === editedLine.index);
  log(`生成 mask 数=${masks.length}`);
  masks.forEach((m: any) => log(`  mask x=${m.x?.toFixed?.(1)} w=${m.width?.toFixed?.(1)} (覆盖 x~${(m.x+m.width)?.toFixed?.(1)})`));

  log(`FIX=${FIX ? "启用(originalBounds 兜底)" : "禁用"}`);
  const exported = await exportEditableDocument(res.document, bytes as unknown as ArrayBuffer);
  const fn = FIX ? "_residual_fixed.pdf" : "_residual_nofix.pdf";
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/" + fn, exported);
  const expPdf = await PDFDocument.load(exported);
  const expRaw = decodePageContent(expPdf, 0);
  // 原 "69" 是 CID 编码，无法直接搜 "(69)"；改测：原文本是否仍含可识别的 "69" 字形码
  const hasTj = (expRaw.match(/Tj|TJ/g) || []).length;
  log(`导出流 Tj/TJ 算子数=${hasTj}; 渲染见 ${fn}`);
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_residual.txt", out.join("\n"), "utf8");
}
main().catch(e => { origLog("ERR", e); process.exit(1); });
