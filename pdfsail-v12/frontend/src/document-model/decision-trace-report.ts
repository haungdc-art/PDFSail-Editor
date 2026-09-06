/**
 * Decision Trace Report — Sprint37 · S37-2B（纯消费层）
 *
 *   GeometryDecisionTrace
 *        ↓
 *   Timeline Builder
 *        ↓
 *   TimelineModel
 *        ↓
 *   Markdown / JSON / HTML / Console
 *
 * 【纯消费层原则】
 *   - Renderer 只消费 GeometryDecisionTrace，不修改 Runtime，不反向依赖 Runtime。
 *   - 【Release Gate 1】Renderer 不 switch(stage) / if(stage==baseline)。
 *     stage 只用于 Timeline 标题，不用于分支。
 *   - 【Release Gate 3】version != 1 时 throw Unsupported Trace Version（不默默渲染错）。
 *
 * 【Architecture Rule】
 *   - Decision Trace is observational only. Runtime is the single source of truth.
 *   - Reports are derived artifacts and must never become an input to Runtime.
 */

import type { GeometryDecisionStep, GeometryDecisionTrace } from "./geometry-decision-trace";

/** 当前支持的 Trace version */
const SUPPORTED_VERSION = 1;

/**
 * Timeline Model（Release Gate 2）— 中性数据模型，可被多 Renderer 消费。
 *
 * Markdown / JSON / HTML / Console / React Timeline / Diff Viewer 都可直接消费。
 */
export interface TimelineStep {
  /** 阶段（只用于标题，不用于分支） */
  stage: string;
  /** 观察值 */
  observation?: unknown;
  /** 置信度 */
  confidence?: number;
  /** Decision Output */
  output?: unknown;
  /** Decision Cause */
  reason?: string;
}

export interface TimelineModel {
  /** Trace version（来自 trace，非 Report 自持） */
  version: number;
  documentId: string;
  page: number;
  finalRotation: number;
  confidence?: number;
  steps: TimelineStep[];
}

/**
 * Decision Trace Report 契约。
 */
export interface DecisionTraceReport {
  /** 构建 Timeline Model（中性） */
  toTimeline(trace: GeometryDecisionTrace): TimelineModel;
  /** 渲染 Markdown */
  toMarkdown(trace: GeometryDecisionTrace): string;
  /** 渲染 JSON */
  toJson(trace: GeometryDecisionTrace): string;
}

/** 构建 Timeline Model（不做任何 stage 分支，只映射统一 Schema） */
function buildTimeline(trace: GeometryDecisionTrace): TimelineModel {
  return {
    version: trace.version,
    documentId: trace.documentId,
    page: trace.page,
    finalRotation: trace.finalRotation,
    confidence: trace.confidence,
    steps: trace.steps.map((s: GeometryDecisionStep) => ({
      stage: s.stage,
      observation: s.observation,
      confidence: s.confidence,
      output: s.output,
      reason: s.reason,
    })),
  };
}

/** 单个 step 的 Markdown 行（统一 Schema，不分支 stage） */
function stepToMarkdown(step: TimelineStep): string {
  const obs = step.observation !== undefined ? `obs=${JSON.stringify(step.observation)}` : "";
  const conf = step.confidence !== undefined ? `conf=${step.confidence.toFixed(2)}` : "";
  const out = step.output !== undefined ? `out=${JSON.stringify(step.output)}` : "";
  const reason = step.reason ?? "";
  return `- **${step.stage}** ${obs} ${conf} ${out} (${reason})`;
}

/**
 * 默认 Decision Trace Report 实现（纯消费层，无状态）。
 */
export const DefaultDecisionTraceReport: DecisionTraceReport = {
  toTimeline(trace: GeometryDecisionTrace): TimelineModel {
    // 【Release Gate 3】version 检查，不默默渲染错
    if (trace.version !== SUPPORTED_VERSION) {
      throw new Error(`Unsupported Trace Version: ${trace.version}`);
    }
    return buildTimeline(trace);
  },

  toMarkdown(trace: GeometryDecisionTrace): string {
    const timeline = this.toTimeline(trace);
    const lines: string[] = [];
    lines.push(`## Decision Trace v${timeline.version} — ${timeline.documentId} page ${timeline.page}`);
    lines.push("");
    lines.push(`Final Rotation: ${timeline.finalRotation}°` + (timeline.confidence !== undefined ? ` (conf ${timeline.confidence.toFixed(2)})` : ""));
    lines.push("");
    lines.push("### Steps");
    lines.push("");
    for (const step of timeline.steps) {
      lines.push(stepToMarkdown(step));
    }
    lines.push("");
    return lines.join("\n");
  },

  toJson(trace: GeometryDecisionTrace): string {
    // version 检查与 toTimeline 一致
    const timeline = this.toTimeline(trace);
    return JSON.stringify(timeline, null, 2);
  },
};
