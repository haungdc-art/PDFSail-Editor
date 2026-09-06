/**
 * Benchmark Runner — Sprint37 · S37-1A
 *
 * 执行 BenchmarkSuite，对比 expected vs actual，生成 BenchmarkSummary。
 *
 *   fixtures + BenchmarkExecutor + BenchmarkConfig
 *        ↓
 *   runBenchmark()
 *        ↓
 *   BenchmarkSummary（PASS / FAIL / Accuracy / Avg Error）
 *
 * 【S37-1A 收口】仅新增，不修改 Geometry Runtime。
 * - 容差不写死，来自 BenchmarkConfig。
 * - Runner 支持 BenchmarkSuite（official / regression / nightly / quick）。
 */

import type {
  BenchmarkCaseResult,
  BenchmarkConfig,
  BenchmarkExecutor,
  BenchmarkSummary,
  SignatureFixture,
} from "./benchmark";

/**
 * Benchmark Suite — 一组 fixture + 配置。
 *
 * 支持多个套件：official / regression / nightly / quick。
 */
export interface BenchmarkSuite {
  /** 套件名 */
  name: "official" | "regression" | "nightly" | "quick" | string;
  /** 套件包含的 fixtures */
  fixtures: SignatureFixture[];
  /** 套件配置 */
  config: BenchmarkConfig;
}

/** 默认配置 */
const DEFAULT_CONFIG: BenchmarkConfig = {
  version: "S37",
  rotationTolerance: 1.0,
};

/** 单个 fixture 的执行结果 */
function runCase(
  fixture: SignatureFixture,
  executor: BenchmarkExecutor,
  config: BenchmarkConfig,
): BenchmarkCaseResult {
  const start = performance.now();
  let observation = null;
  try {
    observation = executor.execute(fixture);
  } catch {
    observation = null;
  }
  const durationMs = performance.now() - start;

  let errorDeg: number | null = null;
  let pass = false;
  if (observation) {
    errorDeg = Math.abs(observation.rotation - fixture.expectedRotation);
    pass = errorDeg <= config.rotationTolerance;
  }

  return { fixture, observation, pass, errorDeg, durationMs };
}

/**
 * 执行一个 BenchmarkSuite，生成 BenchmarkSummary。
 *
 * @param suite 测试套件（fixtures + config）
 * @param executor 执行器（由调用方注入）
 */
export function runBenchmark(suite: BenchmarkSuite, executor: BenchmarkExecutor): BenchmarkSummary {
  const { fixtures, config } = suite;
  const cases = fixtures.map((f) => runCase(f, executor, config));
  const pass = cases.filter((c) => c.pass).length;
  const total = cases.length;
  const errorDegs = cases
    .map((c) => c.errorDeg)
    .filter((e): e is number => e !== null);
  const averageErrorDeg =
    errorDegs.length > 0
      ? errorDegs.reduce((a, b) => a + b, 0) / errorDegs.length
      : 0;

  return {
    total,
    pass,
    fail: total - pass,
    accuracy: total > 0 ? pass / total : 0,
    averageErrorDeg,
    cases,
  };
}

/** 从 fixtures 构建一个 official suite（默认配置） */
export function officialSuite(fixtures: SignatureFixture[]): BenchmarkSuite {
  return { name: "official", fixtures, config: DEFAULT_CONFIG };
}
