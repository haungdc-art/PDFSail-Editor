/**
 * export-matrix-writer.ts — M7.5-005C · Matrix Writer
 *
 * 目标：使用 Native Transform（EditableGlyph.metrics.pdfTransform）把 glyph 正确
 *       写回 PDF Content Stream 的 Text Matrix（Tm），不退化到 CSS 近似。
 *
 * 设计决策（关键）：
 *   pdfTransform 是 PDF 用户空间的完整综合变换矩阵 [a,b,c,d,e,f]，**已包含 fontSize
 *   缩放与平移**（即 pdf.js text item transform：TextMatrix × FontMatrix × CTM 合成的最终矩阵）。
 *   因此原生写回采用：
 *       BT /<fontRef> 1 Tf  <a> <b> <c> <d> <e> <f> Tm  (text) Tj  ET
 *   - Tf = 1：把整个缩放/旋转/倾斜都保留在 Tm 中，绝不二次放大。
 *   - 若把 scale 折成 Tf（如 0.8×12→Tf=9.6）+ identity Tm，会丢失「矩阵保真」，
 *     与 005C 验收 Case2 冲突（必须保持 Tm: 0.8 0 0 0.8 …）。
 *   - 因此本模块不「从矩阵提取 fontSize」来构造 Tf，而是明确以「矩阵即真相」。
 *
 * 边界（005C 允许层）：
 *   仅本模块 + 验收脚本；不 writeExportCommandsToPDF 重写、无 Content rewrite、
 *   无 CID 编码、无 mutation / undo。消费方接入留待 005D/005E。
 *
 * 坐标系：Tm 六元组 a b c d e f 直接对应 PDF Text Matrix 算子操作数。
 */
import type { TransformMatrix } from "./types";

/** glyph 放置参数（005C spec 定义） */
export interface GlyphPlacement {
  /** 文本起点 x（PDF pt，bottom-left Y up；通常来自 pdfTransform[4]） */
  x: number;
  /** 文本起点 y（PDF pt；通常来自 pdfTransform[5]） */
  y: number;
  /** 原生综合变换矩阵（PDF 用户空间，已含 fontSize 缩放 + 平移 e/f） */
  transform: TransformMatrix;
  /** 字号（PDF pt，审计/trace 用；原生写回不被其驱动） */
  fontSize: number;
}

/** Text Run 组装结果 */
export interface TextRunOps {
  /** 写回所用的 Text Matrix（= glyph.transform，逐元素保真） */
  textMatrix: TransformMatrix;
  /** 写回所用的 Tf 字号（原生路径恒为 1，避免二次缩放） */
  renderFontSize: number;
  /** 文本 */
  text: string;
  /** 字体资源名（如 "F1"） */
  fontRef: string;
  /** 序列化后的 Content Stream 片段（BT…ET） */
  operators: string;
}

/**
 * 从完整矩阵推导字号（√(a²+b²)，PDF 32000-1 §9.4.4）。
 * 仅用于 audit/trace；原生写回不使用它构造 Tf（见模块头注释）。
 */
export function deriveFontSizeFromMatrix(m: TransformMatrix): number {
  return Math.hypot(m[0], m[1]);
}

/**
 * 原生 Text Matrix：把完整 pdfTransform 逐元素写入 Tm，Tf=1。
 * 这是「矩阵即真相」的核心：scale/rotation/skew 全部保留在矩阵中。
 */
export function buildNativeTextMatrix(placement: GlyphPlacement): TransformMatrix {
  return [...placement.transform] as TransformMatrix;
}

/**
 * 组装 Text Run（tolerant：字号不精确、矩阵非单位也不会被「归一化」而丢信息）。
 *
 * 验证时可断言：
 *   - renderFontSize === 1（未把 scale 折进 Tf）
 *   - operators 含 "BT" / "Tf" / "Tm" / "Tj" / "ET"
 *   - operators 中 Tm 的 6 个操作数与输入的 transform 逐元素一致
 */
export function composeNativeTextRun(
  placement: GlyphPlacement,
  text: string,
  fontRef: string,
): TextRunOps {
  const textMatrix = buildNativeTextMatrix(placement);
  const [a, b, c, d, e, f] = textMatrix;
  const operators =
    `BT /${fontRef} 1 Tf ${trimNum(a)} ${trimNum(b)} ${trimNum(c)} ${trimNum(d)} ${trimNum(e)} ${trimNum(f)} Tm (${escapeText(text)}) Tj ET`;
  return {
    textMatrix,
    renderFontSize: 1,
    text,
    fontRef,
    operators,
  };
}

/* ───────────────────────── 小工具 ───────────────────────── */

/** 数字 → 精简字符串（避免尾随噪声，利于断言与审计） */
function trimNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** 转义 Tj 字符串中的括号与反斜杠（PDF 字符串字面量） */
function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}