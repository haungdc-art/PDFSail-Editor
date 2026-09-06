/**
 * PdfImporter — Sprint39-M2B（Product Importer）
 *
 * 唯一的 PDF → EditableDocument 入口（Import 属于 Product）。
 *
 *   PDF
 *    ↓
 *   parsePdfToEditableDocument()
 *    ↓
 *   EditableDocument
 *    ↓
 *   （Editor 修改 / exportEditableDocument）
 *
 * 【架构收敛】
 *   - 这是真正的 Product API，不是 Testing Adapter。
 *   - Runner 只调 parsePdfToEditableDocument()（Import）+ exportEditableDocument()（Export）。
 *   - 所有 Feature（Edit Text / OCR / Signature / Annotation）共用此入口。
 *   - 不包含任何 Export 逻辑（Export 在 export-renderer.ts）。
 *
 * 实现复用：
 *   - TextExtractor.extractGlyphs       （pdf.js TextContent → RawGlyph[]）
 *   - SegmentBuilder.groupIntoLines     （RawGlyph[] → LineGroup[]）
 *   - CoordinateMapperImpl              （PDF pt → CSS px）
 *   - FontAnalyzerImpl                  （fontName → FontMeta）
 *   - pdfLinesToEditableBlock           （LineGroup[] → EditableBlock）
 *   - StyleResolver                     （跨页去重 + styleRef）
 */

