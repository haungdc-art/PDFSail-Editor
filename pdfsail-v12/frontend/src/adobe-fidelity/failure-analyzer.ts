/**
 * failure-analyzer.ts — Adobe Failure Analyzer（Sprint-80 Task-001）
 *
 * Mission：开始真正提升 Fidelity。不再只回答"为什么只有 94？"，
 * 而是回答"为什么？根因？修哪里？"。
 *
 * 输入：BenchmarkResult（+ 可选的 glyph 级 diff 数据）
 * 输出：FailureReport（每个维度：pass/fail + 原因 + 根因 + 修复建议 + 影响范围）
 *
 * 关键：不是 if/else 堆砌，而是建立 **Failure Tree**（分层判定影响范围）：
 *
 *   Rotation FAIL
 *     ↓ 影响范围（scope）
 *       single glyph? → 局部噪声/单个字形
 *       line?         → 行级估计误差
 *       paragraph?    → 段落级估计误差
 *       whole page?   → 全局旋转估计 / 页面级
 *     ↓ 可能根因 + 修复建议
 *
 * Scope：纯逻辑（ADR-005），不依赖 Renderer / DOM / Canvas。Node 可测。
 * 冻结纪律：不修改 Renderer / Painter / Dispatcher / Registry / Layout / Semantic / OCR。
 */

/**
 * BenchmarkResult 的最小输入契约（本模块自包含，避免耦合 tests/benchmark）。
 * 由 Sprint-79 Benchmark Runner 产出，字段语义与 tests/benchmark/benchmark-types.ts 对齐。
 */
export interface BenchmarkResultInput {
  readonly document: string;
  readonly category: string;
  readonly adobeGlyphCount: number;
  readonly painterGlyphCount: number;
  readonly glyphCountDiff: number;
  readonly bboxDiff: number | null;
  readonly rotationDiff: number | null;
  readonly coverageDiff: number | null;
  readonly baselineDiff: number | null;
  readonly pixelDiff: number | null;
  readonly pass: boolean;
  readonly complete: boolean;
  readonly failureReasons: readonly FailureReason[];
}

/** 失败原因分类（与 tests/benchmark 对齐；本地定义避免跨目录 import） */
export type FailureReason =
  | "GlyphLost"
  | "GlyphExtra"
  | "RotationMismatch"
  | "BBoxMismatch"
  | "BaselineMismatch"
  | "CoverageMismatch"
  | "PixelMismatch"
  | "FontFallback"
  | "ParagraphSplit"
  | "ImageDecode"
  | "OCRNoise"
  | "NoData";

/** 维度名（本模块分析的核心维度） */
export type MetricName =
  | "glyph"
  | "bbox"
  | "rotation"
  | "coverage"
  | "baseline"
  | "pixel";

/** 失败影响范围（Failure Tree 的分层判定） */
export type FailureScope =
  | "none"          // 该维度通过
  | "single-glyph"  // 单个/少量 glyph
  | "line"          // 整行
  | "paragraph"     // 整段
  | "whole-page"    // 整页
  | "no-data";      // 数据缺失

/** 根因分类（供 Fix Suggestion 映射） */
export type RootCause =
  | "none"
  | "rotation-estimator"       // 旋转估计器偏差
  | "typography-estimator"     // 字体/字号估计偏差
  | "coverage-estimator"       // coverage/mask/padding 估计偏差
  | "baseline-estimator"       // 基线估计偏差
  | "glyph-lost"               // glyph 丢失
  | "glyph-extra"              // 多出 glyph
  | "pixel-noise"              // 像素噪点
  | "ocr-noise"                // OCR 噪点
  | "data-missing";            // 数据缺失

/** 单个维度的分析结果 */
export interface DimensionAnalysis {
  readonly metric: MetricName;
  readonly pass: boolean;
  /** 失败原因（人类可读） */
  readonly reason: string;
  /** 影响范围 */
  readonly scope: FailureScope;
  /** 根因 */
  readonly rootCause: RootCause;
  /** 修复建议（映射到具体 Estimator） */
  readonly fixSuggestion: string;
  /** 相关 FailureReason */
  readonly failureReason: FailureReason | null;
}

/** FailureReport：整份文档的失败分析 */
export interface FailureReport {
  readonly document: string;
  readonly category: string;
  /** 是否整体通过 */
  readonly pass: boolean;
  /** 各维度分析 */
  readonly dimensions: ReadonlyArray<DimensionAnalysis>;
  /** 按维度索引 */
  readonly byMetric: Readonly<Record<string, DimensionAnalysis>>;
  /** 失败维度列表（按严重度排序） */
  readonly failures: ReadonlyArray<DimensionAnalysis>;
  /** 是否可修复（有具体根因，非 NoData） */
  readonly actionable: boolean;
}

/** glyph 级 diff 记录（供 Failure Tree 判定影响范围） */
export interface GlyphDiffRecord {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 该 glyph 的旋转偏差（度），仅当超阈值 */
  readonly rotationError?: number;
  /** 该 glyph 的 bbox 偏差（归一化） */
  readonly bboxError?: number;
  /** 该 glyph 是否参与 coverage */
  readonly coverage?: boolean;
  /** 该 glyph 的基线偏差（px） */
  readonly baselineError?: number;
}

