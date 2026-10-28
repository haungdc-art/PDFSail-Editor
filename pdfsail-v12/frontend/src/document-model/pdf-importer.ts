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
import { computeOperatorProvenance, type GlyphProvenance, type GlyphProvenanceInput } from "../editor/binding/operator-provenance";
import { createPage } from "./dom/page-builder";
import { domPageToEditablePage } from "./dom/editable-page-compat";
import { extractImageRegions, extractTextItemRects, classifyLineRenderSources } from "./render-source-detector";
import type { ImageOpCodes } from "./render-source-detector";

// Node 环境默认：指定内置 worker 源，主线程 fake worker 解析（避免 DataCloneError）。
//
// ⚠️ 这条路径是 `node_modules` 相对 URL，**只在 Node 下成立**。
// 浏览器/扩展等打包消费者不会托管 node_modules ⇒ 必须用下面的 setter
// 显式注入自己的 worker 资源 URL（Vite 用 `?url` 资源导入，如 src/pdfjs-worker-src.ts）。
let workerSrcOverride: string | null = null;

function defaultWorkerSrc(): string {
  return new URL(
    "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    import.meta.url,
  ).href;
}

/**
 * 覆盖 importer 使用的 pdf.js worker 源。
 * 打包环境（浏览器 / Chrome 扩展 / 其它 Vite 应用）在调用 parsePdfToEditableDocument 之前调用它。
 */
export function setPdfImporterWorkerSrc(url: string): void {
  workerSrcOverride = url;
  GlobalWorkerOptions.workerSrc = url;
}

/** 当前生效的 worker 源（诊断用） */
export function getPdfImporterWorkerSrc(): string {
  return workerSrcOverride ?? defaultWorkerSrc();
}

GlobalWorkerOptions.workerSrc = getPdfImporterWorkerSrc();

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
    pageFontMetrics = parsePdfFontMetrics(pdfLibDoc);
  } catch {
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


/**
 * F3B-6.17-3C-6B1.1-P1-C · Legacy adapter = compute → apply。
 *
 * 「计算」全部委托给纯函数 `computeOperatorProvenance`（唯一 provenance 计算入口，
 * 见 `editor/binding/operator-provenance.ts`）；本函数只负责把结果**写回** legacy glyph，
 * 不再持有任何匹配算法。行为与原 inline 算法等价：
 *   · resolvePageShowTextWithXObjects 抛错 → 整页 UNKNOWN（清空 operatorId，fail-closed）
 *   · coverage < 0.5 → 整页 UNKNOWN（清空 operatorId）
 *   · 否则逐 glyph 写回 matched operatorId / operatorCharIndex
 */
async function assignOperatorProvenance(
  doc: EditableDocument,
  pdfLibDoc: PDFDocument | undefined,
): Promise<void> {
  if (!pdfLibDoc) return;
  for (let p = 0; p < doc.pages.length; p++) {
    const page = doc.pages[p];
    // 收集本页 glyph（文档顺序：block → line → glyph），每个 glyph 单一字符。
    const glyphs: EditableGlyph[] = [];
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const g of line.glyphs) glyphs.push(g);
      }
    }
    if (glyphs.length === 0) continue;

    // 扁平行输入（仅提供算法所需的 char + pdfTransform，不暴露整个 glyph 对象）。
    const pageGlyphs: GlyphProvenanceInput[] = glyphs.map((g) => ({
      char: g.char,
      pdfTransform: g.metrics?.pdfTransform,
    }));

    let provenance: GlyphProvenance[] | null;
    try {
      provenance = computeOperatorProvenance(pdfLibDoc, p, pageGlyphs);
    } catch (error) {
      // F3B-6.17-3C-6B1.1-P1-A：resolvePageShowTextWithXObjects 抛错 → fail-closed（整页 UNKNOWN）。
      // 异常不再静默吞掉：provenance 置 null ⇒ 下方整页清空 operatorId，导出时绝不删除原文。
      provenance = null;
    }

    if (provenance === null) {
      // fail-closed：整页 UNKNOWN（resolve 抛错或 coverage < 0.5）→ 清空，导出时绝不删除原文。
      for (const g of glyphs) {
        g.operatorId = undefined;
        g.operatorCharIndex = undefined;
      }
      continue;
    }

    for (let k = 0; k < glyphs.length; k++) {
      const pv = provenance[k];
      glyphs[k].operatorId = pv?.operatorId;
      glyphs[k].operatorCharIndex = pv?.operatorCharIndex;
    }
    if (process.env.MASK_DIAG === "1") {
      const matched = provenance.filter((pv) => pv.operatorId !== undefined).length;
      const coverage = matched / glyphs.length;
      console.log(
        `[FIX-002] 页 ${p} provenance: ${matched}/${glyphs.length} glyphs, ` +
          `coverage=${(coverage * 100).toFixed(1)}%`,
      );
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
