import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const out: string[] = [];
const log = (...a: any[]) => { out.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
const SUPPRESS = /\[009B|NATIVE|EXPORT_PATH|M7\.8|\[MASK_DIAG|YDIAG|Sprint34|SignatureRotation|ExportLayout|GLYPH_GEOMETRY|M7\.7-010\]/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) console.error(...a); };

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

async function buildPageDoc(pdf0: PDFDocument, pageIdx1: number) {
  const { tc, vp } = await getTextContent(pageIdx1);
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
  return buildSegments(lines, mapper, new FontAnalyzerImpl(), pageIdx1, undefined) as Segment[];
}

async function buildEditSeg(doc: EditableDocument, pageIdx0: number, originalSub: string, newText: string) {
  const segs = await buildPageDoc(await PDFDocument.load(fs.readFileSync(ORIG)), pageIdx0 + 1);
  const seg = segs.find((s) => s.text.includes(originalSub));
  if (!seg) throw new Error(`page${pageIdx0 + 1} 找不到包含 "${originalSub}" 的 segment`);
  const lineText = doc.pages[pageIdx0].blocks[0].lines.find((l) => l.glyphs.map(g => g.char).join("").includes(originalSub))!.glyphs.map(g => g.char).join("");
  const s = lineText.indexOf(originalSub);
  const src = (seg as any).source;
  return { seg, src, startGlyphIndex: s, endGlyphIndex: s + originalSub.length - 1 };
}

