/**
 * Geometry Decision Trace — Sprint37 · S37-2
 *
 * Story Goal: Explain every geometry decision instead of only reporting the final result.
 *
 * 不是"结果日志"（只记 rotation=89°），而是"决策日志"：
 *   - 记录每个阶段（Stage）的 Input → Output → Reason。
 *   - 回答"为什么得到 89°"，而非"最后得到 89°"。
 *
 * 【Done Definition】
 *   - 定义 GeometryDecisionStep / GeometryDecisionTrace。
 *   - Builder 提供 Stage API（业务代码不直接 append）。
 *   - 输出 JSON。
 *   - 【不修改】chooseGeometryStrategy() / signature-geometry-analyzer.ts / geometry-pipeline.ts 的判断逻辑。
 *   - 仅在现有流程增加记录点，不改变判断逻辑（Trace must be observationally pure）。
 */

/**
 * 几何决策阶段（Geometry Decision Stage）— 冻结的决策流水线阶段。
 *
 * 【按 Stage 而非按函数】Trace 跟着 Stage 走，不跟着函数走。
 * 算法怎么改（Baseline→PCA 变成 Baseline→Hough→PCA），
 * Stage 模型都不用改（只是某个 Stage 的实现变了）。
 */
export enum GeometryDecisionStage {
  /** OCR 提供的原始旋转角 */
  ProviderAngle = "provider-angle",
  /** 生成几何候选 */
  CandidateGeneration = "candidate-generation",
  /** baseline 估计 */
  Baseline = "baseline",
  /** PCA 角度 */
  PCA = "pca",
  /** 归一化旋转 */
  Normalize = "normalize",
  /** 选择检测策略 */
  StrategySelection = "strategy-selection",
}

/**
 * 几何决策原因（Geometry Decision Reason）— 枚举而非自由字符串。
 *
 * 便于 Report 自动国际化 / 统计（如 OCRMetadata 87%）。
 */
export enum GeometryDecisionReason {
  /** 来自 OCR 元数据 */
  FromOCRMetaData = "OCRMetadata",
  /** 来自图像分析 */
  ImageAnalysis = "ImageAnalysis",
  /** baseline 回归 */
  BaselineRegression = "BaselineRegression",
  /** PCA 特征向量 */
  PCAEigenVector = "PCAEigenVector",
  /** 候选被拒绝 */
  CandidateRejected = "CandidateRejected",
  /** 候选被接受 */
  CandidateAccepted = "CandidateAccepted",
  /** 角度规范化 */
  AngleNormalization = "AngleNormalization",
  /** 选择更高置信度 */
  HigherConfidence = "HigherConfidence",
}

/**
 * 单个决策步骤 — 一个几何决策阶段的记录。
 *
 * 每个阶段都有 Input → Output → Reason（而非只有 Result）。
 * 以后算法失败时，能直接回答"为什么这一阶段会做出这个决策"。
 */
/**
 * Observation Unit — 观察值的单位（冻结枚举，建议 A）。
 *
 *  - degree：旋转角度
 *  - score：置信度 / 评分
 *  - count：候选数量
 */
export type ObservationUnit = "degree" | "score" | "count" | "flag";

/**
 * Decision Output — 统一类型化输出（冻结）。
 *
 * 所有 Stage（Baseline / PCA / Normalize / StrategySelection）统一引用，
 * 避免各 Stage 的 output 结构漂移。
 * Report Generator 可直接读 step.output.angle。
 */
export interface GeometryDecisionOutput {
  /** 交给下一 Stage 的角度 */
  angle: number;
}

/**
 * Observation Value — 观察值的类型（建议 A）。
 *
 * number（角度/计数/评分）或 boolean（如 Strategy 的 HigherConfidence）。
 * 不用 unknown。
 */
export type ObservationValue = number | boolean;

/**
 * Geometry Observation — 结构化观察（非 unknown）。
 *
 * 【Must Fix 1】Observation 不是 Runtime Cache，是 Structured Observation。
 * 冻结 Schema：value + unit，Report 生成器无需写特殊判断。
 */
export interface GeometryObservation {
  /** 观察值（number 或 boolean） */
  value: ObservationValue;
  /** 单位（冻结枚举） */
  unit: ObservationUnit;
}

export interface GeometryDecisionStep {
  /** 阶段（冻结枚举） */
  stage: GeometryDecisionStage;
  /** 该阶段输入（可选） */
  input?: unknown;
  /** 结构化观察（"我观察到了什么"） */
  observation?: GeometryObservation;
  /** 置信度（可选） */
  confidence?: number;
  /** Decision Output（交给下一 Stage 的输出，非 observation 复制） */
  output?: unknown;
  /** 决策原因（枚举） */
  reason?: GeometryDecisionReason;
  /** 该阶段耗时（ms，可选） */
  elapsedMs?: number;
}

