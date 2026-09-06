/**
 * DashboardModel — Sprint38 · S38-4B（Interface 已 Freeze）
 *
 * 展示模型（Presentation Model）：按"展示"组织，而非按"统计"组织。
 *
 *   ReplaySession ──► ReplayStatistics
 *   ReplaySession ──► ReplayVisualization
 *                         │
 *                 ┌───────┴────────┐
 *                 ▼                ▼
 *   ReplayStatistics + ReplayVisualization
 *                 │
 *                 ▼
 *         DashboardModelBuilder（零业务计算）
 *                 │
 *                 ▼
 *            DashboardModel
 *                 │
 *                 ▼
 *         DashboardRenderer（零计算）
 *                 │
 *                 ▼
 *      Markdown / HTML / Console / React
 *
 * 【CTO Review】
 *   - Must Fix：DashboardModelBuilder 只依赖 ReplayStatistics + ReplayVisualization，
 *     **绝不依赖 ReplaySession**。
 *   - Must Fix 2：runtime.avg/p95 从 visualization.elapsedSummary copy，Dashboard 零业务计算。
 *   - Should 3：trends 用 null（当前不存在）而非空数组（语义更准确）。
 *   - Should 2/4：RenderArtifact + DashboardRendererFactory。
 *
 * 【Presentation Composition Rule】
 *   所有 Builder / Composer 必须 Pure + Deterministic + Idempotent + Side-effect free。
 */

import type { ReplayStatistics } from "./replay-statistics";
import type { ReplayVisualization, ReplayRegression, RuntimeSummary } from "./replay-visualization";

/**
 * Dashboard Model — 按展示组织的完整 UI 数据模型（Interface 已 Freeze）。
 */
export interface DashboardModel {
  /** 汇总卡片 */
  summary: {
    /** 实验覆盖的 Evidence 数 */
    evidenceCount: number;
    /** 实际重放数（来自 ReplayStatistics.replayCount，统计指标） */
    replayCount: number;
    /** PASS 率 */
    passRate: number;
  };
  /** 质量卡片（Delta 分布） */
  quality: {
    avgDelta: number | null;
    medianDelta: number | null;
    p95Delta: number | null;
  };
  /**
   * 运行时卡片（Must Fix：从 Visualization 下沉，DashboardBuilder 零映射）。
   *
   * 直接引用 visualization.runtime（无需 elapsedSummary → runtime rename）。
   * 语义为 Runtime，未来 CPU / Memory / Replay Time / IO 属此。
   */
  runtime: RuntimeSummary;
  /** 回归卡片（由 visualization.regressions copy） */
  regressions: {
    /** 回归总数 */
    count: number;
    /** Top 10 最严重回归（按恶化量降序） */
    top: ReplayRegression[];
  };
  /** 覆盖率卡片 */
  coverage: {
    evidenceCount: number;
    validReplayCount: number;
    regressionRate: number;
    errorRate: number;
    unknownRate: number;
    improvementRate: number;
  };
  /**
   * 可视化数据（histogram / scatter / trend / heatmap ...）。
   * Renderer 直接消费，不再计算。
   */
  visualization: ReplayVisualization;
  /**
   * 趋势（预留，未来 Trend Analysis 填充）。
   *
   * null = 当前不存在（语义比空数组更准确）。
   */
  trends: null;
}

/**
 * Dashboard Model Builder —— 唯一职责：组合 Statistics + Visualization → DashboardModel。
 *
 * 只依赖两层数据（ReplayStatistics + ReplayVisualization），不依赖 ReplaySession。
 * 零业务计算：所有聚合值（runtime/quality/regressions）从输入直接 copy。
 */
export interface DashboardModelBuilder {
  build(stats: ReplayStatistics, visualization: ReplayVisualization): DashboardModel;
}

/** 当前 Artifact Schema 版本（Renderer 自己的 Freeze 边界） */
export const CURRENT_ARTIFACT_VERSION = 1;

