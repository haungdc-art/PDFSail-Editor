/**
 * RenderDocument — Sprint38 · S38-4C-2（Interface 已 Freeze）
 *
 * 渲染中间文档：RenderComposer 把 DashboardModel 组织成 RenderDocument，
 * Renderer 只遍历 sections[] 输出，不拆解 DashboardModel。
 *
 *   DashboardModel
 *        ↓
 *   RenderComposer（Mutable）
 *        ↓
 *   RenderDocument（Frozen）
 *        ↓
 *   DashboardRenderer（只遍历 sections[]）
 *        ↓
 *   RenderArtifact
 *
 * 【CTO Review】
 *   - 避免未来 Markdown/Console/HTML/React/PDF 重复拆解 DashboardModel。
 *   - Renderer 不再关心 DashboardModel，只关心 RenderDocument。
 *   - 未来新增 Section（Trend/Timeline/Heatmap/Scatter）所有 Renderer 自动获得。
 *
 * 【Presentation Composition Rule】
 *   Composer 必须 Pure + Deterministic + Idempotent + Side-effect free。
 */

import type { DashboardModel } from "./replay-dashboard-model";

/**
 * Section 类型。
 */
export type RenderSectionType =
  | "summary"
  | "quality"
  | "coverage"
  | "runtime"
  | "regression"
  | "histogram";

/**
 * Render Section —— 一个可渲染区块（Frozen）。
 *
 * Renderer 遍历 sections[]，经 SectionRendererRegistry 分发给对应的 SectionRenderer，
 * 不拆 renderSummary() / renderHistogram() 等方法。
 */
export interface RenderSection<T = unknown> {
  /** Section 类型（kind） */
  type: RenderSectionType;
  /** 标题 */
  title: string;
  /** 结构化内容（按 type 解释） */
  data: T;
  /**
   * 顺序（Should 5）。
   *
   * 数组天然有序，但 TOC / Sort / Collapse / Reorder 需要显式 order，
   * 避免只能依赖数组顺序。
   */
  order: number;
  /**
   * Section Schema 版本（Should 3）。
   *
   * 单个 Section 升级不影响其他 Section（如 Summary v2 不影响 Histogram v1）。
   */
  schemaVersion: number;
}

/**
 * Render Document —— 一次渲染的完整文档（Frozen）。
 */
export interface RenderDocument {
  /** 文档标题 */
  title: string;
  /** Document Schema 版本（Should 2：Document 自己拥有 Schema，不依赖 metadata.schema） */
  documentVersion: number;
  /** Section 列表（Renderer 遍历） */
  sections: RenderSection[];
  /** 元数据（composerVersion 等） */
  metadata: RenderDocumentMetadata;
  /**
   * 扩展（Should 4）：TOC / Bookmarks / Anchors / Footnotes 等。
   * 未来 Plugin 填充。
   */
  extensions: Record<string, unknown>;
}

/** Render Document 元数据 */
export interface RenderDocumentMetadata {
  /** Composer 版本 */
  composerVersion: string;
  /** 生成者（Should 4：Debug 可知道 Document 由谁生成，如 "composer-v1"） */
  createdBy: string;
}

/** 当前 Composer 版本 */
export const CURRENT_COMPOSER_VERSION = "composer-v1";

/** 当前 RenderDocument Schema 版本 */
export const CURRENT_DOCUMENT_VERSION = 1;

/** 当前 Section Schema 版本 */
export const CURRENT_SECTION_VERSION = 1;

/**
 * Render Composer —— 唯一职责：把 DashboardModel 组织成 RenderDocument（Mutable）。
 *
 * （Should 1：Composer 拥有 version，便于 Pipeline Audit。）
 */
export interface RenderComposer {
  /** Composer 版本 */
  readonly version: string;
  compose(model: DashboardModel): RenderDocument;
}

/** Summary Section 数据 */
export interface SummarySectionData {
  evidenceCount: number;
  replayCount: number;
  passRate: number;
}

/** Quality Section 数据 */
export interface QualitySectionData {
  avgDelta: number | null;
  medianDelta: number | null;
  p95Delta: number | null;
}

