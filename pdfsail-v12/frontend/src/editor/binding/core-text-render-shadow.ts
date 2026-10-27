/**
 * editor/binding/core-text-render-shadow.ts — F3B-6.18-B
 *
 * Core Text Renderer Shadow —— **纯结构比较**（no DOM / no React / no canvas / no mutation）。
 *
 * ── 它回答的唯一问题（6.18-B）───────────────────────────────────────
 *   如果让 Core 成为唯一**文本** renderer，现有页面会不会发生真实视觉/几何回归？
 *
 * 做法：把同一份真实文档的两条文本渲染产物喂进来做结构 diff（**先结构，后像素**）：
 *
 *   legacy text render  = renderPageToCommands(doc, page, suppressedSet, rotationMap)
 *                          → DrawGlyphCommand[]（携带 baseline / transform / suppression）
 *   core   text render  = buildCoreRenderSource(doc)
 *                          → DrawGlyphCommand[]（刻意不带 baseline，无 transform，无 suppression）
 *
 * 比较维度（page→textBox→paragraph→line→run→glyph 的 glyph 级子集）：
 *   · char（文本）
 *   · bbox（x / y / width / height）
 *   · ordering（同 (blockId,lineId) 内的出现顺序）
 *   · baseline / transform 的**存在性差异**（Core 的已知结构差异 → 记为 riskFlag，不静默）
 *
 * ── 它**不是**什么 ─────────────────────────────────────────────────
 *   · 不是第二套 renderer：不画任何东西、不选 renderSource、不改 `__rendererMode`
 *   · 不消费 mask / drawRect / drawImage（只取 `drawGlyph`；非 glyph 只计数）
 *   · 不写文档、不写 store、不碰 Segment / docBlocks / editedLineBoxes
 *   · 不依赖 React / DOM / canvas / editor-engine
 *
 * ── Segment 与 Core 的「重复文本」观察 ──────────────────────────────
 * `detectDuplicateTextRender` 对每个 Segment 的 (blockId,lineId,text) 检查 Core glyph 是否
 * 覆盖同一行同一批字符 —— 这是**结构性重叠**报告（是否真的视觉重复由 6.18-C 真实浏览器判定）。
 */

import type { DrawGlyphCommand, RenderCommand } from "../../document-model/render-command";

/** 位置容差（px）—— 与 render-state reconciliation 的 0.5 约定一致 */
export const DEFAULT_TEXT_RENDER_SHADOW_TOLERANCE = 0.5;

/** 稳定 riskFlag 前缀（便于断言；不静默） */
export const SHADOW_RISK_BASELINE_ABSENT = "baseline-absent-in-core";
export const SHADOW_RISK_TRANSFORM_ABSENT = "transform-absent-in-core";
export const SHADOW_RISK_SEGMENT_OVERLAP = "segment-core-text-overlap";
export const SHADOW_RISK_LINE_CORE_MISSING = "line-missing-in-core";
/** glyph 盒**高度**差异（Core 的 line-height 派生盒 vs legacy 的 PDF bbox 高度）——
 *  影响盒模型/命中区，**不改变字形绘制原点**，故不计入位置回归。 */
export const SHADOW_RISK_HEIGHT_DIFF = "glyph-height-difference";
/** glyph 盒**宽度**差异（advance 派生盒宽）——报告用。 */
export const SHADOW_RISK_WIDTH_DIFF = "glyph-box-width-difference";

// ─────────────────────────────────────────────────────────────────────
//  归一化
// ─────────────────────────────────────────────────────────────────────

/** 一条 `DrawGlyphCommand` 的归一化投影（只保留比较需要的字段） */
export interface TextRenderShadowGlyph {
  blockId: string;
  lineId: string;
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** legacy 有真实 baseline；Core 刻意不输出 ⇒ null */
  baseline: number | null;
  /** legacy 有 transform（旋转/倾斜）；Core 无 ⇒ false */
  hasTransform: boolean;
  modified: boolean;
  /** 该 side 的 glyph 全局出现序号（0-based；仅 `drawGlyph`） */
  order: number;
}

/** 把命令流归一化成 glyph 序列（忽略 drawLine / drawRect / drawImage） */
export function toShadowGlyphs(commands: readonly RenderCommand[]): TextRenderShadowGlyph[] {
  const out: TextRenderShadowGlyph[] = [];
  for (const cmd of commands) {
    if (cmd.type !== "drawGlyph") continue;
    const glyph = cmd as DrawGlyphCommand;
    out.push({
      blockId: glyph.blockId,
      lineId: glyph.lineId,
      char: glyph.char,
      x: glyph.x,
      y: glyph.y,
      width: glyph.width,
      height: glyph.height,
      baseline: typeof glyph.baseline === "number" ? glyph.baseline : null,
      hasTransform: glyph.transform !== undefined,
      modified: glyph.modified === true,
      order: out.length,
    });
  }
  return out;
}