/**
 * Render Artifact —— Renderer 的统一输出（Interface 已 Freeze）。
 *
 * content 类型按 type 而定：
 *   - markdown / html / console → content: string
 *   - react                    → content: ReactNode
 * 统一包一层，Markdown / HTML / Console / React 共用。
 */
export interface RenderArtifact {
  /**
   * Artifact Schema 版本（Recommend）。
   *
   * 与 metadata.rendererVersion 不同：
   *   - rendererVersion 是 Renderer 实现版本。
   *   - artifactVersion 是 Artifact Schema 自身版本。
   * 即使 rendererVersion 相同，Schema 也可能演进（Markdown v1 → v2）。
   */
  artifactVersion: number;
  /** 输出格式 */
  type: RendererKind;
  /** 内容（按 type 解释） */
  content: unknown;
  /** 元数据（Should 3：结构化，Renderer 输出可审计） */
  metadata: RenderArtifactMetadata;
}

/** Render Artifact 元数据（Renderer 输出应可审计） */
export interface RenderArtifactMetadata {
  /** 渲染生成时间 */
  generatedAt: string;
  /** Renderer 版本 */
  rendererVersion: string;
  /** Dashboard Schema 版本（1） */
  dashboardSchema: number;
}

/**
 * Renderer Context —— Renderer 的可选上下文（Should 5，Interface 已 Freeze）。
 *
 * 放 locale / timezone / theme 等展示选项，避免 Renderer 拆出
 * renderMarkdown() / renderChinese() / renderDark() 等方法。
 */
export interface RendererContext {
  /** 语言区域（如 "zh-CN" / "en-US"） */
  locale?: string;
  /** 时区（如 "Asia/Shanghai"） */
  timezone?: string;
  /** 主题（如 "light" / "dark"） */
  theme?: "light" | "dark";
}

/**
 * Dashboard Renderer —— 唯一职责：把 DashboardModel 输出为 RenderArtifact（S38-4C，Interface 已 Freeze）。
 *
 * 【边界】只有 render(model, context)，不允许 renderSummary() / renderHistogram() / renderStatistics()。
 *   否则 Renderer 会慢慢承担业务逻辑。
 */
export interface DashboardRenderer<T = RenderArtifact> {
  render(model: DashboardModel, context?: RendererContext): T;
}

/**
 * Renderer 类型标识。
 */
export type RendererKind = "markdown" | "html" | "console" | "react";

/**
 * Dashboard Renderer Factory —— 统一解析 Renderer（S38-4C，Interface 已 Freeze）。
 *
 * 用 resolve(kind)（语义更宽，未来可 Singleton / Pool / Cache / Lazy）。
 * Dashboard 永远 factory.resolve(kind)，不 new Renderer。
 */
export interface DashboardRendererFactory {
  resolve(kind: RendererKind): DashboardRenderer;
  /** 是否支持某类型 */
  supports(kind: RendererKind): boolean;
}

/**
 * 默认 Dashboard Model Builder。
 *
 * @param stats          已计算的 ReplayStatistics（聚合 rate / delta / replayCount）
 * @param visualization  已导出的 ReplayVisualization（histogram / regressions / elapsed / elapsedSummary）
 */
export const DefaultDashboardModelBuilder: DashboardModelBuilder = {
  build(stats: ReplayStatistics, visualization: ReplayVisualization): DashboardModel {
    return {
      summary: {
        evidenceCount: stats.coverage,
        replayCount: stats.replayCount,
        passRate: stats.passRate,
      },
      quality: {
        avgDelta: stats.averageDelta,
        medianDelta: stats.medianDelta,
        p95Delta: stats.p95Delta,
      },
      // Must Fix：直接从 visualization.runtime copy，零映射、零计算
      runtime: visualization.runtime,
      regressions: {
        count: visualization.regressions.length,
        top: visualization.regressions.slice(0, 10),
      },
      coverage: {
        evidenceCount: stats.coverage,
        validReplayCount: stats.validReplayCount,
        regressionRate: stats.regressionRate,
        errorRate: stats.errorRate,
        unknownRate: stats.unknownRate,
        improvementRate: stats.improvementRate,
      },
      visualization,
      trends: null,
    };
  },
};
