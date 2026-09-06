/**
 * 直接分析用户导出 PDF：用 resolver 访问过的流(含 XObject)解码，抓白色矩形(P4)+原文字残留(P3)。
 */
import * as fs from "node:fs";
import { PDFDocument, PDFRef, decodePDFRawStream } from "pdf-lib";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";

const EXP = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";
const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

function decodeStream(pdf: PDFDocument, ref: string): string | null {
  const [n, g] = ref.split(" ").map(Number);
  try { const s: any = pdf.context.lookup(PDFRef.of(n, g)); const d: any = decodePDFRawStream(s).decode(); return typeof d === "string" ? d : new TextDecoder().decode(d); } catch { return null; }
}

async function main() {
  const expPdf = await PDFDocument.load(fs.readFileSync(EXP));
  const pageW = expPdf.getPage(0).getWidth();
  const pageH = expPdf.getPage(0).getHeight();

  const recs = resolvePageShowTextWithXObjects(expPdf, 0) as any[];
  const streamRefs = [...new Set(recs.map((r) => r.streamObjRef))];
  const streamTexts = streamRefs.map((ref) => decodeStream(expPdf, ref)).filter((t): t is string => typeof t === "string");
  _log(`[EXP] resolver流数=${streamRefs.length} 解码=${streamTexts.length}`);

  const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  const fillHist: Record<string, number> = {};
  for (const text of streamTexts) {
    const toks = text.split(/\s+/);
    let fill = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk === "rg") fill = "RGB:" + toks.slice(Math.max(0, i - 3), i).join(" ");
      else if (tk === "k") fill = "CMYK:" + toks.slice(Math.max(0, i - 4), i).join(" ");
      else if (tk === "re") {
        const x = parseFloat(toks[i - 4]), y = parseFloat(toks[i - 3]), w = parseFloat(toks[i - 2]), h = parseFloat(toks[i - 1]);
        if (Number.isFinite(x) && Number.isFinite(w)) { rects.push({ x, y, w, h, fill }); fillHist[fill] = (fillHist[fill] ?? 0) + 1; }
      }
    }
  }
  _log(`[EXP][P4] 矩形总数=${rects.length} pageW=${pageW.toFixed(2)} pageH=${pageH.toFixed(2)}`);
  _log(`[EXP][P4] fill直方图=${JSON.stringify(fillHist)}`);
  const white = rects.filter((r) => r.fill === "RGB:1 1 1" || r.fill === "RGB:1 1 1 1");
  white.sort((a, b) => b.w - a.w);
  _log(`[EXP][P4] 白色矩形数=${white.length}`);
  for (const r of white.slice(0, 10)) {
    const flag = r.w > pageW || r.h > pageH || r.x < 0 || r.y < 0 ? " <<超界" : "";
    _log(`       white x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} w=${r.w.toFixed(1)} h=${r.h.toFixed(1)}${flag}`);
  }
  rects.sort((a, b) => b.w - a.w);
  _log(`[EXP][P4] 最宽 top6:`);
  for (const r of rects.slice(0, 6)) _log(`       w=${r.w.toFixed(1)} h=${r.h.toFixed(1)} x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} fill=${r.fill}`);
}
const _log = console.log.bind(console);
main().catch((e) => { _log("ERR", e); process.exit(1); });
