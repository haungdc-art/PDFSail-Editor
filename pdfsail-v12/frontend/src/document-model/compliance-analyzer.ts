/**
 * compliance-analyzer.ts — Compliance Analyzer（Implementation-001 · Decision-001 验收）
 *
 * ## 目的
 * 证明 Background Reconstruction 是否真正满足 Decision-001：
 *   "Background reconstruction must never overwrite non-text pixels."
 *
 * ## 核心指标
 * **Changed Non-text Pixels（mask=0 但被重建改动的像素数）——Decision-001 要求 = 0。**
 *
 * 输入：before（原图）、after（reconstruct 后）、glyphMask（文字 mask）
 * 输出：
 *   - Changed pixels（before vs after 不同的像素数）
 *   - Changed non-text pixels（mask=0 却被改的像素 → Decision-001 违规）
 *   - Changed text pixels（mask=1 被改的像素 → 正常的文字擦除）
 *   - Changed BBox（变化区域的包围盒）
 *   - Coverage（changed / 总面积）
 *   - Category 统计（text / non-text 各占多少 changed）
 *
 * ## 为什么不是 12/12 Unit Test
 * Unit Test 证明"算法能识别长直线"；Analyzer 证明"reconstruct 是否覆盖 non-text"。
 * Compliance = Non-text Pass，不是 Table Line Pass。
 * 以后 Compliance-3/4/5 全部复用此 Analyzer。
 */

/** Compliance 分析结果 */
export interface ComplianceAnalysis {
  /** before vs after 总变化像素数 */
  readonly changedPixels: number;
  /** Decision-001 违规：mask=0（non-text）却被覆盖的像素数。必须 = 0 */
  readonly changedNonTextPixels: number;
  /** 正常文字擦除：mask=1（text）被覆盖的像素数 */
  readonly changedTextPixels: number;
  /** changed 中 non-text 占比（%） */
  readonly nonTextRatio: number;
  /** 变化区域 BBox（像素坐标；无变化 → null） */
  readonly changedBBox: { x: number; y: number; width: number; height: number } | null;
  /** 变化覆盖率（changed / 总像素，%） */
  readonly coverage: number;
  /** 是否合规（changedNonTextPixels === 0） */
  readonly compliant: boolean;
  /** 不合规时，non-text 被覆盖的样例坐标（前 10 个） */
  readonly nonTextViolations: { x: number; y: number }[];
  /** 分类统计（Ground Truth Evaluation）：changed 像素按类别分布 */
  readonly classification?: { category: string; changed: number; changedNonText: number }[];
}

/** Ground Truth 分类 masks：分类名 → 该类别的像素 mask（1=属于该类别） */
export interface CategoryMasks {
  readonly [category: string]: Uint8Array;
}

/**
 * 分析 before/after 的重建是否覆盖 non-text。
 * @param before 原图 RGBA（Uint8ClampedArray）
 * @param after  重建后 RGBA
 * @param glyphMask 文字 mask（1=text, 0=non-text）
 * @param w 宽
 * @param h 高
 * @returns ComplianceAnalysis
 */
export function analyzeCompliance(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  glyphMask: Uint8Array,
  w: number,
  h: number,
  categoryMasks?: CategoryMasks,
): ComplianceAnalysis {
  let changedPixels = 0;
  let changedNonText = 0;
  let changedText = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const nonTextViolations: { x: number; y: number }[] = [];
  // 分类统计（Ground Truth Evaluation）
  const categoryStats = new Map<string, { changed: number; changedNonText: number }>();

  for (let i = 0; i < w * h; i++) {
    const px = i * 4;
    const changed =
      before[px] !== after[px] ||
      before[px + 1] !== after[px + 1] ||
      before[px + 2] !== after[px + 2] ||
      before[px + 3] !== after[px + 3];
    if (!changed) continue;

    changedPixels++;
    const x = i % w;
    const y = Math.floor(i / w);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;

    if (glyphMask[i] === 1) {
      changedText++;
    } else {
      changedNonText++;
      if (nonTextViolations.length < 10) nonTextViolations.push({ x, y });
    }

    // 分类统计（若提供了 Ground Truth 分类 masks）
    if (categoryMasks) {
      for (const cat of Object.keys(categoryMasks)) {
        if (categoryMasks[cat][i] === 1) {
          let s = categoryStats.get(cat);
          if (!s) { s = { changed: 0, changedNonText: 0 }; categoryStats.set(cat, s); }
          s.changed++;
          if (glyphMask[i] !== 1) s.changedNonText++;
          break; // 一个像素只归一个类
        }
      }
    }
  }

  const changedBBox =
    changedPixels > 0
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null;
  const total = w * h;

  const classification =
    categoryMasks
      ? Array.from(categoryStats.entries()).map(([category, s]) => ({
          category,
          changed: s.changed,
          changedNonText: s.changedNonText,
        }))
      : undefined;

  return {
    changedPixels,
    changedNonTextPixels: changedNonText,
    changedTextPixels: changedText,
    nonTextRatio: changedPixels > 0 ? Math.round((changedNonText / changedPixels) * 1000) / 10 : 0,
    changedBBox,
    coverage: total > 0 ? Math.round((changedPixels / total) * 1000) / 10 : 0,
    compliant: changedNonText === 0,
    nonTextViolations,
    classification,
  };
}

/** 便捷：文本化输出（供 CLI/测试） */
export function formatCompliance(a: ComplianceAnalysis): string {
  return [
    `Changed Pixels     = ${a.changedPixels}`,
    `Changed Text       = ${a.changedTextPixels}`,
    `Changed Non-text   = ${a.changedNonTextPixels}  ${a.compliant ? "✅ Decision-001 OK" : "❌ VIOLATION"}`,
    `Non-text Ratio     = ${a.nonTextRatio}%`,
    `Changed BBox       = ${a.changedBBox ? `${a.changedBBox.width}x${a.changedBBox.height} @(${a.changedBBox.x},${a.changedBBox.y})` : "none"}`,
    `Coverage           = ${a.coverage}%`,
  ].join("\n");
}
