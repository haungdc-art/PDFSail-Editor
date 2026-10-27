/**
 * editor/core/layout/metrics.ts — EDITOR-CORE-006-B
 *
 * FontMetricsProvider —— 规范 §18 的四级度量顺序，**逐 glyph**、可观测、可缓存。
 *
 * ── §18 顺序（强制）────────────────────────────────────────────────
 *     PDF font metrics        ← pdf-font-metrics.ts / font-afm.ts        [权威]
 *             ↓
 *     PDFSail glyph metrics   ← EditableGlyph.metrics.advanceWidth       [已有]
 *             ↓
 *     resolved font metrics   ← font-resolution / FontAnalyzer           [近似]
 *             ↓
 *     canvas measureText      ← 兜底，绝不作为 PDF 几何权威             [最后]
 *
 * ── 为什么是「注入式」而不是直接 import ─────────────────────────────
 * 006-A 结论：真实度量（`document-model/pdf-font-metrics.ts` 的 `unicodeToAdvance` /
 * `trueAdvancePt`）与 canvas 兜底都在 Editor Core 之外（后者还需要 DOM）。
 * 若 Core 直接 import 它们，就会把 PDF Core / DOM 依赖带进 Editor Core，
 * 违反规范 §22（无 DOM）与 §57（依赖方向）。
 * 因此本层只定义**契约与顺序**，四路度量由调用方注入 —— 与 CORE-005
 * `PdfToCanvasMapper` 的注入方式一致。
 *
 * ── 与旧实现的关系 ──────────────────────────────────────────────────
 * 不重复实现任何度量算法；只做「按 §18 顺序派发 + 缓存 + 来源标注」。
 * 旧实现（`text-measurement.measureCharWidth` 等）继续存在，可被注入为某一级 source。
 */

import type { TextStyle } from "../document/types";
import {
  ADVANCE_SOURCE_ORDER,
  type AdvanceSource,
  type FallbackKind,
  type FallbackPolicy,
  type ResolvedScale,
} from "./types";
import {
  characterAwareFallbackAdvance,
  fallbackKindOf,
} from "./fallback-advance";

// ─────────────────────────────────────────────────────────────────────
//  查询与结果
// ─────────────────────────────────────────────────────────────────────

export interface GlyphMetricsQuery {
  /** 单个 code point（代理对为 2 个 UTF-16 单元） */
  char: string;
  /** 该字符在段落文本中的 UTF-16 起点（供上层度量定位，如 OCR/PDF 索引） */
  textIndex: number;
  style: TextStyle;
}

export interface GlyphMetrics {
  /** 纯字体 advance（px），**不含** letterSpacing */
  advance: number;
  advanceSource: AdvanceSource;
  /**
   * ★ 4B-4H：仅当 `advanceSource === "fallback"` 时有值 —— 兜底的具体策略。
   *   其余来源为 `undefined`（没有"兜底"这回事）。
   */
  fallbackKind?: FallbackKind;
  /**
   * ★ 4B-4H(2)：仅当 `advanceSource === "fallback"` 时有值 —— 兜底的 **policy mode**。
   *
   *   与 `fallbackKind` 正交：`fallbackKind` 说「这个字符被估成多宽」，
   *   本字段说「为什么用这个 policy」。
   *
   *   ⚠️ `legacy-generic` 模式下 `fallbackKind` **恒为 `generic`** ——
   *      因为该模式**没有启用** character-aware policy（即使字符是 CJK）。
   */
  fallbackPolicy?: FallbackPolicy;
}

/**
 * 单级度量函数。
 * 返回 `undefined` 表示「该级无法给出这个字符的度量」，交给下一级 —— 不返回 0 冒充成功。
 */
export type MetricsFn = (query: GlyphMetricsQuery) => number | undefined;