import { getDocument, GlobalWorkerOptions, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import type { EditableDocument, EditablePage, EditableStyle, EditableBlock } from "./types";
import { StyleResolver } from "./style-resolver";
import { pdfLinesToEditableBlock } from "./pdf-native-adapter";
import { parsePdfFontMetrics } from "./pdf-font-metrics";
import { buildFontProvenanceMap } from "./pdf-font-provenance";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import { createPage } from "./dom/page-builder";
import { domPageToEditablePage } from "./dom/editable-page-compat";
import { extractImageRegions, extractTextItemRects, classifyLineRenderSources } from "./render-source-detector";
import type { ImageOpCodes } from "./render-source-detector";

// Node 环境：指定内置 worker 源，主线程 fake worker 解析（避免 DataCloneError）。
GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

// 标准 14 字体的 AFM 数据目录（消除 standardFontDataUrl 警告，正确解析标准字体）。
const STANDARD_FONT_DATA_URL = new URL(
  "../../../node_modules/pdfjs-dist/standard_fonts/",
  import.meta.url,
).href;

/** Import 配置 */
export interface PdfImporterOptions {
  /** pdf.js 渲染缩放（PDF pt → canvas px），默认 1.5（与 PDFEditor 一致） */
  viewportScale?: number;
  /** CSS 显示缩放（无 canvas 时取 1） */
  cssScale?: number;
}

/**
 * PDF → EditableDocument（Product Import 唯一入口）。
 *
 * @param bytes PDF 字节
 * @param fileName 文件名
 * @param options 可选配置
 */
export async function parsePdfToEditableDocument(
  bytes: Uint8Array,
  fileName = "document.pdf",
  options: PdfImporterOptions = {},
): Promise<EditableDocument> {
  const viewportScale = options.viewportScale ?? 1.5;
  const cssScale = options.cssScale ?? 1;

  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;

  // M7.5-002：并行用 pdf-lib 解析 PDF Font Dictionary，产出每页真实字体度量（pg 顺序与 pdfjs 一致）。
  // 失败不阻断导入：pageMetrics 为空 → adapter multi-char 回退 canvas 估算。
  let pageFontMetrics: ReturnType<typeof parsePdfFontMetrics> | undefined;
  let pdfLibDoc: PDFDocument | undefined;
  try {
    pdfLibDoc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, throwOnInvalidObject: false });
    if (process.env.MASK_DIAG === "1") console.error(`[DBG] pdf-lib loaded, bytes.byteLength=${(bytes as any).byteLength}, pages=${pdfLibDoc.getPageCount()}`);
    pageFontMetrics = parsePdfFontMetrics(pdfLibDoc);
  } catch (e) {
    if (process.env.MASK_DIAG === "1") console.error(`[DBG] pdf-lib load/metrics threw:`, (e as Error)?.message);
    pageFontMetrics = undefined;
    pdfLibDoc = undefined;
  }

  const pages: EditablePage[] = [];
  // 文档级样式 resolver（跨页去重）
  const docResolver = new StyleResolver();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: viewportScale });
    const viewportHeight = vp.height / viewportScale; // PDF pt 高度（未缩放）
    const viewportWidth = vp.width / viewportScale;   // PDF pt 宽度（未缩放）

    // M7.7-009A: 并行获取 textContent 和 operatorList（用于 render source 检测）
    const [tc, operatorListResult] = await Promise.all([
      page.getTextContent(),
      page.getOperatorList().catch(() => null as any),
    ]);

    // 无文本层 → 该页无 text block（扫描件由 OCR 处理）
    const glyphs = extractGlyphs(tc as Parameters<typeof extractGlyphs>[0]);
    const lines = groupIntoLines(glyphs);

    const mapper = new CoordinateMapperImpl({
      viewportScale,
      viewportHeight,
      viewportWidth,
      cssScale,
      // M7.8-014: CropBox 平移补偿
      originXDevice: vp.transform[4],
      originYDevice: vp.transform[5],
    });
    const fontAnalyzer = new FontAnalyzerImpl();

    // 页级样式 resolver（pdfLinesToEditableBlock 内部使用）
    const pageResolver = new StyleResolver();

    // M7.8-035-B：构建 pdf.js loadedName → PDF resource 的可靠溯源（Type3 等无字节字体）
    // M7.8-035-FIX：不再以 pageFontMetrics 存在为前提 —— provenance 直接从原 PDF
    // object graph 判定字体，恰恰是 pageMetrics 缺失（字体在 Form XObject 里）时才最需要它。
    let provenance: Awaited<ReturnType<typeof buildFontProvenanceMap>> | undefined;
    try {
      if (pdfLibDoc) {
        provenance = await buildFontProvenanceMap(pdfLibDoc, pdf, p - 1);
      }
    } catch {
      provenance = undefined;
    }

    const block = pdfLinesToEditableBlock(
      lines,
      mapper,
      fontAnalyzer,
      `pdf_p${p}_block0`,
      pageResolver,
      pageFontMetrics?.[p - 1],
      provenance,
    );

    // M7.7-009A-1: Render Source Detection（行级 source 分类）
    if (operatorListResult && operatorListResult.fnArray && operatorListResult.fnArray.length > 0) {
      try {
        const imageRegions = extractImageRegions(
          operatorListResult,
          OPS as unknown as ImageOpCodes,
          mapper,
        );
        const textItemRects = extractTextItemRects(
          tc.items as Array<{ transform: number[]; width: number; height: number; str: string }>,
          mapper,
        );
        classifyLineRenderSources(block.lines, imageRegions, textItemRects);
      } catch {
        // 检测失败不阻断导入，保持缺省 "vector"
      }
    }

    // 把本页样式合并进 docResolver，并重映射 styleRef 偏移
    const styleOffset = docResolver.size;
    for (const style of pageResolver.toArray()) {
      docResolver.register(style);
    }
    if (styleOffset > 0) {
      remapStyleRefs(block, styleOffset);
    }

    // Phase 2 Task-2（Builder Integration）：Builder 以 Page 为唯一生产模型，
    // EditablePage 通过 Compatibility Adapter 产出（domPageToEditablePage 是唯一兼容出口）。
    // 等价性由 Builder Equivalence Golden Test 保证（旧链 == 新链，Consumer 零改动）。
    const blocks: EditableBlock[] = block.lines.length > 0 ? [block] : [];
    const domPage = createPage({
      metadata: { index: p, width: vp.width * cssScale, height: vp.height * cssScale },
      blocks,
    });
    const editablePage = domPageToEditablePage(domPage, blocks);
    // M7.8-035-FIX-4：记录 MediaBox 下边界（y0）。CSS 原点在 y1，导出翻转基准 = height + y0。
    editablePage.originYPt = (page.view as number[])?.[1] ?? 0;
    pages.push(editablePage);
  }

  await pdf.destroy();

  const doc: EditableDocument = {
    pages,
    styles: docResolver.toArray(),
    metadata: {
      fileName,
      pageCount: pages.length,
      createdAt: Date.now(),
    },
    // Sprint39-M2C：Runtime 归独立对象，由 Import 补齐，Export 读取
    runtime: {
      renderScale: viewportScale,
      cssScale,
      pageMetrics: pages.map((p) => ({ width: p.width, height: p.height })),
    },
  };

  // M7.8-036-FIX-002：导入期建立 Original Operator Provenance（glyph → operatorId + charIndex）。
  // 失败闭环：无法权威对齐时 glyph 字段留空，导出时绝不删除，宁可保留原文。
  await assignOperatorProvenance(doc, pdfLibDoc);

  return doc;
}

