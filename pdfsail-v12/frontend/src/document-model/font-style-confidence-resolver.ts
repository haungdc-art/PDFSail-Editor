/**
 * font-style-confidence-resolver.ts — M7.7-003B Font Candidate Resolver
 *
 * 职责边界（只做「编辑态 CSS 字体选择」，不解决 PDF 原生字体保真）：
 *   PDF 原生字体保真（Font Identity → Embedded Font → Native Replacement）属 M7.7-004/M7.8，
 *   本模块不在该 scope。
 *
 * 背景：
 *   font-detector 只返回 { family, weight, confidence }。实测（M7.7-VERIFY-003B）：
 *   - 常规（regular）拉丁扫描件置信度普遍偏低（conf≈0.22~0.27），且常误判为衬线族
 *     （Times New Roman / Georgia），把整页编辑框污染成 Times。
 *   - 粗体（weight=700）场景置信度可能也不到 0.6（实测 0.392），但结果正确，因为
 *     「笔画宽度」判定特征显著，可靠。
 *
 * 结论：不能只按 confidence 决定（Bold 低 conf 也正确），也不能粗暴 「conf 低 → Arial」
 * （会把真 Times/Georgia/Courier PDF 也归 Arial）。需结合「置信度门 + 字重权重 + 字体语法」。
 *
 * 决策规则（按序）：
 *   1. weight >= 700 → 信任检测（粗体特征明显，实测可靠）。source='detector'
 *   2. confidence >= HIGH_CONFIDENCE_GATE → 信任检测。source='detector'
 *   3. confidence < LOW_CONFIDENCE_GATE 且族为「非安全无衬线拉丁」且 weight==400
 *      → 低置信 regular 误判高风险，回退到安全无衬线 + 中文回退栈。source='low-confidence-latin-fallback'
 *      （真 Times/Georgia/Courier PDF 若置信度足够高会走规则 2 保留；此处只拦截 模糊的 regular 误判，
 *      保真度损失留给 M7.7-004 用真字体映射解决，换取绝大多数 Arial 文档不被污染）
 *   4. 其余（中等置信度或安全族）→ 保留检测。source='detector'
 *
 * 本模块不触碰 font-detector.ts / Export / Native Replace / OCR / Font Mapping。
 */

/** font-detector 的最小输出契约（structural，不强依赖 detector 具体实现） */
export interface DetectorResult {
  fontFamily: string;
  fontWeight: number;
  confidence: number;
}

/** 决策来源，用于排查/审计 */
export type ResolveSource = "detector" | "low-confidence-latin-fallback" | "no-detection";

/** 决策层输出：编辑框最终使用的 fontFamily 栈 + 字重 */
export interface ResolvedEditableFont {
  familyStack: string;
  weight: number;
  source: ResolveSource;
  /** 被采纳的检测结果（no-detection 时为 null） */
  detected: DetectorResult | null;
}

/** 高置信：无条件信任检测结果 */
export const HIGH_CONFIDENCE_GATE = 0.6;
/** 低置信：配合「非安全无衬线 + regular」触发回退 */
export const LOW_CONFIDENCE_GATE = 0.35;

/**
 * 编辑态安全回退栈（常规西文优先 + 中文回退）。
 * M7.7-003C: 常规（regular）扫描件多为 Helvetica 类，Helvetica 度量更贴近原文故置首；
 * Arial 次之（twin，但 Windows 下 Arial 常被选中）；后接中文族保证 CID 中文仍可回退。
 * 与 ocr-style-resolver 的 FALLBACK_STYLE 语义一致——不回落到系统默认（避免 font-family 全错）。
 */
export const EDITOR_LATIN_FIRST_STACK =
  "'Helvetica', 'Arial', 'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif";

/** 无衬线安全族：低置信时不需要回退（保留它们与回退结果等价，且避免多余的栈前缀累积） */
const SAFE_LATIN_FAMILIES = new Set(["Arial", "Helvetica", "sans-serif"]);

/**
 * 对单个字体检测结果做安全决策，返回最终编辑框字体栈。
 *
 * @param detected  font-detector 输出（family/weight/confidence）
 * @param baseStack 可信基底栈（默认拉丁优先+中文回退）；仅用于「保留检测」时的前缀拼接，
 *                  「回退」时恒返回 EDITOR_LATIN_FIRST_STACK，确保把污染族（如 Times）彻底换掉。
 */
export function resolveEditFont(
  detected: DetectorResult,
  baseStack: string = EDITOR_LATIN_FIRST_STACK
): ResolvedEditableFont {
  const family = detected.fontFamily;
  const weight = detected.fontWeight;
  const confidence = detected.confidence;

  // 规则 1：粗体特征显著 → 信任（不以 confidence 为准）
  // 规则 2：其他场景的高置信 → 信任
  if (weight >= 700 || confidence >= HIGH_CONFIDENCE_GATE) {
    return { familyStack: prependFamily(baseStack, family), weight, source: "detector", detected };
  }

  // 规则 3：低置信 + regular + 非安全无衬线族（Times/Georgia/Courier…）→ 误判高风险，回退
  if (weight === 400 && confidence < LOW_CONFIDENCE_GATE && !SAFE_LATIN_FAMILIES.has(family)) {
    return {
      familyStack: EDITOR_LATIN_FIRST_STACK,
      weight,
      source: "low-confidence-latin-fallback",
      detected,
    };
  }

  // 规则 4：其余（中等置信度，或安全无衬线族低置信）→ 保留检测
  return { familyStack: prependFamily(baseStack, family), weight, source: "detector", detected };
}

/** 栈拼接：若检测族已存在于基底栈（如 Arial 已在 Arial,Helvetica,...）则不重复前缀 */
function prependFamily(baseStack: string, family: string): string {
  if (!family) return baseStack;
  return baseStack.includes(family)
    ? baseStack
    : `'${family}', ${baseStack}`;
}