export interface FontMetricsProviderOptions {
  /** §18 L1 */
  pdfMetrics?: MetricsFn;
  /** §18 L2 */
  pdfsailGlyphMetrics?: MetricsFn;
  /** §18 L3 */
  resolvedFontMetrics?: MetricsFn;
  /** §18 L4（canvas measureText；由调用方注入，Core 自身不碰 DOM） */
  canvasMetrics?: MetricsFn;
  /**
   * 四级全部未命中时的兜底估算。
   *
   * ★ 4B-4H：缺省从 `fontSize * 0.5`（统一值）改为 **character-aware**：
   *     East Asian Wide / Fullwidth ⇒ `fontSize * 1.0`
   *     其余（Latin / 数字 / 半角 / emoji 等）⇒ `fontSize * 0.5`（**与修复前逐位一致**）
   *
   *   背景（4B-4F 实测）：统一 `fontSize * 0.5` 让新增 CJK 字符被系统性低估
   *   **恰好 50%**（「长」：Core 10.73px vs DOM 真实 21.45px，ratio 2.00）
   *   ⇒ Core 认为一行可放 48 个「长」，DOM 只能放 26 ⇒ Core 5 行 vs DOM 7 行。
   *
   * ⚠️ 纪律：
   *   · `advanceSource` 记为 **"fallback"**（修复前误记为 "canvas"）
   *   · **不影响**任何有真实 glyph provenance 的字符（pdfsail-glyph 完全不动）
   *   · emoji / 无法判定 ⇒ `0.5`（保持修复前行为，**不激进扩大**）
   */
  fallbackAdvance?: (query: GlyphMetricsQuery) => number;
  /** 缓存条目上限，缺省 20000 */
  cacheSize?: number;
  /**
   * 缓存键是否包含 `query.textIndex`（缺省 **false**，保持既有行为）。
   *
   * 为什么需要：默认缓存键是 `char + 字体身份`，**不含位置**。
   * 当同一字符在同一行内可能拥有**不同 advance** 时（PDF 里不同 text object 的
   * Tc/Tz 不同；或 L2 度量逐 glyph 取自原始 PDF），缓存会把第一个值复用给后续同形字符
   * → 静默的横向漂移。
   *
   * 逐 glyph 注入原始度量的调用方（EDITOR-CORE-012-A 的 legacy line metrics）
   * 应置为 `true`。**这是缓存策略开关，不改变任何度量算法或 §18 优先级。**
   */
  cacheIncludesTextIndex?: boolean;
  /** 上伸比例（ascent / fontSize），缺省 0.8 */
  ascentRatio?: number;
  /** 下伸比例（descent / fontSize），缺省 0.2 */
  descentRatio?: number;
}

const DEFAULT_CACHE_SIZE = 20000;
const DEFAULT_ASCENT_RATIO = 0.8;
const DEFAULT_DESCENT_RATIO = 0.2;

/** 缓存键：必须包含所有影响 advance 的样式字段，否则会串味 */
function cacheKey(char: string, style: TextStyle, textIndex?: number): string {
  return [
    char,
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.fontStyle,
    style.sourceFontName ?? "",
    textIndex === undefined ? "" : `@${textIndex}`,
  ].join("\u0001");
}

// ─────────────────────────────────────────────────────────────────────
//  Provider
// ─────────────────────────────────────────────────────────────────────

export class FontMetricsProvider {
  private readonly sources: Array<{ kind: AdvanceSource; fn: MetricsFn }>;
  private readonly fallback: (query: GlyphMetricsQuery) => number;
  private readonly cache = new Map<string, GlyphMetrics>();
  private readonly cacheLimit: number;
  private readonly hits: Record<AdvanceSource, number> = {
    "pdf-metrics": 0,
    "pdfsail-glyph": 0,
    "resolved-font": 0,
    canvas: 0,
    // ★ 4B-4H：兜底独立计数（修复前被混入 `canvas`）
    fallback: 0,
  };
  /** ★ 4B-4H：兜底策略的细分计数（observability） */
  private readonly fallbackHits: Record<FallbackKind, number> = {
    "east-asian-wide": 0,
    generic: 0,
    unknown: 0,
  };
  /** ★ 4B-4H(2)：provider 是否声明了至少一个 metrics source（决定 policy mode） */
  private readonly hasMetricsSource: boolean;
  /** ★ 4B-4H(2)：本 provider 的 fallback policy mode（构造期定，运行期不变） */
  private readonly fallbackPolicy: FallbackPolicy;
  readonly ascentRatio: number;
  readonly descentRatio: number;
  private readonly cacheIncludesTextIndex: boolean;

  constructor(options: FontMetricsProviderOptions = {}) {
    const provided: Record<AdvanceSource, MetricsFn | undefined> = {
      "pdf-metrics": options.pdfMetrics,
      "pdfsail-glyph": options.pdfsailGlyphMetrics,
      "resolved-font": options.resolvedFontMetrics,
      canvas: options.canvasMetrics,
    };
    // 顺序由 ADVANCE_SOURCE_ORDER 固定，调用方无法打乱 §18 优先级
    this.sources = ADVANCE_SOURCE_ORDER.filter((kind) => typeof provided[kind] === "function").map(
      (kind) => ({ kind, fn: provided[kind] as MetricsFn })
    );
    // ══ 4B-4H(2) · provider-aware fallback policy ═══════════════════════════
        //   ★ 语义分级（用户裁决）：不是「有没有 provider」这么粗，而是
        //      真实 metrics available?
        //        ├─ yes                       → 用真实 metrics（本层不兜底）
        //        └─ no → provider 有 source?  → yes ⇒ character-aware（本字符缺 provenance）
        //                                     → no  ⇒ legacy-generic（**全局**无 provenance）
        //
        //   ⚠️ `sources.length === 0` 的唯一生产来源是 `createFallbackMetrics()`
        //      （`createFontMetricsProvider({})`），用于 headless / export：
        //      `build-core-export-context` 调 `buildCoreRenderSourceFromDocument(document)`
        //      **不带 options** ⇒ 整个文本没有 glyph provenance。
        //      在那里启用 CJK 1em 会把「新增字符修复」扩大成「export 整体排版模型变更」
        //      （实测：export 的 CJK 行断行翻倍 ⇒ 第二行丢失行级字体身份）。
        this.hasMetricsSource = this.sources.length > 0;
        this.fallbackPolicy = this.hasMetricsSource ? "character-aware" : "legacy-generic";
        this.fallback =
          options.fallbackAdvance ??
          ((q) =>
            this.fallbackPolicy === "character-aware"
              ? // Mode A：CJK 1.0em / 其余 0.5em（修正新增 CJK 被低估 50%）
                characterAwareFallbackAdvance({ char: q.char, fontSize: q.style.fontSize })
              : // Mode B：**逐字节保持修复前的行为**
                Math.max(0, q.style.fontSize) * 0.5);
    this.cacheLimit = options.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.ascentRatio = options.ascentRatio ?? DEFAULT_ASCENT_RATIO;
    this.descentRatio = options.descentRatio ?? DEFAULT_DESCENT_RATIO;
    this.cacheIncludesTextIndex = options.cacheIncludesTextIndex ?? false;
  }