/** Coverage Section 数据 */
export interface CoverageSectionData {
  validReplayCount: number;
  evidenceCount: number;
  regressionRate: number;
  errorRate: number;
  unknownRate: number;
  improvementRate: number;
}

/** Runtime Section 数据 */
export interface RuntimeSectionData {
  count: number;
  avgElapsedMs: number | null;
  medianElapsedMs: number | null;
  p95ElapsedMs: number | null;
}

/** 一条回归明细 */
export interface RegressionItemData {
  evidenceId: string;
  beforeDelta: number;
  afterDelta: number;
  regressionDelta: number;
}

/** Regression Section 数据（回归列表） */
export interface RegressionSectionData {
  /** 回归列表（按恶化量降序） */
  items: RegressionItemData[];
}

/** Histogram 单个桶数据 */
export interface HistogramBucketData {
  lower: number;
  upper: number | null;
  count: number;
}

/** Histogram Section 数据（桶列表 + 桶策略 id） */
export interface HistogramSectionData {
  /** 桶列表（按 lower 升序） */
  buckets: HistogramBucketData[];
  /** 桶策略 id（来自 visualization.metadata.bucketStrategyId） */
  bucketStrategyId: string;
}

/**
 * 默认 Render Composer（Should 1：含 version，便于 Pipeline Audit）。
 */
export const DefaultRenderComposer: RenderComposer = {
  version: CURRENT_COMPOSER_VERSION,
  compose(model: DashboardModel): RenderDocument {
    const s = model.summary;
    const q = model.quality;
    const c = model.coverage;
    const r = model.runtime;
    const hist = model.visualization.histogram;
    const bucketStrategyId = model.visualization.metadata.bucketStrategyId;

    const sections: RenderSection[] = [
      {
        type: "summary",
        title: "Summary",
        order: 0,
        schemaVersion: CURRENT_SECTION_VERSION,
        data: {
          evidenceCount: s.evidenceCount,
          replayCount: s.replayCount,
          passRate: s.passRate,
        } as SummarySectionData,
      },
      {
        type: "quality",
        title: "Quality",
        order: 1,
        schemaVersion: CURRENT_SECTION_VERSION,
        data: {
          avgDelta: q.avgDelta,
          medianDelta: q.medianDelta,
          p95Delta: q.p95Delta,
        } as QualitySectionData,
      },
      {
        type: "coverage",
        title: "Coverage",
        order: 2,
        schemaVersion: CURRENT_SECTION_VERSION,
        data: {
          validReplayCount: c.validReplayCount,
          evidenceCount: c.evidenceCount,
          regressionRate: c.regressionRate,
          errorRate: c.errorRate,
          unknownRate: c.unknownRate,
          improvementRate: c.improvementRate,
        } as CoverageSectionData,
      },
      {
        type: "runtime",
        title: "Runtime",
        order: 3,
        schemaVersion: CURRENT_SECTION_VERSION,
        data: {
          count: r.count,
          avgElapsedMs: r.avgElapsedMs,
          medianElapsedMs: r.medianElapsedMs,
          p95ElapsedMs: r.p95ElapsedMs,
        } as RuntimeSectionData,
      },
      {
        type: "regression",
        title: "Regressions",
        order: 4,
        schemaVersion: CURRENT_SECTION_VERSION,
        data: {
          items: model.regressions.top.map((reg) => ({
            evidenceId: reg.evidenceId,
            beforeDelta: reg.beforeDelta,
            afterDelta: reg.afterDelta,
            regressionDelta: reg.regressionDelta,
          })),
        } as RegressionSectionData,
      },
      {
        type: "histogram",
        title: "Histogram",
        order: 5,
        schemaVersion: CURRENT_SECTION_VERSION,
        data: {
          buckets: hist.buckets.map((b) => ({
            lower: b.lower,
            upper: b.upper,
            count: b.count,
          })),
          bucketStrategyId,
        } as HistogramSectionData,
      },
    ];

    return {
      title: "Replay Dashboard",
      documentVersion: CURRENT_DOCUMENT_VERSION,
      sections,
      metadata: {
        composerVersion: CURRENT_COMPOSER_VERSION,
        createdBy: CURRENT_COMPOSER_VERSION,
      },
      extensions: {},
    };
  },
};
