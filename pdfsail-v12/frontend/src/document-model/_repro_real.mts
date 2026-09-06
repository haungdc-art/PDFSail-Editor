import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFStream, PDFRef, PDFArray } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument, renderDocumentToExportCommands } from "./export-renderer";
import { mutateLineText } from "./document-mutation";
import type { EditableDocument } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/frontend/src/document-model/_real_src.pdf";
const out: string[] = [];
const log = (...a: any[]) => { out.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
const S = /NATIVE_REPLAY|EDITED_LINE|fully stripped|文本层清理/;
const origLog = console.log;
console.log = ((orig: any) => (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (S.test(s)) origLog(...a); })(console.log);

function decodePageContent(pdf: PDFDocument, pageIdx: number): string {
  try {
    const page = pdf.getPage(pageIdx) as any;
    const node = page.node.Contents?.();
    const streamBytes = (obj: any): Uint8Array | null => {
      if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
        try { const b = decodePDFRawStream(obj).decode(); if (b && b.length) return b; } catch {}
        try { const b = decodePDFRawStream(obj).getBytes(); if (b && b.length) return b; } catch {}
        try { const b = obj.contents?.getBytes?.(); if (b && b.length) return b; } catch {}
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

  const targets: { blockId: string; lineId: string; lineText: string; start: number }[] = [];
  for (const page of doc.pages) for (const block of page.blocks) for (const line of block.lines) {
    const t = line.glyphs.map(g => g.char).join("");
    let idx = t.indexOf("69");
    while (idx >= 0) {
      targets.push({ blockId: block.id, lineId: line.id, lineText: t, start: idx });
      idx = t.indexOf("69", idx + 2);
    }
  }
  log(`找到 ${targets.length} 个 "69" 出现`);
  targets.filter(t => t.blockId.startsWith("pdf_p1")).forEach(t => log(`  p1: "${t.lineText}" start=${t.start} line=${t.lineId}`));

  const rows: string[] = [];
  for (const tg of targets) {
    if (tg.blockId.startsWith("pdf_p2")) continue;
    let lastReplay = "";
    const hook = (...a: any[]) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); if (s.includes("NATIVE_REPLAY")) lastReplay = s; };
    const oldLog = console.log;
    (console as any).log = hook;
    try {
      const newLineText = tg.lineText.slice(0, tg.start) + "619" + tg.lineText.slice(tg.start + 2);
      const res = mutateLineText(doc, tg.blockId, tg.lineId, newLineText, { start: tg.start, end: tg.start + 1 });
      const ctx: any = { renderScale: 1.5, cssScale: 1, pageHeightPt: 792 };
      const cmds: any[] = renderDocumentToExportCommands(res.document, ctx) as any[];
      const editedLine = res.document.pages.flatMap(p => p.blocks).find(b => b.id === tg.blockId)!.lines.find(l => l.id === tg.lineId)!;
      const masks = cmds.filter(c => c.type === "drawLine" && c.purpose === "mask" && c.blockId === tg.blockId && c.lineIndex === editedLine.index);
      const exported = await exportEditableDocument(res.document, bytes as unknown as ArrayBuffer);
      const expPdf = await PDFDocument.load(exported);
      const expRaw = decodePageContent(expPdf, 0);
      const c69 = (expRaw.match(/\(69\)/g) || []).length;
      const c619 = (expRaw.match(/\(619\)/g) || []).length;
      rows.push(`line=${tg.lineId} text="${tg.lineText}" mask=${masks.length} 残留(69)=${c69} 新(619)=${c619} replay=${lastReplay}`);
    } catch (e: any) {
      rows.push(`line=${tg.lineId} text="${tg.lineText}" ERROR ${e?.message}`);
    } finally {
      (console as any).log = oldLog;
    }
  }
  log("\n=== 逐行结果 ===");
  rows.forEach(r => log(r));
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_real.txt", out.join("\n"), "utf8");
  origLog("DONE -> _repro_real.txt");
}
main().catch(e => { origLog("ERR", e); fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_real.txt", out.join("\n")); process.exit(1); });
