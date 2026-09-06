/**
 * FidelityComparator — Sprint39A-1（PDF Fidelity 比较）
 *
 * 唯一目标：自动回答"原 PDF vs 导出 PDF 到底有哪些差异"。
 *
 *   Original PDF ─┐
 *                 ├─ FidelityComparator
 *   Export PDF  ──┘
 *                 └─ DifferenceReport
 *
 * 输出 DifferenceReport（结构化、可序列化），作为 Evidence 的来源。
 *
 * 比较维度（对齐最终验收标准）：
 *   - Text        ：文本内容一致性
 *   - Font        ：字体（family/size）一致性
 *   - Coordinate  ：坐标（x/y）一致性
 *   - Missing     ：缺失元素（原 PDF 有、导出 PDF 无）
 *   - Overall     ：文档总保真度
 *
 * 【范围】文本级 + 几何级比较（原 PDF / 导出 PDF 均可用 pdf.js getTextContent 提取）。
 *   像素级（渲染位图）比较留作未来扩展，不影响文本/字体/坐标/缺失维度。
 *
 * 【纪律】Pure + Deterministic。同输入 → 同输出。不修改输入。
 *   - 输入：两个可比较快照（原 PDF 侧 / 导出 PDF 侧），已统一到同一坐标空间。
 */

/**
 * 可比较的文本单元（原 PDF 或导出 PDF 提取的统一快照）。
 *
 * 调用方负责把各自坐标统一到同一空间（如 PDF pt）。
 */
export interface FidelityTextItem {
  /** 文本 */
  text: string;
  /** x 坐标（统一空间） */
  x: number;
  /** y 坐标（统一空间） */
  y: number;
  /** 字体大小 */
  fontSize: number;
  /** 字体族（可选） */
  fontFamily?: string;
}

/** 单页 Fidelity 比较结果 */
export interface PageFidelityResult {
  /** 页码（1-based） */
  page: number;
  /** 文本一致率 0-1（完全一致 = 1） */
  textAccuracy: number;
  /** 字体一致率 0-1 */
  fontAccuracy: number;
  /** 坐标一致率 0-1（坐标容差内算一致） */
  coordinateAccuracy: number;
  /** 缺失元素数 */
  missingCount: number;
  /** 该页是否通过（总一致率 >= threshold） */
  pass: boolean;
}

/** 单个差异条目（可定位到页/元素） */
export interface FidelityMismatch {
  /** 页码（1-based） */
  page: number;
  /** 维度：text / font / coordinate / missing */
  dimension: "text" | "font" | "coordinate" | "missing";
  /** 原 PDF 侧文本 */
  expectedText: string;
  /** 导出 PDF 侧文本（缺失时为空） */
  actualText: string;
  /** 原 PDF 侧字体 */
  expectedFont: string;
  /** 导出 PDF 侧字体（缺失时为空） */
  actualFont: string;
  /** 坐标差异描述（如 "dx: 0.8pt"） */
  coordinateDelta?: string;
}

/**
 * Difference Report — 原 PDF vs 导出 PDF 的结构化差异报告。
 */
export interface DifferenceReport {
  /** 是否整体一致 */
  overall: boolean;
  /** 总体保真度 0-1 */
  overallFidelity: number;
  /** 原 PDF 文本项数 */
  originalItemCount: number;
  /** 导出 PDF 文本项数 */
  exportedItemCount: number;
  /** 缺失元素数 */
  missingCount: number;
  /** 逐页结果 */
  pages: PageFidelityResult[];
  /** 差异条目（供 Evidence/Replay 定位） */
  mismatches: FidelityMismatch[];
  /** 阈值（坐标容差，pt） */
  threshold: number;
  /** 生成时间（调用方打上，Comparator 不生成） */
  generatedAt?: string;
}

/** Comparator 配置 */
export interface FidelityComparatorOptions {
  /** 坐标容差（pt），默认 1.0 */
  coordinateTolerance?: number;
  /** 单页总一致率阈值，低于则 pass=false，默认 0.95 */
  pagePassThreshold?: number;
  /** 最大 mismatches 条数（防报告过大），默认 200 */
  maxMismatches?: number;
}

/**
 * Fidelity Comparator 契约。
 */
export interface FidelityComparator {
  /**
   * 比较原 PDF 侧与导出 PDF 侧。
   * @param original 原 PDF 提取的文本快照（按页分组）
   * @param exported 导出 PDF 提取的文本快照（按页分组）
   */
  compare(
    original: readonly (readonly FidelityTextItem[])[],
    exported: readonly (readonly FidelityTextItem[])[],
  ): DifferenceReport;
}

function normalizeText(t: string): string {
  return t.replace(/\s+/g, "").trim();
}