/**
 * 完整的几何决策追踪 — 一个 fixture/block 的决策全过程。
 */
export interface GeometryDecisionTrace {
  /** Observation Schema 版本（Follow-up 1，未来加 Stage 时递增，Report 可据此选择 Renderer） */
  version: 1;
  /** 文档 id */
  documentId: string;
  /** 页码 */
  page: number;
  /** 决策步骤列表 */
  steps: readonly GeometryDecisionStep[];
  /** 最终旋转角（度） */
  finalRotation: number;
  /** 置信度（可选） */
  confidence?: number;
}

/** ProviderAngle Stage 的输入参数 */
export interface ProviderAngleStep {
  /** Raw 角度（OCR 原始） */
  input: number | undefined;
  /** Normalized 角度（归一化后） */
  output: number | undefined;
  /** 原因（枚举） */
  reason: GeometryDecisionReason;
}

/**
 * CandidateGeneration Stage 的输入参数（只记录决策，不 dump 数据）。
 *
 * 【S37-2A-2 修正】只记录 generatedCount。
 *  - accepted/rejected 属于未来独立的 CandidateFiltering Stage（不是生成阶段的职责）。
 *  - One Stage observes only its own responsibility. Never observe downstream decisions.
 * 【不记录】Polygon / Mask / Pixels / Image。
 */
export interface CandidateGenerationStep {
  /** 生成的候选数量 */
  generatedCount: number;
  /** 原因 */
  reason: GeometryDecisionReason;
}

/**
 * Baseline Stage 的输入参数。
 * 统一格式：input → observation → confidence → output → reason。
 * 核心是"观察到了什么"，不是 Input。
 */
export interface BaselineStep {
  /** 输入（如候选数） */
  input?: unknown;
  /** 结构化观察（baseline 回归角度） */
  observation: GeometryObservation;
  /** 置信度 */
  confidence?: number;
  /** Decision Output（统一 GeometryDecisionOutput） */
  output: GeometryDecisionOutput;
  /** 原因（Decision Cause，如 BaselineRegression） */
  reason: GeometryDecisionReason;
}

/**
 * PCA Stage 的输入参数（沿用统一 Observation Pipeline）。
 * input → observation → confidence → output → reason。
 */
export interface PCAStep {
  /** 输入（如 baselineAngle） */
  input?: unknown;
  /** 结构化观察（PCA 特征角） */
  observation: GeometryObservation;
  /** 置信度 */
  confidence?: number;
  /** Decision Output（统一 GeometryDecisionOutput） */
  output: GeometryDecisionOutput;
  /** 原因（Decision Cause，如 PCAEigenVector） */
  reason: GeometryDecisionReason;
}

/**
 * Normalize Stage 的输入参数（S37-2A-5，沿用统一 Observation Pipeline）。
 *
 * Normalize 是第一个 observation 与 output 不同的 Stage：
 *   observation = 输入角度（如 -91°）
 *   output      = 规范化后的标准角度（如 269°）
 *
 * 【纪律】
 *   - confidence 为空（undefined）：Normalize 是确定性转换，非概率判断。
 *   - 不记录上游（providerAngle / baselineAngle / pcaAngle）：只回答"输入如何规范化为标准角度"。
 */
export interface NormalizeStep {
  /** 输入（待规范化的角度） */
  input: number;
  /** 结构化观察（规范化前的角度） */
  observation: GeometryObservation;
  /** Decision Output（规范化后的标准角度） */
  output: GeometryDecisionOutput;
  /** 原因（Decision Cause，如 AngleNormalization） */
  reason: GeometryDecisionReason;
}

/** Normalize Stage 的输入参数 */
export interface NormalizeStep {
  /** Raw 角度（归一化前） */
  input: number;
  /** Normalized 角度（归一化后） */
  output: number;
  /** 原因 */
  reason: GeometryDecisionReason;
}

/** StrategySelection Stage 的输入参数 */
/**
 * StrategySelection Stage 的输入参数（S37-2A-6，沿用统一 Observation Pipeline）。
 *
 * 只记录"选择获胜策略"的决策：
 *   - observation：Winning Candidate（boolean flag）
 *   - confidence：Winning Score
 *   - output：最终角度
 *   - reason：Decision Cause（如 HigherConfidence，非 SelectedPCA）
 * 【不记录】Rejected Candidates / Ranking / Sort / Comparator（属 Strategy Runtime，非 Observation）。
 */
export interface StrategySelectionStep {
  /** 输入（候选角度） */
  input?: unknown;
  /** 观察（Winning Candidate 是否选出） */
  observation: GeometryObservation;
  /** 置信度（Winning Score） */
  confidence?: number;
  /** Decision Output（最终角度） */
  output: GeometryDecisionOutput;
  /** 原因（Decision Cause） */
  reason: GeometryDecisionReason;
}

