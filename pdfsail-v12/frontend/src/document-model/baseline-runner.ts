/**
 * BaselineRunner — Sprint39-M1（让任何 PDF 自动跑完整闭环）
 *
 * 目标：任何一个带文本层的 PDF，都能自动完成：
 *   Open → Export → Comparator → Difference Report → Benchmark 指标 + Top Problems
 *
 * 这是采集编排层，复用已有工具，不开发新基础设施：
 *   - FidelityComparator（Sprint39-1 已建）
 *   - FidelityBenchmark（DoD 指标 + 排行榜）
 *
 * 【Sprint39-M1 交付标准】
 *   1 个 PDF 能自动跑完整闭环，输出：
 *     Text / Font / Coordinate / Missing 指标 + Top Problems 排行榜。
 *
 * 【Sprint39-M2】Runner 不允许实现 Product Logic。
 *   - Import 属于 Product（pdf-importer.ts 的 parsePdfToEditableDocument）。
 *   - Export 属于 Product（export-renderer.ts 的 exportEditableDocument）。
 *   - Runner 只调两个真正的 Product API，不实现任何 Import/Export。
 *   - 本文件不包含任何 PDF 导入/导出实现。
 *
 * 【纪律】Pure + Deterministic。只读输入，不修改输入。
 */

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createFidelityComparator, type FidelityTextItem, type DifferenceReport } from "./fidelity-comparator";
import { DefaultFidelityBenchmarkBuilder, type FidelityBenchmarkResult } from "./fidelity-benchmark";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument } from "./export-renderer";

// Node 环境：指定内置 worker 源，pdf.js 用主线程 fake worker 解析，
// 避免 worker 线程间 structuredClone 传输（DataCloneError）。
GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

// 标准 14 字体的 AFM 数据目录（消除 standardFontDataUrl 警告，正确解析标准字体）。
const STANDARD_FONT_DATA_URL = new URL(
  "../../../node_modules/pdfjs-dist/standard_fonts/",
  import.meta.url,
).href;

/** 提取 PDF 文本为可比较快照 */
export async function extractPdfText(pdfBytes: Uint8Array): Promise<{
  items: FidelityTextItem[];
  pages: FidelityTextItem[][];
  pageSizes: { width: number; height: number }[];
}> {
  const pdf = await getDocument({
    data: new Uint8Array(pdfBytes),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pageArrays: FidelityTextItem[][] = [];
  const pageSizes: { width: number; height: number }[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { width, height } = page.getViewport({ scale: 1 });
    pageSizes.push({ width, height });
    const content = await page.getTextContent();
    // styles: fontName → { fontFamily }（pdf.js 解析出的真实可读字体名）
    const styles = (content.styles ?? {}) as Record<
      string,
      { fontFamily?: string; fontWeight?: string; ascent?: number }
    >;
    const pageItems: FidelityTextItem[] = [];
    for (const it of content.items as Array<{
      str?: string;
      transform?: number[];
      fontName?: string;
      width?: number;
      height?: number;
    }>) {
      if (!it.str) continue;
      const x = it.transform?.[4] ?? 0;
      const y = it.transform?.[5] ?? 0;
      const fontSize = it.transform?.[0] ?? 0;
      // 用 styles 映射真实字体名（如 "Helvetica"），而非内置名（如 "g_d0_f1"），
      // 避免 Comparator 对同一字体误报差异。
      const family = it.fontName ? styles[it.fontName]?.fontFamily : undefined;
      pageItems.push({
        text: it.str,
        x,
        y,
        fontSize,
        fontFamily: family || it.fontName,
      });
    }
    pageArrays.push(pageItems);
  }
  await pdf.destroy();
  return { items: pageArrays.flat(), pages: pageArrays, pageSizes };
}

/** 一次 Baseline 运行的完整结果 */
export interface BaselineRunResult {
  /** 参与比较的原始项数 */
  originalItemCount: number;
  /** Difference Report */
  report: DifferenceReport;
  /** Benchmark 指标 + Top Problems */
  benchmark: FidelityBenchmarkResult;
}

/** Runner 配置 */
export interface BaselineRunnerOptions {
  /** 坐标容差（pt） */
  coordinateTolerance?: number;
}

/**
 * Baseline Runner —— 任何 PDF → Product Import → Product Export → Compare → Report。
 *
 * Runner 只调两个真正的 Product API，不实现任何 Import/Export：
 *   1. parsePdfToEditableDocument（pdf-importer.ts，Product Import）
 *   2. exportEditableDocument（export-renderer.ts，Product Export）
 */
export async function runBaseline(
  originalBytes: Uint8Array,
  options: BaselineRunnerOptions = {},
): Promise<BaselineRunResult> {
  const tol = options.coordinateTolerance ?? 1.0;

  // 1. Product Import：PDF → EditableDocument
  const doc = await parsePdfToEditableDocument(originalBytes, "baseline.pdf");

  // 2. Product Export：EditableDocument → PDF（未编辑，原样导出）
  //    ctx 由 Export 自己从 doc.metadata 读取，Runner 不构造 ctx。
  const exportBytes = await exportEditableDocument(doc, originalBytes.buffer);

  // 3. Extract Original + Export 文本快照（Comparator 输入准备，非 Product Export）
  const original = await extractPdfText(originalBytes);
  const exported = await extractPdfText(exportBytes);

  // 4. Comparator
  const comparator = createFidelityComparator({ coordinateTolerance: tol });
  const report = comparator.compare(original.pages, exported.pages);

  // 5. Benchmark
  const benchmark = DefaultFidelityBenchmarkBuilder.build([report]);

  return {
    originalItemCount: original.items.length,
    report,
    benchmark,
  };
}