/* ------------------------------------------------------------------ */
/* Failure Tree 判定（纯函数）                                          */
/* ------------------------------------------------------------------ */

/**
 * 根据 glyph 级偏差的分布判定影响范围。
 * 核心逻辑：偏差的分布决定是局部（single/line）还是全局（paragraph/whole-page）。
 * @param errors 各 glyph 的偏差（未超阈值的不计入）
 * @returns 影响范围
 */
export function classifyScope(
  errors: ReadonlyArray<number>,
  totalGlyphs: number,
): FailureScope {
  if (totalGlyphs === 0) return "no-data";
  const count = errors.length;
  if (count === 0) return "none";
  const ratio = count / totalGlyphs;
  // 仅按比例粗判：<5% 局部，<30% 行/段，否则全局
  if (ratio < 0.05) return "single-glyph";
  if (ratio < 0.15) return "line";
  if (ratio < 0.6) return "paragraph";
  return "whole-page";
}

/** 归一化：一批 glyph 偏差是否一致（用于区分"系统性" vs "随机噪声"） */
export function isSystematic(errors: ReadonlyArray<number>): boolean {
  if (errors.length === 0) return false;
  const mean = errors.reduce((s, v) => s + v, 0) / errors.length;
  const variance = errors.reduce((s, v) => s + (v - mean) ** 2, 0) / errors.length;
  const std = Math.sqrt(variance);
  // 偏差一致（低方差）→ 系统性估计误差；方差大 → 随机噪声
  return std < Math.abs(mean) * 0.5 || mean === 0;
}

/**
 * 核心分析函数：把 BenchmarkResult + glyph 级偏差转换为 FailureReport。
 * 对每个维度走 Failure Tree 判定 scope + rootCause + fixSuggestion。
 */
export function analyzeFailure(
  result: BenchmarkResultInput,
  glyphDiffs: ReadonlyArray<GlyphDiffRecord> = [],
): FailureReport {
  const totalGlyphs = Math.max(result.adobeGlyphCount, result.painterGlyphCount);

  const dims: DimensionAnalysis[] = [];

  // Glyph 维度
  dims.push(analyzeGlyph(result, totalGlyphs));

  // Rotation
  dims.push(
    analyzeDimension({
      metric: "rotation",
      pass: result.rotationDiff === null || result.rotationDiff <= 1,
      reason:
        result.rotationDiff === null
          ? "rotation 数据缺失"
          : `rotation error ${result.rotationDiff.toFixed(2)}° > 1°`,
      errors: glyphDiffs.map((g) => g.rotationError ?? 0).filter((v) => v > 0),
      totalGlyphs,
      failureReason: result.rotationDiff !== null && result.rotationDiff > 1 ? "RotationMismatch" : null,
      rootCauseOf: "rotation",
      totalDiff: result.rotationDiff,
    }),
  );

  // BBox
  dims.push(
    analyzeDimension({
      metric: "bbox",
      pass: result.bboxDiff === null || result.bboxDiff <= 0.01,
      reason:
        result.bboxDiff === null
          ? "bbox 数据缺失"
          : `width smaller ${(result.bboxDiff * 100).toFixed(0)}% diff`,
      errors: glyphDiffs.map((g) => g.bboxError ?? 0).filter((v) => v > 0),
      totalGlyphs,
      failureReason: result.bboxDiff !== null && result.bboxDiff > 0.01 ? "BBoxMismatch" : null,
      rootCauseOf: "bbox",
      totalDiff: result.bboxDiff,
    }),
  );

  // Coverage
  dims.push(
    analyzeDimension({
      metric: "coverage",
      pass: result.coverageDiff === null || result.coverageDiff <= 0.01,
      reason:
        result.coverageDiff === null
          ? "coverage 数据缺失"
          : `padding/coverage error ${(result.coverageDiff * 100).toFixed(1)}%`,
      errors: glyphDiffs.filter((g) => g.coverage).map((g) => g.bboxError ?? 0).filter((v) => v > 0),
      totalGlyphs,
      failureReason: result.coverageDiff !== null && result.coverageDiff > 0.01 ? "CoverageMismatch" : null,
      rootCauseOf: "coverage",
      totalDiff: result.coverageDiff,
    }),
  );

  // Baseline
  dims.push(
    analyzeDimension({
      metric: "baseline",
      pass: result.baselineDiff === null || result.baselineDiff <= 2,
      reason:
        result.baselineDiff === null
          ? "baseline 数据缺失"
          : `baseline error ${result.baselineDiff.toFixed(1)}px > 2px`,
      errors: glyphDiffs.map((g) => g.baselineError ?? 0).filter((v) => v > 0),
      totalGlyphs,
      failureReason: result.baselineDiff !== null && result.baselineDiff > 2 ? "BaselineMismatch" : null,
      rootCauseOf: "baseline",
      totalDiff: result.baselineDiff,
    }),
  );

  // Pixel
  dims.push(
    analyzeDimension({
      metric: "pixel",
      pass: result.pixelDiff === null || result.pixelDiff <= 1,
      reason:
        result.pixelDiff === null
          ? "pixel 数据缺失"
          : `pixel diff ${result.pixelDiff.toFixed(2)}% > 1%`,
      errors: [],
      totalGlyphs,
      failureReason: result.pixelDiff !== null && result.pixelDiff > 1 ? "PixelMismatch" : null,
      rootCauseOf: "pixel",
      totalDiff: result.pixelDiff,
    }),
  );

  const byMetric: Record<string, DimensionAnalysis> = {};
  for (const d of dims) byMetric[d.metric] = d;

  const failures = dims.filter((d) => !d.pass);
  const actionable = failures.some((f) => f.rootCause !== "data-missing");

  return {
    document: result.document,
    category: result.category,
    pass: result.pass,
    dimensions: dims,
    byMetric,
    failures,
    actionable,
  };
}