/**
 * Geometry Decision Trace Builder。
 *
 * 【Fix 1】业务代码不直接 append；Builder 提供 Stage API，是 Trace Schema 的唯一拥有者。
 * 未来 Step 增加字段（timestamp/thread/memory/executor）全部集中在 Builder，业务代码不改。
 *
 * Stateless（可复用）。
 */
export class GeometryDecisionTraceBuilder {
  private readonly steps: GeometryDecisionStep[] = [];

  /**
   * Internal only. Runtime must use Stage API.
   * 不要直接调用 append（违反"Never append directly. Observe through Stage API only"）。
   */
  private append(step: GeometryDecisionStep): this {
    this.steps.push(step);
    return this;
  }

  /**
   * ProviderAngle Stage。
   *
   * 【Fix 3】把 Raw（input）与 Normalized（output）分开，
   * 将来能看出 Normalize 在哪里发生（如 input=270 → output=-90）。
   */
  providerAngle(step: ProviderAngleStep): this {
    return this.append({
      stage: GeometryDecisionStage.ProviderAngle,
      input: step.input,
      output: step.output,
      reason: step.reason,
    });
  }

  /**
   * CandidateGeneration Stage（S37-2A-2）。
   *
   * 只记录 generatedCount（生成阶段的职责）。
   * 不观察 accepted/rejected（属于未来 CandidateFiltering Stage）。
   * Side-effect free（只 append，不影响 Runtime）。
   */
  candidateGeneration(step: CandidateGenerationStep): this {
    return this.append({
      stage: GeometryDecisionStage.CandidateGeneration,
      input: { generated: step.generatedCount },
      output: step.generatedCount,
      reason: step.reason,
    });
  }

  /**
   * Baseline Stage（S37-2A-3）。
   *
   * 统一格式：input → observation → confidence → output。
   * 只观察 baseline 自己的职责（regression angle / confidence），
   * 不观察下游（pcaAngle 禁止）。
   * Side-effect free。
   */
  baseline(step: BaselineStep): this {
    return this.append({
      stage: GeometryDecisionStage.Baseline,
      input: step.input,
      observation: step.observation,
      confidence: step.confidence,
      output: step.output,
      reason: step.reason,
    });
  }

  /**
   * PCA Stage（S37-2A-4）。
   *
   * 沿用统一 Observation Pipeline：input → observation → confidence → output → reason。
   * 只观察 PCA 自己的职责（eigenAngle / confidence），不观察下游（strategy 禁止）。
   * Side-effect free。
   */
  pca(step: PCAStep): this {
    return this.append({
      stage: GeometryDecisionStage.PCA,
      input: step.input,
      observation: step.observation,
      confidence: step.confidence,
      output: step.output,
      reason: step.reason,
    });
  }

  /**
   * Normalize Stage（S37-2A-5）。
   *
   * 沿用统一 Observation Pipeline：input → observation → output → reason。
   * confidence 为空（确定性转换，非概率判断）。
   * 不记录上游（provider/baseline/pca），只回答"输入如何规范化为标准角度"。
   * Side-effect free。
   */
  normalize(step: NormalizeStep): this {
    return this.append({
      stage: GeometryDecisionStage.Normalize,
      input: step.input,
      observation: step.observation,
      output: step.output,
      reason: step.reason,
    });
  }

  /** StrategySelection Stage（预留 No-op，S37-2A-6 实现） */
  /**
   * StrategySelection Stage（S37-2A-6）。
   *
   * 沿用统一 Observation Pipeline。只观察"选择获胜策略"的决策，
   * 不记录 Rejected/Ranking/Sort（属 Strategy Runtime）。
   * Side-effect free。
   */
  strategySelection(step: StrategySelectionStep): this {
    return this.append({
      stage: GeometryDecisionStage.StrategySelection,
      input: step.input,
      observation: step.observation,
      confidence: step.confidence,
      output: step.output,
      reason: step.reason,
    });
  }

  /**
   * 构建完整的 Decision Trace。
   *
   * @param documentId  文档 id
   * @param page        页码
   * @param finalRotation 最终旋转角
   * @param confidence  置信度（可选）
   */
  build(
    documentId: string,
    page: number,
    finalRotation: number,
    confidence?: number,
  ): GeometryDecisionTrace {
    return {
      version: 1,
      documentId,
      page,
      steps: [...this.steps],
      finalRotation,
      confidence,
    };
  }

  /** 当前步骤数（只读） */
  get stepCount(): number {
    return this.steps.length;
  }
}

/**
 * 便捷函数：创建新 Trace Builder。
 */
export function createDecisionTrace(): GeometryDecisionTraceBuilder {
  return new GeometryDecisionTraceBuilder();
}
