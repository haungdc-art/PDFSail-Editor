/**
 * editor/core/layout/types.ts — EDITOR-CORE-006-B
 *
 * 唯一 Runtime Layout Contract（规范 §15 / §29 / §47）。
 *
 * ── 定位 ────────────────────────────────────────────────────────────
 * Layout 是 **派生数据**，不是文档真相（规范 §15：The layout result is derived data.
 * It is not the document truth）。因此本层：
 *   - 只通过 id 引用 EditorDocument（paragraphId / runId），不复制 text/style；
 *   - 不修改文档（规范 §50：renderer 与 layout 都不得 mutate document）；
 *   - 只使用 Page Canvas Space（§19）：原点左上、x 向右、y 向下、单位 px。
 *
 * ── 层级（§29）──────────────────────────────────────────────────────
 *     TextLayout
 *       └─ ParagraphLayout[]      ← 引用 paragraphId，box 是布局产物
 *             └─ LineLayout[]     ← 派生 lineId + UTF-16 区间 + hardBreak
 *                   └─ RunLayout[] ← 引用 runId + UTF-16 区间
 *                         └─ GlyphLayout[]  ← 派生缓存 + advanceSource
 *
 * ── GlyphLayout 的定位（006-A Q4 结论）──────────────────────────────
 * 必须存在（HitTest / Caret 几何 / PDF Binding 都需要 per-glyph advance），
 * 但它是 **派生缓存**：不进入 EditorDocument，也不得成为 TextPosition 的字段
 * （架构地图 V7 / 规范 §10）。
 *
 * ── 与旧实现的关系 ──────────────────────────────────────────────────
 * 语义骨架 ADAPT 自 `layout-model-v2`（position-only、用 id 引用上层、不复制业务数据，
 * ADR-006），但补齐了它缺失的 textStart/textEnd / hardBreak / baseline / advanceSource。
 * 本层不 import 任何 legacy / document-model / layout-model-v2 代码。
 */

import type { ParagraphAlignment, TextStyle } from "../document/types";
import type { CaretAffinity, TextPosition, TextRange } from "../position/types";

// ─────────────────────────────────────────────────────────────────────
//  基础几何（Page Canvas Space，§19）
// ─────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─────────────────────────────────────────────────────────────────────
//  度量来源（§18 的四级顺序，可观测化）
// ─────────────────────────────────────────────────────────────────────

/**
 * 字符 advance 的来源。按 §18 的优先级从高到低：
 *   pdf-metrics     PDF 字体度量（/Widths、/W、AFM）        ← 权威
 *   pdfsail-glyph   PDFSail 已提取的 glyph metrics          ← 已有
 *   resolved-font   字体解析结果（font-resolution 近似）     ← 近似
 *   canvas          **调用方注入的** browser canvas measureText ← 绝不作 PDF 几何权威
 *   fallback        四级全部未命中后的兜底估算                ← 见 `FallbackKind`
 *
 * ── ★ 4B-4H：为什么 `canvas` 与 `fallback` 必须分开 ──────────────────
 *   修复前，`fallback`（纯算术 `fontSize * 0.5`）被**误标**为 `"canvas"`，
 *   好像真的做了 canvas 测量 —— 实际上 `createFontMetricsProvider({})` 的
 *   `sources = []`，**没有任何 canvas 参与**。这让 `advanceSourceHistogram`
 *   失去意义（4B-4F 实测 `{pdfsail-glyph:370, canvas:120}`，其中 120 全是
 *   纯算术兜底）。
 *   ⇒ 现在：`canvas` **只**由调用方注入的 `canvasMetrics` 命中时产生；
 *           `fallback` **只**由兜底产生，具体策略由 `FallbackKind` 表达。
 *
 * ⚠️ `fallback` **不在** `ADVANCE_SOURCE_ORDER` 里 —— 它不是新的 provenance
 *    source，只是「全未命中」后的 **advance calculation strategy**（用户裁决）。
 */
export type AdvanceSource =
  | "pdf-metrics"
  | "pdfsail-glyph"
  | "resolved-font"
  | "canvas"
  | "fallback";