/* ------------------------------------------------------------------ */
/* 内部：单维度分析                                                   */
/* ------------------------------------------------------------------ */

interface DimensionArgs {
  metric: MetricName;
  pass: boolean;
  reason: string;
  errors: ReadonlyArray<number>;
  totalGlyphs: number;
  failureReason: FailureReason | null;
  rootCauseOf: "rotation" | "bbox" | "coverage" | "baseline" | "pixel";
  totalDiff: number | null;
}

function analyzeDimension(args: DimensionArgs): DimensionAnalysis {
  const { metric, pass, reason, errors, totalGlyphs, failureReason, rootCauseOf, totalDiff } = args;

  // 无数据 → no-data（pass=false：数据缺失不是 pass，杜绝 fake pass）
  if (totalDiff === null) {
    return {
      metric,
      pass: false,
      reason,
      scope: "no-data",
      rootCause: "data-missing",
      fixSuggestion: "采集真实数据后重新 Benchmark（当前数据缺失，不 fake）",
      failureReason,
    };
  }
  if (pass) {
    return { metric, pass, reason, scope: "none", rootCause: "none", fixSuggestion: "", failureReason: null };
  }

  // Failure Tree：判定影响范围
  const scope = classifyScope(errors, totalGlyphs);
  const systematic = isSystematic(errors);

  // 根因 + 修复建议（映射到 Estimator）
  const mapping: Record<typeof rootCauseOf, { root: RootCause; fix: string; cause: string }> = {
    rotation: {
      root: "rotation-estimator",
      fix: systematic
        ? "修复 RotationEstimator（系统性旋转偏差）"
        : "RotationEstimator 仅个别 glyph 抖动，检查单字形旋转判定",
      cause: `rotation error（影响 ${scope}，${systematic ? "系统性" : "随机抖动"}）`,
    },
    bbox: {
      root: "typography-estimator",
      fix: "修复 TypographyEstimator（字体/字号/字形宽度估计）",
      cause: `width smaller（影响 ${scope}）`,
    },
    coverage: {
      root: "coverage-estimator",
      fix: "修复 CoverageEstimator（mask/padding 估计）",
      cause: `padding/coverage（影响 ${scope}）`,
    },
    baseline: {
      root: "baseline-estimator",
      fix: "修复 BaselineEstimator（基线估计）",
      cause: `baseline error（影响 ${scope}）`,
    },
    pixel: {
      root: "pixel-noise",
      fix: "像素差异：检查噪点过滤 / mask / 渲染字体加载",
      cause: "pixel diff 超阈值",
    },
  };

  const m = mapping[rootCauseOf];
  return {
    metric,
    pass,
    reason,
    scope,
    rootCause: m.root,
    fixSuggestion: `${m.fix}（${m.cause}）`,
    failureReason,
  };
}

function analyzeGlyph(result: BenchmarkResultInput, totalGlyphs: number): DimensionAnalysis {
  const diff = result.glyphCountDiff;
  if (totalGlyphs === 0) {
    return {
      metric: "glyph",
      pass: false,
      reason: "无 glyph 数据",
      scope: "no-data",
      rootCause: "data-missing",
      fixSuggestion: "采集真实数据",
      failureReason: "NoData",
    };
  }
  if (diff === 0) {
    return { metric: "glyph", pass: true, reason: "glyph 数量一致", scope: "none", rootCause: "none", fixSuggestion: "", failureReason: null };
  }
  const root: RootCause = result.painterGlyphCount < result.adobeGlyphCount ? "glyph-lost" : "glyph-extra";
  return {
    metric: "glyph",
    pass: false,
    reason: `glyphCount ${result.adobeGlyphCount} vs ${result.painterGlyphCount}（差 ${diff}）`,
    scope: "whole-page",
    rootCause: root,
    fixSuggestion: root === "glyph-lost" ? "修复 glyph 丢失（OCR/布局阶段漏检）" : "检查多余 glyph（覆盖/清理）",
    failureReason: root === "glyph-lost" ? "GlyphLost" : "GlyphExtra",
  };
}