/** 非 glyph 命令的类型计数（mask / rect / image —— Core 侧应为 0） */
export function countNonGlyphCommands(commands: readonly RenderCommand[]): number {
  let n = 0;
  for (const cmd of commands) if (cmd.type !== "drawGlyph") n += 1;
  return n;
}

function lineKey(blockId: string, lineId: string): string {
  return `${blockId}\u0001${lineId}`;
}

function indexGlyphsByLine(
  glyphs: readonly TextRenderShadowGlyph[]
): Map<string, TextRenderShadowGlyph[]> {
  const index = new Map<string, TextRenderShadowGlyph[]>();
  for (const glyph of glyphs) {
    const key = lineKey(glyph.blockId, glyph.lineId);
    const list = index.get(key);
    if (list) list.push(glyph);
    else index.set(key, [glyph]);
  }
  return index;
}

function textOf(glyphs: readonly TextRenderShadowGlyph[]): string {
  return glyphs.map((g) => g.char).join("");
}

// ─────────────────────────────────────────────────────────────────────
//  每行结构 diff
// ─────────────────────────────────────────────────────────────────────

export interface TextRenderShadowLineDiff {
  blockId: string;
  lineId: string;
  legacyGlyphs: number;
  coreGlyphs: number;
  legacyText: string;
  coreText: string;
  /** 同序号对齐后 char 完全一致 */
  textParity: boolean;
  /** 同序号对齐后 char 不一致的个数 */
  charMismatches: number;
  /** legacy 有、core 无（按序号对齐后 core 缺失） */
  missingInCore: number;
  /** core 有、legacy 无 */
  extraInCore: number;
  /** 对齐对的 max(|dx|,|dy|,|dw|,|dh|) */
  maxPosDelta: number;
  /** 逐轴最大绝对差（诊断：区分行起点偏移 vs advance 累积漂移）*/
  maxDx: number;
  maxDy: number;
  maxDw: number;
  maxDh: number;
  /** 首个对齐 glyph 的 x 差（= 行起点偏移；负=Core 偏左）*/
  firstDx: number | null;
  /** 末个对齐 glyph 的 x 差（与 firstDx 对比 ⇒ 漂移方向/幅度）*/
  lastDx: number | null;
  /** legacy 有 baseline 而 core 无的对数 */
  baselineLegacyOnly: number;
  /** legacy 有 transform 而 core 无的对数 */
  transformLegacyOnly: number;
}