/**
 * ★ 4B-4H：`fallback` 的具体策略（observability 用，不改变任何数值语义）。
 *
 *   east-asian-wide  East Asian Wide / Fullwidth ⇒ `fontSize * 1.0`
 *   generic          其余（Latin / 数字 / 半角 / Ambiguous）⇒ `fontSize * 0.5`
 *   unknown          无法判定（emoji / 孤立代理项 / 多字符）⇒ `fontSize * 0.5`
 *                    ★ **保持修复前的当前行为**，不激进扩大
 */
export type FallbackKind = "east-asian-wide" | "generic" | "unknown";

/**
 * ★ 4B-4H(2)：fallback 的 **policy mode**（与 `FallbackKind` 正交，不污染它）。
 *
 *   character-aware   provider **声明了至少一个** metrics source
 *                     ⇒ 说明「存在真实字体/编辑上下文」，只是**本字符**没有
 *                       真实 glyph provenance（新增/替换字符）
 *                     ⇒ 用 character-aware 估算（CJK 1.0em / 其余 0.5em）
 *
 *   legacy-generic    provider **完全没有** source（`createFontMetricsProvider({})`）
 *                     ⇒ 整个文本都没有 glyph provenance，fallback 是**唯一**度量来源
 *                       （headless / export 路径：`build-core-export-context` 的
 *                        `buildCoreRenderSourceFromDocument(document)` 不带 options）
 *                     ⇒ **保持修复前的行为** `fontSize * 0.5`
 *
 * ── 为什么要分开（用户裁决）──────────────────────────────────────────
 *   把「**没有 provider**」与「**当前字符没有真实 glyph metrics**」混为一谈，
 *   会让 CJK 1em 从「新增字符修复」扩大成「headless/export 整体排版模型变更」
 *   —— 那超出了 4B-4H 的批准边界（实测会让 export 的 CJK 文本断行翻倍）。
 */
export type FallbackPolicy = "character-aware" | "legacy-generic";

/** §18 优先级顺序（metrics.ts 按此顺序尝试） */
export const ADVANCE_SOURCE_ORDER: readonly AdvanceSource[] = [
  "pdf-metrics",
  "pdfsail-glyph",
  "resolved-font",
  "canvas",
];

// ─────────────────────────────────────────────────────────────────────
//  GlyphLayout / RunLayout / LineLayout / ParagraphLayout
// ─────────────────────────────────────────────────────────────────────

/**
 * 单个字符的布局（**派生缓存**，不是文档实体）。
 *
 * textIndex / length 一律按 UTF-16 code unit 计（规范 §9），
 * 因此代理对（emoji）的 length = 2，绝不会被从中间切开。
 */
export interface GlyphLayout {
  /** 该字符在**段落文本**中的 UTF-16 起点 */
  textIndex: number;
  /** 该字符的 UTF-16 长度（BMP = 1，代理对 = 2） */
  length: number;
  /** 含 letterSpacing 的实际推进量（px），供 HitTest / Caret 使用 */
  advance: number;
  box: Rect;
  /** 绝对基线 Y（Page Canvas Space） */
  baseline: number;
  /** 该 advance 的度量来源（§18 的可观测证据） */
  advanceSource: AdvanceSource;
}

export interface RunLayout {
  /** 引用 EditorDocument.TextRun.id */
  runId: string;
  /**
   * 该 run 在**本行可见切片**上的段落内 UTF-16 区间 [textStart, textEnd)。
   *
   * ⚠️ 注意：跨行的 run 会出现在多个 LineLayout 中，每行一个切片
   * （如单 run 的 "Hello world" 折成两行时，行 1 的切片是 [0,6)、行 2 的是 [6,11)）。
   * 因此**不能**把它当作「run 在段落中的起点」使用 ——
   * run 的真实段落区间必须由 EditorDocument 计算（见 hit-test 的 runRangesOf）。
   */
  textStart: number;
  textEnd: number;
  origin: Point;
  box: Rect;
  baseline: number;
  glyphs: GlyphLayout[];
}