  /** 配置了哪些度量级（调试用） */
  get availableSources(): AdvanceSource[] {
    return this.sources.map((s) => s.kind);
  }

  measure(query: GlyphMetricsQuery): GlyphMetrics {
    const key = cacheKey(
      query.char,
      query.style,
      this.cacheIncludesTextIndex ? query.textIndex : undefined
    );
    const cached = this.cache.get(key);
    if (cached) return cached;

    let result: GlyphMetrics | null = null;
    for (const source of this.sources) {
      const value = source.fn(query);
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        result = { advance: value, advanceSource: source.kind };
        break;
      }
    }
    if (!result) {
      const value = this.fallback(query);
      // ★ 4B-4H：兜底**不再**伪装成 "canvas"（修复前是误标：实际无 canvas 参与）
      // ★ 4B-4H(2)：`legacy-generic` 模式下 **不启用** character-aware policy
      //   ⇒ `fallbackKind` 恒为 `generic`（即使字符是 CJK），policy 单独表达。
      const kind: FallbackKind =
        this.fallbackPolicy === "character-aware" ? fallbackKindOf(query.char) : "generic";
      result = {
        advance: Number.isFinite(value) && value >= 0 ? value : 0,
        advanceSource: "fallback",
        fallbackKind: kind,
        fallbackPolicy: this.fallbackPolicy,
      };
      this.fallbackHits[kind] += 1;
    }

    this.hits[result.advanceSource] += 1;
    if (this.cache.size >= this.cacheLimit) this.cache.clear();
    this.cache.set(key, result);
    return result;
  }

  /** 测量整段文本的 advance 序列（不含 letterSpacing） */
  measureText(chars: string[], style: TextStyle, startIndex = 0): GlyphMetrics[] {
    let index = startIndex;
    return chars.map((char) => {
      const m = this.measure({ char, textIndex: index, style });
      index += char.length;
      return m;
    });
  }

  /** §18 可观测性：各级命中次数 */
  stats(): Record<AdvanceSource, number> {
    return { ...this.hits };
  }

  /**
   * ★ 4B-4H 可观测性：兜底策略的细分命中次数。
   *   与 `stats().fallback` 的关系：`sum(fallbackStats()) === stats().fallback`。
   */
  fallbackStats(): Record<FallbackKind, number> {
    return { ...this.fallbackHits };
  }

  /**
   * ★ 4B-4H(2)：本 provider 的 fallback policy mode。
   *
   *   character-aware  provider 有 source（编辑 Core 路径）⇒ CJK 1.0em
   *   legacy-generic   provider 无 source（headless / export）⇒ 统一 0.5em
   */
  get policy(): FallbackPolicy {
    return this.fallbackPolicy;
  }

  /** provider 是否声明了至少一个 metrics source（模式判定的依据） */
  get hasSource(): boolean {
    return this.hasMetricsSource;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** 垂直度量（baseline / lineHeight），单位统一 px（006-A §18 结论） */
  resolveScale(style: TextStyle, fallbackLineHeightRatio = 1.3): ResolvedScale {
    const fontSize = style.fontSize;
    const lineHeight =
      style.lineHeight > 0 ? style.lineHeight : fontSize * fallbackLineHeightRatio;
    return {
      fontSize,
      lineHeight,
      letterSpacing: style.letterSpacing ?? 0,
    };
  }

  /** 行内文本的上升高度（px） */
  ascent(fontSize: number): number {
    return fontSize * this.ascentRatio;
  }

  /** 行内文本的下伸深度（px） */
  descent(fontSize: number): number {
    return fontSize * this.descentRatio;
  }
}

/**
 * 便捷构造：只用一个自定义度量函数（测试 / 单来源场景）。
 */
export function createFontMetricsProvider(
  options: FontMetricsProviderOptions = {}
): FontMetricsProvider {
  return new FontMetricsProvider(options);
}
