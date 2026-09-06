/**
 * trend-analyzer.ts — Fidelity Trend Analyzer（Sprint-80 Task-002）
 *
 * 把 History（时间序列）从"画曲线"升级为"预测收敛趋势"。
 * 基于线性回归外推，预测何时达到目标 Fidelity（如 99%）。
 *
 * 输入：History records（adobeFidelity + timestamp）
 * 输出：TrendAnalysis（斜率 / 预测到达时间 / 置信）
 *
 * 纯逻辑（ADR-005），不依赖 Renderer。
 */

/** 一条历史点 */
export interface TrendPoint {
  /** 序号（0,1,2,...），用于回归 x 轴 */
  readonly index: number;
  readonly fidelity: number;
  /** 可读标签（如 Sprint78 / date） */
  readonly label?: string;
}

/** 趋势分析结果 */
export interface TrendAnalysis {
  readonly points: readonly TrendPoint[];
  /** 线性回归斜率（每点/每 sprint 的 Fidelity 增量） */
  readonly slope: number;
  /** 截距 */
  readonly intercept: number;
  /** 相关系数 R²（0-1，拟合质量） */
  readonly rSquared: number;
  /** 当前（最新）Fidelity */
  readonly latest: number;
  /** 是否在上升（slope > 0） */
  readonly rising: boolean;
  /** 预测达到目标需要的点数（null = 下降或永不达到） */
  readonly sprintsToTarget: number | null;
  /** 达到目标后的预测 Fidelity */
  readonly predictedAtTarget: number | null;
  /** 目标 */
  readonly target: number;
  /** 达到目标的时间标签（若可预测） */
  readonly estimatedLabel: string | null;
}

/** 从 History（fidelity 数组）构造 TrendPoint */
export function toTrendPoints(
  fidelities: readonly number[],
  labels?: readonly (string | undefined)[],
): TrendPoint[] {
  return fidelities.map((f, i) => ({
    index: i,
    fidelity: f,
    label: labels?.[i],
  }));
}

/** 线性回归（最小二乘） */
export function linearRegression(
  points: readonly TrendPoint[],
): { slope: number; intercept: number; rSquared: number } {
  const n = points.length;
  if (n < 2) {
    return { slope: 0, intercept: points[0]?.fidelity ?? 0, rSquared: 0 };
  }
  const meanX = points.reduce((s, p) => s + p.index, 0) / n;
  const meanY = points.reduce((s, p) => s + p.fidelity, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.index - meanX) * (p.fidelity - meanY);
    den += (p.index - meanX) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = meanY - slope * meanX;

  // R²
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const pred = intercept + slope * p.index;
    ssRes += (p.fidelity - pred) ** 2;
    ssTot += (p.fidelity - meanY) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, rSquared };
}

/**
 * 分析 Fidelity 趋势并预测达到目标的时点。
 * @param points 历史点
 * @param target 目标 Fidelity（默认 99）
 */
export function analyzeTrend(points: readonly TrendPoint[], target = 99): TrendAnalysis {
  const { slope, intercept, rSquared } = linearRegression(points);
  const latest = points.length > 0 ? points[points.length - 1].fidelity : 0;

  let sprintsToTarget: number | null = null;
  let predictedAtTarget: number | null = null;
  if (slope > 0) {
    // 求解 intercept + slope * x = target → x = (target - intercept)/slope
    const xTarget = (target - intercept) / slope;
    const currentX = points.length > 0 ? points[points.length - 1].index : 0;
    sprintsToTarget = xTarget > currentX ? Math.ceil(xTarget - currentX) : 0;
    predictedAtTarget = target;
  }

  const estimatedLabel =
    sprintsToTarget !== null && points.length > 0
      ? `${(points[points.length - 1].label ?? `point${points.length}`)} + ${sprintsToTarget}`
      : null;

  return {
    points,
    slope,
    intercept,
    rSquared,
    latest,
    rising: slope > 0,
    sprintsToTarget,
    predictedAtTarget,
    target,
    estimatedLabel,
  };
}