/**
 * M7.8-036-FIX-002 · Original Operator Provenance 建立（内容身份对齐）。
 *
 * 机制：**不**用 showText 算子的字符顺序去对齐 glyph（doc glyph 按 Y 排序的 block/line 顺序
 * ≠ content stream 物理顺序，顺序对齐会在任意发散点整体失配）。改为：
 *   1. 把本页所有 glyph.char 拼接成一条长文本 G（索引 i ↔ glyphs[i]，每个 glyph 一个字符）；
 *   2. 对每个可权威解码（charCodes !== null）且带 /ToUnicode（unicodeText 非空）的 showText 算子，
 *      取其整段真实文本 unicodeText，在 G 中按**文本内容**精确匹配（indexOf）定位对应 glyph 区间，
 *      把该算子的 operatorId 钉死到这些 glyph（operatorCharIndex = 区间内偏移）。
 * 导出期 stripReplacedTextOperators 只消费 operatorId（整 operator 剥离），不依赖任何字符级顺序。
 *
 * 安全闭环：
 *   - 命中即正确：匹配要求逐字精确命中且不与已占用区间重叠，绝不会把 A 算子的文本错配到 B 的 glyph。
 *   - 唯一失败模式 = 该算子文本在 G 中找不到（多因 pdf.js 丢弃对应 glyph）→ 该算子不建 provenance。
 *   - 任一情况 → 相关 glyph.operatorId 留空（UNKNOWN），导出时绝不删除该算子，宁可保留原文也不误删：
 *       · pdfLibDoc 缺失
 *       · 算子无法权威解码（charCodes === null，如 Type0 变长 CMap / 字体资源缺失）
 *       · 算子无 /ToUnicode（unicodeText 缺失，无法做文本身份锚定）
 *       · 整页命中率 < 50%（编码/对齐整体不可信，fail-closed 整页放弃）
 */
async function assignOperatorProvenance(
  doc: EditableDocument,
  pdfLibDoc: PDFDocument | undefined,
): Promise<void> {
  if (!pdfLibDoc) { if (process.env.MASK_DIAG === "1") console.error("[FIX-002-DBG] pdfLibDoc undefined → provenance skipped"); return; }
  for (let p = 0; p < doc.pages.length; p++) {
    await assignOperatorProvenanceForPage(doc.pages[p], pdfLibDoc, p);
  }
}

/**
 * M7.8-042-FIX · 页级 Original Operator Provenance 建立（导出给应用内联构建路径使用）。
 *
 * 背景：应用（PDFEditor.tsx）不经过 parsePdfToEditableDocument，而是 pdfjs getTextContent →
 * pdfLinesToEditableBlock 内联构建 EditableDocument —— 此前该路径从不建立 glyph.operatorId，
 * 导致导出期 stripReplacedTextOperators 收集不到原算子，只能靠文本兜底剥离；
 * 兜底对「非连续算子行」（表格行文字在内容流中与其它行交错）必然失配（idx=-1）→
 * 原文残留 + 新文字叠加 = 重影。
 *
 * @param page 新构建的页（blocks 含 glyph；可为独立对象，函数只改 glyph 字段）
 * @param pdfLibDoc pdf-lib 文档（提供内容流 / ToUnicode 解码）
 * @param pdfLibPageIndex 0-based pdf-lib 页索引（pdf.js 1-based 页码 - 1）
 */
