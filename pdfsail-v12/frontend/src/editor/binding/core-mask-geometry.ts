/**
 * editor/binding/core-mask-geometry.ts — F3B-6.27-GEO（Goal 2 几何原语）
 *
 * 缺口（截图实证）：mask 的 **identity 正确、geometry 错误**。
 * legacy 只能描述**编辑前的一条** PDF line；Core mutation 后同一段可能绘制成
 * **多条** visual lines ⇒ 单行高的白罩盖不住折行部分 ⇒ 原 PDF 末字透出。
 *
 * 职责：**从 Core 实际绘制出的 visual lines 求 mask 覆盖盒**（纯几何）。
 *
 * ── 为什么不与 legacy box 求并集（关键取舍）──────────────────────────
 * 并集会让 mask **只增不减**：Core 文本缩短后仍保留旧高度/旧宽度 ⇒ 遮住下方内容。
 * 实测要求是「Core 缩短 ⇒ 不残留旧高度」⇒ 本原语**只取 Core 并集**，
 * `legacyBox` 仅作为 stale / 无 Core 行时的 **fail-open 回退**（不参与并集）。
 *
 * ── 边界 ─────────────────────────────────────────────────────────────
 * · 纯几何：无 DOM、无 measurement、无文本推导、无坐标反推
 * · 归属由调用方保证（只传**同一归属**的 visual lines）；归属不符 ⇒ 不产出
 * · 陈旧 generation ⇒ fail-open（沿用 legacy box）
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Core 实际绘制出的一条视觉行（由 Core layout 提供，非 legacy 几何） */
export interface CoreVisualLineBox extends Box {
  /** 归属段落（用于隔离：不同段落不得互相影响） */
  paragraphId: string;
  /** 该段落内的视觉行序号 */
  lineIndex: number;
}

export interface CoreMaskGeometryInput {
  /** 被编辑行的归属段落 */
  paragraphId: string;
  /** Core 为该段落实际绘制出的视觉行（可多行） */
  coreLines: readonly CoreVisualLineBox[];
  /** 既有 legacy 行盒（**仅**作 fail-open 回退，不参与并集） */
  legacyBox: Box | null;
  /** 本次 Core mutation 的 generation 令牌 */
  generation: number;
  /** 当前已知最新 generation */
  currentGeneration: number;
}

export interface CoreMaskGeometryDecision {
  /** 覆盖盒；`null` 表示「不产出，沿用 legacyBox」 */
  box: Box | null;
  reason: string;
}

function isUsableBox(b: CoreVisualLineBox): boolean {
  return (
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    b.width > 0 &&
    b.height > 0
  );
}

export function coreMaskGeometry(input: CoreMaskGeometryInput): CoreMaskGeometryDecision {
  // ① 陈旧 mutation 不得覆盖当前状态 ⇒ fail-open
  if (input.generation < input.currentGeneration) {
    return { box: null, reason: "stale-generation" };
  }
  // ② 只接受归属一致的视觉行（未编辑行 / 其它段落不得混入）
  const own = input.coreLines.filter((l) => l && l.paragraphId === input.paragraphId && isUsableBox(l));
  if (own.length === 0) {
    return { box: null, reason: input.coreLines.length === 0 ? "no-core-lines" : "line-mismatch" };
  }
  // ③ 并集（**不与 legacyBox 并集** —— 避免 Core 缩短后残留旧高度）
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of own) {
    if (l.x < minX) minX = l.x;
    if (l.y < minY) minY = l.y;
    if (l.x + l.width > maxX) maxX = l.x + l.width;
    if (l.y + l.height > maxY) maxY = l.y + l.height;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) {
    return { box: null, reason: "degenerate-union" };
  }
  return {
    box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    reason: own.length > 1 ? "core-union-multi-line" : "core-single-line",
  };
}
