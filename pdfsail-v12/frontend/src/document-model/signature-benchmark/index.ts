/**
 * Signature Benchmark — Sprint37 · S37-1A 入口
 *
 * 导出 Benchmark 基础设施：
 *   - benchmark.ts        类型定义（SignatureFixture / GeometrySnapshot / Config）
 *   - benchmark-runner.ts 执行 BenchmarkSuite（支持 official/regression/nightly/quick）
 *   - benchmark-report.ts 生成 Markdown Report
 *   - fixtures/official   官方测试集
 *
 * 【S37-1A 收口】仅新增，不修改任何 Geometry Runtime / Analyzer。
 */

export * from "./benchmark";
export * from "./benchmark-runner";
export * from "./benchmark-report";
export { officialFixtures } from "./fixtures/official";