export interface LineLayout {
  /**
   * 派生 id（行不是 EditorDocument 的一等对象）。
   * 约定：`${paragraphId}#L${lineIndex}`
   */
  lineId: string;
  box: Rect;
  /** 绝对基线 Y（Page Canvas Space） */
  baseline: number;
  /** 该行覆盖的段落文本 UTF-16 区间 [textStart, textEnd) */
  textStart: number;
  textEnd: number;
  /**
   * 该行是否由硬换行结束。
   * 注意：EditorDocument 的段落文本本不该含 "\n"（CORE-003 已把 "\n" 解释为段落拆分）；
   * 此标志用于容忍 legacy 导入文本里的显式换行，以及未来的强制断行。
   */
  hardBreak: boolean;
  runs: RunLayout[];
  /** 行内文本的实际宽度（不含行尾空白） */
  contentWidth: number;
}

export interface ParagraphLayout {
  /** 引用 EditorDocument.Paragraph.id */
  paragraphId: string;
  textBoxId: string;
  /** 段落布局后的实际矩形（是**产物**，不是约束） */
  box: Rect;
  alignment: ParagraphAlignment;
  /** 段落文本 UTF-16 总长（不含段落间结构边界） */
  textLength: number;
  /** 段落总高 = Σ lineHeight */
  height: number;
  lines: LineLayout[];
}

// ─────────────────────────────────────────────────────────────────────
//  TextLayout
// ─────────────────────────────────────────────────────────────────────

export interface TextLayout {
  textBoxId: string;
  /** 计算该布局时的 document.version（规范 §66：细粒度失效判定） */
  documentVersion: number;
  /** TextBox 的**布局约束**矩形（§16：width/height 是真实约束，不是随内容扩张的提示） */
  constraintBox: Rect;
  paragraphs: ParagraphLayout[];
  /** 布局总高 */
  height: number;
  /** 是否超出约束高度（§16：溢出必须可观测，而不是悄悄撑大容器） */
  overflow: boolean;
  /** 该布局消耗的行数（诊断用） */
  lineCount: number;
}

// ─────────────────────────────────────────────────────────────────────
//  Caret / Selection 几何（规范 §11 / §12 / §48）
// ─────────────────────────────────────────────────────────────────────

export interface CaretGeometry {
  position: TextPosition;
  affinity: CaretAffinity;
  /** 插入点在 Page Canvas Space 中的位置（插入线左上角） */
  x: number;
  y: number;
  /** 插入线高度（= 该行行高） */
  height: number;
}

export interface SelectionGeometry {
  range: TextRange;
  /**
   * 选区矩形，**每个视觉行一个**（规范 §12：selection rendering is derived from
   * TextRange + TextLayout）。
   */
  quads: Rect[];
}

export interface LayoutResult {
  layout: TextLayout;
  /** 传入 position 的 caret 几何；未传或无法解析 → null */
  caretGeometry: CaretGeometry | null;
  /** 传入 range 的选区几何；未传或无法解析 → null */
  selectionGeometry: SelectionGeometry | null;
  /** 诊断信息（不静默降级，规范 §65） */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────
//  选项
// ─────────────────────────────────────────────────────────────────────

export interface LayoutOptions {
  /**
   * 上伸比例（ascent / fontSize）。
   * 缺省 0.8，沿用既有约定（document-model-v2/semantic-run-builder.ts:96-98、
   * renderer-dispatcher/painter-renderer-strategy.ts:78-80）。
   */
  ascentRatio?: number;
  /**
   * 下伸比例（descent / fontSize）。缺省 0.2，同上。
   */
  descentRatio?: number;
  /** 是否启用 CJK 标点禁则（避头尾）。缺省 true */
  kinsoku?: boolean;
  /** 是否强制断开超宽不可断 token（如长 URL）。缺省 true */
  breakLongTokens?: boolean;
  /** 行高倍数兜底（当 run style.lineHeight 缺失时）。缺省 1.3 */
  fallbackLineHeightRatio?: number;
  /** 单次布局的最多警告条数（去重后） */
  maxWarnings?: number;
}

export const DEFAULT_LAYOUT_OPTIONS: Required<LayoutOptions> = {
  ascentRatio: 0.8,
  descentRatio: 0.2,
  kinsoku: true,
  breakLongTokens: true,
  fallbackLineHeightRatio: 1.3,
  maxWarnings: 8,
};

/** 解析出的样式（不复制 TextStyle，只提取布局所需字段） */
export interface ResolvedScale {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}
