/**
 * Signature Benchmark — Sprint37 · S37-1A
 *
 * 固定一套可重复验证的签名旋转测试集。
 *
 * 【Benchmark 定位】Benchmark 不是 Geometry Domain。
 *   - 只做 Input → Execute → Compare → Report。
 *   - 【不定义】自己的 Geometry 类型（Polygon 等），不拥有 Geometry。
 *   - 通过注入的 BenchmarkExecutor 获取 GeometrySnapshot，单向依赖 Geometry。
 *
 * 【S37-1A 收口】仅新增，不修改任何 Runtime / Geometry / Analyzer。
 */

/**
 * Geometry Observation — 一个 fixture 的几何检测观察结果。
 *
 * 语义上叫 Observation（观察结果）而非 Snapshot，避免与 Sprint36 的
 * Runtime/Immutable Snapshot 混淆。Benchmark 不是 Snapshot，只是观察。
 *
 * Benchmark 不定义 Geometry 类型；未来 Geometry 的 Polygon/Transform 可扩展此 Observation。
 */
export interface GeometryObservation {
  /** 检测到的旋转角（度） */
  rotation: number;
  /** 多边形（可选，未来扩展） */
  polygon?: unknown;
  /** 变换矩阵（可选，未来扩展） */
  transform?: number[];
  /** 置信度（可选） */
  confidence?: number;
}

/**
 * Signature Fixture — 一个签名旋转测试样例。
 */
export interface SignatureFixture {
  /** 唯一 id */
  id: string;
  /** 资源路径（PDF / PNG / JPG / JSON / snapshot，生命周期长于"PDF"） */
  resource: string;
  /** 页码 */
  page: number;
  /** 期望旋转角（度） */
  expectedRotation: number;
  /** 期望多边形（可选，不绑定 Geometry 具体类型） */
  expectedPolygon?: unknown;
  /** 描述 */
  description: string;
}

/**
 * Benchmark 执行器契约 — 由调用方注入。
 *
 * Benchmark 不修改 Geometry，只调用 Executor 获取 GeometrySnapshot。
 * 未来 Rotation / Polygon / Transform / Confidence 全部可从 Snapshot 扩展。
 */
export interface BenchmarkExecutor {
  /** 执行给定 fixture 的几何检测，返回观察结果 */
  execute(fixture: SignatureFixture): GeometryObservation | null;
}

/**
 * Benchmark 配置 — 容差等可调参数。
 *
 * 不写死 1°；可通过 BenchmarkConfig 调整（如 0.3°），Benchmark 不用改。
 */
export interface BenchmarkConfig {
  /** 配置版本（如 "S37"），供 Report 标记 Benchmark Version */
  version: string;
  /** 旋转角容差（度） */
  rotationTolerance: number;
  /** 多边形容差（预留） */
  polygonTolerance?: number;
  /** 变换矩阵容差（预留） */
  transformTolerance?: number;
}

/** 单个 fixture 的执行结果 */
export interface BenchmarkCaseResult {
  fixture: SignatureFixture;
  /** 实际检测到的几何观察 */
  observation: GeometryObservation | null;
  /** 是否通过（实际 ≈ 期望，容差内） */
  pass: boolean;
  /** 绝对误差（度） */
  errorDeg: number | null;
  /** 执行耗时（ms） */
  durationMs: number;
}

/** Benchmark 汇总结果 */
export interface BenchmarkSummary {
  total: number;
  pass: number;
  fail: number;
  accuracy: number; // 0-1
  averageErrorDeg: number;
  cases: BenchmarkCaseResult[];
}