function compareLine(
  blockId: string,
  lineId: string,
  legacy: readonly TextRenderShadowGlyph[],
  core: readonly TextRenderShadowGlyph[]
): TextRenderShadowLineDiff {
  const paired = Math.min(legacy.length, core.length);
  let charMismatches = 0;
  let maxPosDelta = 0;
  let maxDx = 0;
  let maxDy = 0;
  let maxDw = 0;
  let maxDh = 0;
  let firstDx: number | null = null;
  let lastDx: number | null = null;
  let baselineLegacyOnly = 0;
  let transformLegacyOnly = 0;

  for (let i = 0; i < paired; i += 1) {
    const l = legacy[i];
    const c = core[i];
    if (l.char !== c.char) charMismatches += 1;
    const dx = c.x - l.x;
    const dy = c.y - l.y;
    const dw = c.width - l.width;
    const dh = c.height - l.height;
    if (Math.abs(dx) > maxDx) maxDx = Math.abs(dx);
    if (Math.abs(dy) > maxDy) maxDy = Math.abs(dy);
    if (Math.abs(dw) > maxDw) maxDw = Math.abs(dw);
    if (Math.abs(dh) > maxDh) maxDh = Math.abs(dh);
    const delta = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
    if (delta > maxPosDelta) maxPosDelta = delta;
    if (i === 0) firstDx = dx;
    lastDx = dx;
    if (l.baseline !== null && c.baseline === null) baselineLegacyOnly += 1;
    if (l.hasTransform && !c.hasTransform) transformLegacyOnly += 1;
  }

  const legacyText = textOf(legacy);
  const coreText = textOf(core);
  return {
    blockId,
    lineId,
    legacyGlyphs: legacy.length,
    coreGlyphs: core.length,
    legacyText,
    coreText,
    textParity: legacy.length === core.length && charMismatches === 0,
    charMismatches,
    missingInCore: Math.max(0, legacy.length - core.length),
    extraInCore: Math.max(0, core.length - legacy.length),
    maxPosDelta,
    maxDx,
    maxDy,
    maxDw,
    maxDh,
    firstDx,
    lastDx,
    baselineLegacyOnly,
    transformLegacyOnly,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Segment × Core 文本重叠（重复文本观察）
// ─────────────────────────────────────────────────────────────────────

/** 调用方提供的 Segment 结构投影（不 import Segment 类型，保持模块轻依赖） */
export interface ShadowSegmentProjection {
  blockId?: string | null;
  lineId?: string | null;
  text: string;
}

export interface DuplicateTextRisk {
  blockId: string;
  lineId: string;
  segmentText: string;
  coreGlyphText: string;
  /** segment 文本被 core glyph 文本完整包含 */
  exactContainment: boolean;
  /** 结构重叠字符数（exactContainment ? segment.length : 公共字符数上界） */
  overlapChars: number;
}

/** 报告 Segment 层与 Core glyph 层在同一 (blockId,lineId) 上的结构性文本重叠 */
export function detectDuplicateTextRender(
  segments: readonly ShadowSegmentProjection[],
  coreGlyphs: readonly TextRenderShadowGlyph[]
): DuplicateTextRisk[] {
  const coreByLine = indexGlyphsByLine(coreGlyphs);
  const out: DuplicateTextRisk[] = [];
  for (const seg of segments) {
    const blockId = seg.blockId ?? "";
    const lineId = seg.lineId ?? "";
    const segmentText = (seg.text ?? "").trim();
    if (segmentText.length === 0) continue;
    const coreLine = coreByLine.get(lineKey(blockId, lineId));
    if (!coreLine || coreLine.length === 0) continue;
    const coreGlyphText = textOf(coreLine);
    if (coreGlyphText.length === 0) continue;
    const exactContainment = coreGlyphText.includes(segmentText);
    out.push({
      blockId,
      lineId,
      segmentText,
      coreGlyphText,
      exactContainment,
      overlapChars: exactContainment
        ? segmentText.length
        : countCommonChars(segmentText, coreGlyphText),
    });
  }
  return out;
}

/** 字符集合交叠的下界计数（顺序无关；仅作重叠强度指示） */
function countCommonChars(a: string, b: string): number {
  const pool = new Map<string, number>();
  for (const ch of b) pool.set(ch, (pool.get(ch) ?? 0) + 1);
  let n = 0;
  for (const ch of a) {
    const left = pool.get(ch) ?? 0;
    if (left > 0) {
      n += 1;
      pool.set(ch, left - 1);
    }
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────────

export interface TextRenderShadowReport {
  tolerance: number;
  legacyGlyphCount: number;
  coreGlyphCount: number;
  /** 非 glyph 命令计数（Core 侧应恒为 0 —— Core 只产 drawGlyph） */
  nonGlyphCommandCounts: { legacy: number; core: number };
  lines: TextRenderShadowLineDiff[];
  /** 出现 char 不一致 / 缺失 / 多余 / **位置（x/y）**超容差的行数 */
  divergentLines: number;
  /** 仅 **盒宽/盒高**（advance/line-height 派生）超容差、位置无回归的行数 */
  metricOnlyLines: number;
  maxPosDelta: number;
  verdict: "PARITY" | "DIVERGENT";
  riskFlags: string[];
  duplicateText: DuplicateTextRisk[];
  notes: string[];
}

export interface BuildTextRenderShadowInput {
  legacyCommands: readonly RenderCommand[];
  coreCommands: readonly RenderCommand[];
  /** Segment 结构投影（可选；用于「重复文本」观察） */
  segments?: readonly ShadowSegmentProjection[];
  tolerance?: number;
}

/**
 * 纯函数：比较 Core 与 Legacy 的**文本**渲染产物。
 *
 * ⚠️ 只读：不修改任何入参；输出全部是新对象。
 * ⚠️ Core 失败（`coreCommands` 为空）时不应调用本函数判定"回归" ——
 *    调用方须区分「Core 无产物」与「Core 产物有差异」。
 */
export function buildTextRenderShadow(input: BuildTextRenderShadowInput): TextRenderShadowReport {
  const tolerance = input.tolerance ?? DEFAULT_TEXT_RENDER_SHADOW_TOLERANCE;
  const legacyGlyphs = toShadowGlyphs(input.legacyCommands);
  const coreGlyphs = toShadowGlyphs(input.coreCommands);

  const legacyByLine = indexGlyphsByLine(legacyGlyphs);
  const coreByLine = indexGlyphsByLine(coreGlyphs);

  // 行集合 = legacy ∪ core（保住"core 少了整行"这种回归）
  const keys = new Set<string>([...legacyByLine.keys(), ...coreByLine.keys()]);
  const lines: TextRenderShadowLineDiff[] = [];
  for (const key of keys) {
    const [blockId, lineId] = splitLineKey(key);
    lines.push(compareLine(blockId, lineId, legacyByLine.get(key) ?? [], coreByLine.get(key) ?? []));
  }
  lines.sort((a, b) => (a.blockId === b.blockId ? a.lineId.localeCompare(b.lineId) : a.blockId.localeCompare(b.blockId)));

  let divergentLines = 0;
  let metricOnlyLines = 0;
  let maxPosDelta = 0;
  let maxDh = 0;
  let maxDw = 0;
  let baselineLegacyOnlyTotal = 0;
  let transformLegacyOnlyTotal = 0;
  for (const line of lines) {
    const textDivergent =
      line.charMismatches > 0 || line.missingInCore > 0 || line.extraInCore > 0;
    // ★ 位置回归只看 x / y（视觉原点）；盒宽/盒高单独归为 metric。
    const positionDivergent = line.maxDx > tolerance || line.maxDy > tolerance;
    if (textDivergent || positionDivergent) divergentLines += 1;
    else if (line.maxDw > tolerance || line.maxDh > tolerance) metricOnlyLines += 1;
    if (line.maxPosDelta > maxPosDelta) maxPosDelta = line.maxPosDelta;
    if (line.maxDh > maxDh) maxDh = line.maxDh;
    if (line.maxDw > maxDw) maxDw = line.maxDw;
    baselineLegacyOnlyTotal += line.baselineLegacyOnly;
    transformLegacyOnlyTotal += line.transformLegacyOnly;
  }

  const riskFlags: string[] = [];
  if (baselineLegacyOnlyTotal > 0) riskFlags.push(SHADOW_RISK_BASELINE_ABSENT);
  if (transformLegacyOnlyTotal > 0) riskFlags.push(SHADOW_RISK_TRANSFORM_ABSENT);
  if (lines.some((l) => l.legacyGlyphs > 0 && l.coreGlyphs === 0)) {
    riskFlags.push(SHADOW_RISK_LINE_CORE_MISSING);
  }
  if (maxDh > tolerance) riskFlags.push(SHADOW_RISK_HEIGHT_DIFF);
  if (maxDw > tolerance) riskFlags.push(SHADOW_RISK_WIDTH_DIFF);

  const duplicateText = input.segments
    ? detectDuplicateTextRender(input.segments, coreGlyphs)
    : [];
  if (duplicateText.length > 0) riskFlags.push(SHADOW_RISK_SEGMENT_OVERLAP);

  const notes: string[] = [];
  if (baselineLegacyOnlyTotal > 0) {
    notes.push(
      `${baselineLegacyOnlyTotal} 个 glyph：legacy 携带 baseline 而 Core 不携带。` +
        `这是 render-command-bridge 的**有意省略**（硬契约 1）：不输出 baseline 时 GlyphRenderer 走 ` +
        `spanTop = cmd.y，逐字尊重 Core Layout 的几何；**不等于**几何回归。`
    );
  }
  if (transformLegacyOnlyTotal > 0) {
    notes.push(
      `${transformLegacyOnlyTotal} 个 glyph：legacy 携带 transform 而 Core 无。` +
        `旋转/倾斜文本在 Core 路径下会退化为轴对齐 —— 需要 6.18-C 真实视觉确认（riskFlag 已记录）。`
    );
  }
  if (maxDh > tolerance) {
    notes.push(
      `${maxDh.toFixed(2)}px glyph 盒**高度**差异（Core 的 line-height 派生盒 vs legacy 的 PDF bbox 高度）。` +
        `它影响盒模型 / 命中区，**不改变字形绘制原点**（GlyphRenderer 以 cmd.y 定 spanTop）⇒ 不计入位置回归。`
    );
  }
  if (maxDw > tolerance) {
    notes.push(`${maxDw.toFixed(2)}px glyph 盒**宽度**差异（advance 派生盒宽）—— 报告用，需 6.18-C 视觉确认。`);
  }
  if (duplicateText.length > 0) {
    notes.push(
      `Segment 层与 Core glyph 层在 ${duplicateText.length} 条 (blockId,lineId) 上结构性文本重叠。` +
        `注意：legacy 现状亦是 glyph + Segment 双层，故本项**本身不构成新增重复**；` +
        `是否为真实视觉重复由 6.18-C 判定。`
    );
  }

  return {
    tolerance,
    legacyGlyphCount: legacyGlyphs.length,
    coreGlyphCount: coreGlyphs.length,
    nonGlyphCommandCounts: {
      legacy: countNonGlyphCommands(input.legacyCommands),
      core: countNonGlyphCommands(input.coreCommands),
    },
    lines,
    divergentLines,
    metricOnlyLines,
    maxPosDelta,
    verdict: divergentLines === 0 ? "PARITY" : "DIVERGENT",
    riskFlags,
    duplicateText,
    notes,
  };
}

function splitLineKey(key: string): [string, string] {
  const idx = key.indexOf("\u0001");
  return [key.slice(0, idx), key.slice(idx + 1)];
}
