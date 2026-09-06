import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument } from "./export-renderer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const _log = console.log.bind(console);
const SUPPRESS = /\[?(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|SignatureRotationTrace|M7\.8-022A|NATIVE_DISABLED|M7\.8-035|M7\.8-036|M7\.8-037|provenance|Provenance|009B-2a|MASK_DIAG|lineBoundaryGlyphCounts|lines=\d+|line\d+: "|y=\d+\.\d+ h=\d|x=\d+ xEnd=\d+ y=\d+ glyphs=\d+|EXPORT_PATH|NATIVE_DISABLED)/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };

function pageOps(pdf: PDFDocument, pIdx: number) { return resolvePageShowTextWithXObjects(pdf, pIdx) as any[]; }
function graphicsCount(pdf: PDFDocument, pIdx: number) {
  try {
    const page = pdf.getPage(pIdx);
    const contents = (page as any).node.Contents();
    const streams: any[] = [];
    if (contents && contents.constructor && contents.constructor.name === "PDFArray") { for (let i = 0; i < contents.size(); i++) streams.push(contents.get(i)); } else streams.push(contents);
    let txt = "";
    for (const s of streams) txt += new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()) + "\n";
    const ops = ["re", "m", "l", "c", "v", "y", "h", "S", "s", "f", "F", "n", "BT", "ET", "cm", "Tm", "Td", "TD", "Tj", "TJ"];
    const counts: Record<string, number> = {};
    for (const op of ops) { const re = new RegExp(`(^|[^A-Za-z])${op.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "g"); counts[op] = (txt.match(re) || []).length; }
    return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  } catch (e) { return { counts: {}, total: -1 }; }
}
async function getTextContent(pageIndex1Based: number) {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const pdfjs = await getDocument({ data: new Uint8Array(fs.readFileSync(ORIG).buffer.slice(0)), isEvalSupported: false }).promise;
  const page = await pdfjs.getPage(pageIndex1Based);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1.5 });
  await pdfjs.destroy();
  return { tc, vp };
}
async function buildSegForPage(doc: EditableDocument, pIdx: number) {
  const { tc, vp } = await getTextContent(pIdx);
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
  return buildSegments(lines, mapper, new FontAnalyzerImpl(), pIdx, undefined) as Segment[];
}

async function run() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;
  const gBase = [0, 1, 2].map((p) => graphicsCount(pdf0, p));

  // 第1页 CNPJ 行
  const segs1 = await buildSegForPage(doc, 1);
  const cnpjSeg = segs1.find((s) => s.text.includes("0001-79"))!;
  const cnpjLine = doc.pages[0].blocks[0].lines.find((l) => l.glyphs.map((g) => g.char).join("").includes("0001-79"))!;
  const lineText = cnpjLine.glyphs.map((g) => g.char).join("");
  const s7 = lineText.indexOf("0001-79") + "0001-".length; // "7" 下标
  const src = (cnpjSeg as any).source;
  const probeG = cnpjLine.glyphs[0];
  _log(`CNPJ 行 line.id=${cnpjLine.id}  "7" glyph 下标=${s7}`);
  _log(`  glyph[0] keys=${Object.keys(probeG).join(",")} fontIdentity=${probeG.fontIdentity ? JSON.stringify(probeG.fontIdentity).slice(0,80) : "UNDEF"}`);

  const cases: { name: string; repl: string }[] = [
    { name: "R1 79→78", repl: "78" },
    { name: "R2 79→7", repl: "7" },
    { name: "R3 79→79123", repl: "79123" },
  ];

  for (const c of cases) {
    _log(`\n===== ${c.name}（选中 "79" 子区间替换） =====`);
    const seg: Segment = { ...cnpjSeg, id: "seg_" + c.name, text: c.repl, originalText: "79",
      source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex: s7, endGlyphIndex: s7 + 1 } } as any;
    const updated = applySegmentEditsToDocument(doc, [seg]) as EditableDocument;
    (updated as any).runtime = { renderScale: 1.5, cssScale: 1, pageMetrics: updated.pages.map((p: any) => ({ width: p.width, height: p.height })) };
    const mods = updated.pages[0].blocks[0].lines.find((l) => l.id === cnpjLine.id)!.glyphs.filter((g: any) => g.modified);
    const withOp = mods.filter((g: any) => !!g.operatorId);
    _log(`  mutation: modified=${mods.length}, 带operatorId=${withOp.length} -> ${[...new Set(mods.map((g:any)=>g.operatorId))].slice(0,4).join(",")||"(空)"}`);

    // 完整导出（overlay + strip）
    const out = await exportEditableDocument(updated, bytes as unknown as ArrayBuffer, undefined as any, undefined as any, undefined as any);
    const outPdf = await PDFDocument.load(out);
    const expOps = pageOps(outPdf, 0);
    const origStillExp = expOps.some((r) => (r.unicodeText ?? "").includes("0001-79"));
    const newStr = c.repl === "7" ? "0001-7," : c.repl === "78" ? "0001-78," : "0001-79123,";
    const newPresent = expOps.some((r) => (r.unicodeText ?? "").includes(newStr));
    const newCount = expOps.filter((r) => (r.unicodeText ?? "").includes(newStr)).length;
    const gA0 = graphicsCount(outPdf, 0);
    _log(`  [完整导出] page0 算子 ${pageOps(pdf0,0).length}→${expOps.length}`);
    _log(`    原 '0001-79' 残留? ${origStillExp}   新 '${newStr}' 出现? ${newPresent} 次数=${newCount}`);
    _log(`    重影(原残留且新在)? ${origStillExp && newPresent}`);
    _log(`    graphics page0: base.total=${gBase[0].total} → after.total=${gA0.total} 一致? ${JSON.stringify(gA0.counts)===JSON.stringify(gBase[0].counts)}`);
  }

  // R4: 第2/3页各改首字母
  for (const pIdx of [2, 3]) {
    _log(`\n===== R4 第${pIdx}页 改一处 =====`);
    const segs = await buildSegForPage(doc, pIdx);
    const target = segs.find((s) => /[A-Za-z]/.test(s.text))!;
    const newText = "Z" + target.text.slice(1);
    const seg: Segment = { ...target, id: "seg_p" + pIdx, text: newText, originalText: target.text } as any;
    _log(`  target seg id=${target.id} 原="${target.text.slice(0,28)}" → 新="${newText.slice(0,28)}"`);
    const updated = applySegmentEditsToDocument(doc, [seg]) as EditableDocument;
    (updated as any).runtime = { renderScale: 1.5, cssScale: 1, pageMetrics: updated.pages.map((p: any) => ({ width: p.width, height: p.height })) };
    const out = await exportEditableDocument(updated, bytes as unknown as ArrayBuffer, undefined as any, undefined as any, undefined as any);
    const outPdf = await PDFDocument.load(out);
    const opsBefore = pageOps(pdf0, pIdx - 1), opsAfter = pageOps(outPdf, pIdx - 1);
    const entered = opsAfter.some((r) => (r.unicodeText ?? "").includes(newText.slice(0, 6)));
    const gA = graphicsCount(outPdf, pIdx - 1);
    _log(`  导出 page${pIdx - 1}: 算子 ${opsBefore.length}→${opsAfter.length}`);
    _log(`  新文字进入导出? ${entered}  (page ${pIdx} 编辑${entered ? "已落地" : "被丢弃!"})`);
    _log(`  graphics: base.total=${gBase[pIdx-1].total} → after.total=${gA.total} 一致? ${JSON.stringify(gA.counts)===JSON.stringify(gBase[pIdx-1].counts)}`);
  }
}
run().catch((e) => { _log("ERR", e); process.exit(1); });