function lineEditedTrigger(doc: EditableDocument, pageIdx0: number, lineId: string) {
  const line = doc.pages[pageIdx0].blocks.flatMap(b => b.lines).find(l => l.id === lineId);
  if (!line) return "LINE_NOT_FOUND";
  const anyModified = line.glyphs.some(g => (g as any).modified);
  const origText = line.glyphs.map(g => (g as any).originalChar ?? g.char).join("");
  const curText = line.glyphs.map(g => g.char).join("");
  const textDiff = origText !== curText;
  // export 当前触发逻辑
  const exportTrigger = anyModified;
  // 建议的 line-level 触发逻辑
  const lineLevelTrigger = anyModified || textDiff;
  return { anyModified, textDiff, exportTrigger, lineLevelTrigger, origText, curText };
}

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;

  // ═══════════════ D1 + D2：第 1 页 CNPJ 行（operator 含多字符："0001-79, com sede ..."）═══════════════
  log("════════ D1+D2：第1页 CNPJ 行（整 operator = 整行文本，跨多 glyph）════════");
  const cnpjLine = doc.pages[0].blocks[0].lines.find((l) => l.glyphs.map(g => g.char).join("").includes("0001-79"))!;
  const cnpjText = cnpjLine.glyphs.map(g => g.char).join("");
  const cnpjLineId = cnpjLine.id;
  log(`[导入] 行="${cnpjLineId}" text="${cnpjText}"`);
  log(`[导入] 各 glyph: ` + cnpjLine.glyphs.map((g, i) => `${i}:'${g.char}'(op=${g.operatorId},oci=${g.operatorCharIndex})`).join(" "));

  const cases: { name: string; origSub: string; newText: string }[] = [
    { name: "R1 79→78  (替换)", origSub: "79", newText: "78" },
    { name: "R2 79→7   (删1)", origSub: "79", newText: "7" },
    { name: "R3 79→79123(插入)", origSub: "79", newText: "79123" },
    { name: "D2 79→''  (删整段)", origSub: "79", newText: "" },
  ];
  for (const c of cases) {
    const { src, startGlyphIndex, endGlyphIndex } = await buildEditSeg(doc, 0, c.origSub, c.newText);
    const seg: Segment = { ...(await buildPageDoc(pdf0, 1)).find(s => s.text.includes(c.origSub))!, id: "seg", text: c.newText, originalText: c.origSub,
      source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex, endGlyphIndex } } as any;
    const updated = applySegmentEditsToDocument(doc, [seg]) as EditableDocument;
    const line = updated.pages[0].blocks.flatMap(b => b.lines).find(l => l.id === cnpjLineId)!;
    const newText = line.glyphs.map(g => g.char).join("");
    const glyphInfo = line.glyphs.map((g, i) => `${i}:'${g.char}'(mod=${g.modified ? 1 : 0},op=${g.operatorId ?? "-"})`).join(" ");
    const trig = lineEditedTrigger(updated, 0, cnpjLineId);
    const opIds = new Set<string>();
    for (const g of line.glyphs) if ((g as any).modified && g.operatorId) opIds.add(g.operatorId as string);
    log(`\n[${c.name}] seg.source={blockId=${src.blockId}, lineId=${src.lineId}, sgi=${startGlyphIndex}, egi=${endGlyphIndex}}`);
    log(`  [Mutation] 新行 text="${newText}" (原="${cnpjText.includes(c.origSub) ? cnpjText.slice(cnpjText.indexOf(c.origSub), cnpjText.indexOf(c.origSub) + c.origSub.length) : ""}")`);
    log(`  [Mutation] glyphs: ${glyphInfo}`);
    log(`  [触发] anyModified=${trig.anyModified} textDiff=${trig.textDiff} → 当前export触发=${trig.exportTrigger} / 建议lineLevel=${trig.lineLevelTrigger}`);
    log(`  [Strip收集] modified&&operatorId 的 opIds=${[...opIds].join(",") || "(空)→0剥离"}`);
    log(`  [Overlay] 该行 glyph 总数=${line.glyphs.length}（整行重绘，含未修改字符）→ 未修改字符由整行overlay重绘 ✓`);
  }

  // ═══════════════ D3：第 2 页 修改 segment 的 source → live doc 绑定 ═══════════
  log("\n════════ D3：第2页 修改 segment 的 source → live doc 绑定 ════════");
  const page2Segs = await buildPageDoc(pdf0, 2);
  // 选第2页第一个含字母的 segment 作为编辑目标
  const target2 = page2Segs.find(s => /[A-Za-z]/.test(s.text) && s.text.length >= 4);
  if (target2) {
    const src2 = (target2 as any).source;
    log(`[Seg.source] blockId=${src2.blockId} lineId=${src2.lineId} startGlyphIndex=${src2.startGlyphIndex} endGlyphIndex=${src2.endGlyphIndex} text="${target2.text}"`);
    // live doc 的真实 block/line/glyph range
    const liveBlock = doc.pages[1].blocks.find(b => b.id === src2.blockId);
    const liveLine = liveBlock?.lines.find(l => l.id === src2.lineId);
    log(`[live block] id=${liveBlock?.id ?? "NOT_FOUND"}`);
    log(`[live line]  id=${liveLine?.id ?? "NOT_FOUND"} glyph数=${liveLine?.glyphs.length ?? "-"}`);
    if (liveLine) {
      const liveRange = liveLine.glyphs.slice(src2.startGlyphIndex, src2.endGlyphIndex + 1).map(g => g.char).join("");
      log(`[live glyph range] [${src2.startGlyphIndex}..${src2.endGlyphIndex}] = "${liveRange}"  (seg.text="${target2.text}")`);
      log(`[绑定一致?] blockId=${liveBlock?.id === src2.blockId} lineId=${liveLine?.id === src2.lineId} 区间文本匹配=${liveRange === target2.text}`);
    }
    // 构造编辑并应用
    const newText2 = target2.text.length > 2 ? target2.text.slice(0, 2) + "ZZ" + target2.text.slice(2) : target2.text + "ZZ";
    const seg2: Segment = { ...target2, id: "seg2", text: newText2, originalText: target2.text,
      source: { blockId: src2.blockId, lineId: src2.lineId, startGlyphIndex: src2.startGlyphIndex, endGlyphIndex: src2.endGlyphIndex } } as any;
    const updated2 = applySegmentEditsToDocument(doc, [seg2]) as EditableDocument;
    const line2 = updated2.pages[1].blocks.flatMap(b => b.lines).find(l => l.id === src2.lineId);
    if (line2) {
      const trig2 = lineEditedTrigger(updated2, 1, src2.lineId);
      const opIds2 = new Set<string>();
      for (const g of line2.glyphs) if ((g as any).modified && g.operatorId) opIds2.add(g.operatorId as string);
      log(`[应用后] 新行 text="${line2.glyphs.map(g => g.char).join("")}"`);
      log(`[应用后] anyModified=${trig2.anyModified} textDiff=${trig2.textDiff} export触发=${trig2.exportTrigger}`);
      log(`[应用后] strip opIds=${[...opIds2].join(",") || "(空)"}`);
    } else {
      log(`[应用后] line 未找到（findLineBySource 失败）→ 修改未进入 doc`);
    }
  } else {
    log("[D3] 第2页无合适 segment");
  }

  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_d1d2d3.txt", out.join("\n"), "utf8");
  console.error("DONE -> _d1d2d3.txt");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