/** 判定两个文本是否等价（忽略空白） */
function textEqual(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

/** 判定坐标是否在容差内 */
function coordEqual(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/** 提取字体标识 */
function fontKey(f?: string): string {
  return (f ?? "unknown").trim().toLowerCase();
}

/**
 * 默认 Fidelity Comparator。
 */
export function createFidelityComparator(
  options: FidelityComparatorOptions = {},
): FidelityComparator {
  const tol = options.coordinateTolerance ?? 1.0;
  const passThreshold = options.pagePassThreshold ?? 0.95;
  const maxMismatches = options.maxMismatches ?? 200;

  return {
    compare(original, exported): DifferenceReport {
      const pageCount = Math.max(original.length, exported.length);
      const pages: PageFidelityResult[] = [];
      const mismatches: FidelityMismatch[] = [];
      let totalText = 0;
      let totalTextOk = 0;
      let totalFont = 0;
      let totalFontOk = 0;
      let totalCoord = 0;
      let totalCoordOk = 0;
      let totalMissing = 0;
      let originalItemCount = 0;
      let exportedItemCount = 0;

      for (let p = 0; p < pageCount; p++) {
        const origPage = original[p] ?? [];
        const expPage = exported[p] ?? [];
        originalItemCount += origPage.length;
        exportedItemCount += expPage.length;

        let pageText = 0;
        let pageTextOk = 0;
        let pageFont = 0;
        let pageFontOk = 0;
        let pageCoord = 0;
        let pageCoordOk = 0;
        let pageMissing = 0;

        // 按位置对齐比较（原 PDF 项 vs 导出 PDF 项）
        const n = Math.max(origPage.length, expPage.length);
        for (let i = 0; i < n; i++) {
          const o = origPage[i];
          const e = expPage[i];

          // Missing：原 PDF 有、导出 PDF 无
          if (o && !e) {
            totalMissing++;
            pageMissing++;
            if (mismatches.length < maxMismatches) {
              mismatches.push({
                page: p + 1,
                dimension: "missing",
                expectedText: o.text,
                actualText: "",
                expectedFont: o.fontFamily ?? "",
                actualFont: "",
              });
            }
            continue;
          }
          if (!o) continue; // 导出侧多出的项，不判缺失

          // Text
          totalText++;
          pageText++;
          const textMatch = textEqual(o.text, e!.text);
          if (textMatch) { totalTextOk++; pageTextOk++; }
          else if (mismatches.length < maxMismatches) {
            mismatches.push({
              page: p + 1,
              dimension: "text",
              expectedText: o.text,
              actualText: e!.text,
              expectedFont: o.fontFamily ?? "",
              actualFont: e!.fontFamily ?? "",
            });
          }

          // Font
          totalFont++;
          pageFont++;
          const fontMatch = fontKey(o.fontFamily) === fontKey(e!.fontFamily);
          if (fontMatch) { totalFontOk++; pageFontOk++; }
          else if (mismatches.length < maxMismatches) {
            mismatches.push({
              page: p + 1,
              dimension: "font",
              expectedText: o.text,
              actualText: e!.text,
              expectedFont: o.fontFamily ?? "",
              actualFont: e!.fontFamily ?? "",
            });
          }

          // Coordinate
          totalCoord++;
          pageCoord++;
          const coordMatch =
            coordEqual(o.x, e!.x, tol) && coordEqual(o.y, e!.y, tol);
          if (coordMatch) { totalCoordOk++; pageCoordOk++; }
          else if (mismatches.length < maxMismatches) {
            const dx = e!.x - o.x;
            const dy = e!.y - o.y;
            mismatches.push({
              page: p + 1,
              dimension: "coordinate",
              expectedText: o.text,
              actualText: e!.text,
              expectedFont: o.fontFamily ?? "",
              actualFont: e!.fontFamily ?? "",
              coordinateDelta: `dx: ${round(dx)}pt dy: ${round(dy)}pt`,
            });
          }
        }

        const textAccuracy = pageText > 0 ? pageTextOk / pageText : 1;
        const fontAccuracy = pageFont > 0 ? pageFontOk / pageFont : 1;
        const coordinateAccuracy = pageCoord > 0 ? pageCoordOk / pageCoord : 1;
        // 综合：文本 + 坐标（字体作为加分，缺失扣分）
        const overallPage = textAccuracy * 0.5 + coordinateAccuracy * 0.5;
        pages.push({
          page: p + 1,
          textAccuracy,
          fontAccuracy,
          coordinateAccuracy,
          missingCount: pageMissing,
          pass: overallPage >= passThreshold,
        });
      }

      const textAccuracy = totalText > 0 ? totalTextOk / totalText : 1;
      const fontAccuracy = totalFont > 0 ? totalFontOk / totalFont : 1;
      const coordinateAccuracy = totalCoord > 0 ? totalCoordOk / totalCoord : 1;
      const overallFidelity = textAccuracy * 0.5 + coordinateAccuracy * 0.5;
      const overall = overallFidelity >= passThreshold && totalMissing === 0;

      return {
        overall,
        overallFidelity,
        originalItemCount,
        exportedItemCount,
        missingCount: totalMissing,
        pages,
        mismatches,
        threshold: tol,
      };
    },
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