export async function assignOperatorProvenanceForPage(
  page: Pick<EditablePage, "blocks">,
  pdfLibDoc: PDFDocument | undefined,
  pdfLibPageIndex: number,
): Promise<void> {
  if (!pdfLibDoc) { if (process.env.MASK_DIAG === "1") console.error("[FIX-002-DBG] pdfLibDoc undefined → provenance skipped"); return; }
  const p = pdfLibPageIndex;
  let records: ReturnType<typeof resolvePageShowTextWithXObjects>;
  try {
    records = resolvePageShowTextWithXObjects(pdfLibDoc, p);
  } catch (e) {
    if (process.env.MASK_DIAG === "1") console.error(`[FIX-002-DBG] page ${p} resolve threw:`, (e as Error).message);
    return;
  }
  // 收集本页 glyph（文档顺序：block → line → glyph），每个 glyph 单一字符。
  const glyphs: EditableGlyph[] = [];
  for (const block of page.blocks) {
    for (const line of block.lines) {
      for (const g of line.glyphs) glyphs.push(g);
    }
  }
  if (glyphs.length === 0) { if (process.env.MASK_DIAG === "1") console.error(`[FIX-002-DBG] page ${p} has 0 doc glyphs (records=${records.length})`); return; }

  // M7.8-036-FIX-002 · 内容身份对齐（content-identity alignment）。
  // doc glyph 顺序（按 Y 排序的 block/line）≠ content stream 物理顺序，
  // 因此**不能**用顺序对齐——顺序对齐会在任意顺序发散点整体失配，导致整页 provenance 被
  // fail-closed 清空（见诊断 _diag_ytrace_11：char 36 处 "TÍTULOSRef." vs "TÍTULOSSoli" 即发散）。
  //
  // 改为：对每个 showText 算子取其 unicodeText（由 /ToUnicode 解出的真实文本，整段锚点），
  // 在 glyph 长文本中按**文本内容**匹配（indexOf）定位该算子对应的 glyph 区间，把 operatorId 钉死过去。
  // 导出时 stripReplacedTextOperators 只消费 operatorId（整 operator 剥离），不依赖任何字符级顺序。
  //
  // M7.8-042-ALIGN-BAND（关键修正）：纯文本全页匹配对「重复文本」是歧义的 —— 表格 PDF 每行都有
  // "power"/"100%"/"passes"，第 N 行的算子会匹配到第 M 行的 glyph 区间 → 编辑行 strip 时
  // 误删**其它行**的算子（未编辑行文字缺损 "48 mm/min"/"ass s"），而真正该删的算子残留成重影。
  // 现按 **baseline 带**约束匹配：resolver 为每个算子记录 textY（原始用户空间 baseline），
  // glyph 的 metrics.pdfTransform[5] 是 pdf.js 视口 baseline，两者满足 textY ≈ cropTopY - pdfjsY。
  // 算子只允许匹配**同 baseline 带**内的 glyph（带内歧义无害 —— 同一行的重复词怎么配，
  // strip 都只删本行算子、整行重绘）；无 textY 的算子（畸形流）退回全页匹配（仅认领未占用区间）。
  //
  // 安全闭环不变：命中即正确（逐字精确 + 不与已占用区间重叠）；失败模式 = 不建 provenance
  // （fail-safe，宁可保留原文重影也不误删）。
  let cropTopY: number | undefined;
  try {
    const pg = pdfLibDoc.getPage(p);
    const cb = typeof pg.getCropBox === "function" ? pg.getCropBox() : undefined;
    cropTopY = cb && cb.height > 0 ? cb.y + cb.height : pg.getHeight();
  } catch {
    cropTopY = undefined;
  }
  const BAND_TOL = 2.5; // pt；行内 baseline 抖动容忍（远小于最小行距）

  // glyph 按 pdf.js baseline 分带（无位置数据的 glyph 不属于任何带 → 不会被带内算子认领）
  const bandReps: number[] = []; // 每带的代表 pdfjsY
  const bandGlyphIdx: number[][] = [];
  for (let i = 0; i < glyphs.length; i++) {
    const gy = (glyphs[i] as unknown as { metrics?: { pdfTransform?: number[] } }).metrics?.pdfTransform?.[5];
    if (typeof gy !== "number" || !Number.isFinite(gy)) continue;
    let b = bandReps.findIndex((y) => Math.abs(y - gy) <= BAND_TOL);
    if (b < 0) {
      bandReps.push(gy);
      bandGlyphIdx.push([]);
      b = bandReps.length - 1;
    }
    bandGlyphIdx[b].push(i);
  }

  const claimed = new Array<boolean>(glyphs.length).fill(false);
  let matchedGlyphs = 0;

  /** 在 glyph 索引区间（band 内或全页）里按文本匹配并认领 */
  const claimIn = (idxs: number[], U: string, r: { operatorId: string }): boolean => {
    const G = idxs.map((i) => glyphs[i].char ?? "").join("");
    let j = G.indexOf(U, 0);
    while (j >= 0) {
      const end = j + U.length;
      let overlap = false;
      for (let k = j; k < end; k++) {
        if (claimed[idxs[k]]) { overlap = true; break; }
      }
      if (!overlap) {
        for (let k = j; k < end; k++) {
          glyphs[idxs[k]].operatorId = r.operatorId;
          glyphs[idxs[k]].operatorCharIndex = k - j;
          claimed[idxs[k]] = true;
        }
        return true;
      }
      j = G.indexOf(U, j + 1);
    }
    return false;
  };

  // 长文本优先匹配，避免短词（如 "de"）被更长算子文本（如 "devedocument..."）抢注后长串失配。
  const ops = records
    .filter((r) => r.charCodes !== null && !!r.unicodeText && r.unicodeText.length > 0)
    .sort((a, b) => b.unicodeText!.length - a.unicodeText!.length);

  for (const r of ops) {
    const U = r.unicodeText!;
    // 算子的 pdf.js 视口 baseline（textY 原始用户空间 → 视口向下坐标）
    const oy =
      typeof r.textY === "number" && Number.isFinite(r.textY) && cropTopY !== undefined
        ? cropTopY - r.textY
        : undefined;
    if (oy !== undefined) {
      // 带内匹配：只允许认领同 baseline 带的 glyph；带内失配 → 不建 provenance（绝不跨行乱认领）。
      let b = bandReps.findIndex((y) => Math.abs(y - oy) <= BAND_TOL);
      if (b < 0) continue; // 该算子的行在 doc 中无对应 glyph 带（pdf.js 丢弃）→ fail-safe 跳过
      if (claimIn(bandGlyphIdx[b], U, r)) matchedGlyphs += U.length;
    } else {
      // 无位置数据（畸形流）：退回全页匹配（M7.8-036 原行为，仅认领未占用区间）。
      const all = glyphs.map((_, i) => i);
      if (claimIn(all, U, r)) matchedGlyphs += U.length;
    }
    // 未命中：该算子不建 provenance（fail-safe，见上方注释）。
  }

    // fail-closed：若整体命中率极低（编码/对齐整体不可信），整页放弃 provenance，
    // 宁可全部保留原文也不在可疑位置删除。
    const coverage = glyphs.length ? matchedGlyphs / glyphs.length : 0;
    if (coverage < 0.5) {
      for (const g of glyphs) {
        g.operatorId = undefined;
        g.operatorCharIndex = undefined;
      }
    }
    if (process.env.MASK_DIAG === "1") {
      console.log(
        `[FIX-002] 页 ${p} provenance: ${matchedGlyphs}/${glyphs.length} glyphs, ` +
          `${ops.length} 候选算子, coverage=${(coverage * 100).toFixed(1)}%`,
      );
      if (ops.length === 0) {
        const withCodes = records.filter((r) => r.charCodes !== null).length;
        const withUni = records.filter((r) => !!r.unicodeText).length;
        console.error(`[FIX-002-DBG] page ${p}: records=${records.length} withCodes=${withCodes} withUni=${withUni}`);
      }
    }
}

/** EditableGlyph 类型（供 assignOperatorProvenance 内部使用） */
type EditableGlyph = import("./types").EditableGlyph;

/** 跨页合并后，把 block 内 glyph 的 styleRef 加上偏移（因 docResolver 索引前移） */
function remapStyleRefs(
  block: { lines: { glyphs: { styleRef: number }[] }[] },
  offset: number,
): void {
  for (const line of block.lines) {
    for (const glyph of line.glyphs) {
      glyph.styleRef += offset;
    }
  }
}

/** 提取 EditableDocument 的样式表（便捷工具） */
export function stylesOf(doc: EditableDocument): EditableStyle[] {
  return doc.styles;
}
