/**
 * Benchmark Report — Sprint37 · S37-1A
 *
 * 把 BenchmarkSummary 渲染为 Markdown Report。
 *
 *   BenchmarkSummary
 *        ↓
 *   renderMarkdown()
 *        ↓
 *   Markdown Report
 *
 * 【固定顺序（S37-1A）】Summary → Accuracy → Average Error → PASS → FAIL → Case Details。
 * Regression 一眼能看。
 *
 * 【S37-1A 收口】仅新增，不修改 Geometry Runtime。
 */

import type { BenchmarkSummary } from "./benchmark";

/**
 * 生成 Benchmark Markdown Report。
 *
 * @param summary Benchmark 汇总结果
 * @param suiteName 套件名（可选）
 */
export function renderMarkdown(
  summary: BenchmarkSummary,
  suiteName?: string,
  version?: string,
): string {
  const lines: string[] = [];

  lines.push("## Signature Rotation Benchmark");
  if (suiteName) {
    lines.push(`Suite: ${suiteName}`);
  }
  if (version) {
    lines.push(`Benchmark Version: ${version}`);
  }
  lines.push("");

  // Summary
  lines.push("### Summary");
  lines.push(`Total: ${summary.total}`);
  lines.push("");
  // Accuracy
  lines.push(`Accuracy: ${(summary.accuracy * 100).toFixed(1)}%`);
  // Average Error
  lines.push(`Average Rotation Error: ${summary.averageErrorDeg.toFixed(2)}°`);
  lines.push("");
  // PASS / FAIL
  lines.push(`PASS: ${summary.pass}`);
  lines.push(`FAIL: ${summary.fail}`);
  lines.push("");

  // Case Details
  lines.push("### Case Details");
  lines.push("");
  lines.push("| ID | Expected | Actual | Error | Duration | Result |");
  lines.push("|----|----------|--------|-------|----------|--------|");
  for (const c of summary.cases) {
    const expected = `${c.fixture.expectedRotation}°`;
    const actual = c.observation !== null ? `${c.observation.rotation.toFixed(1)}°` : "null";
    const error = c.errorDeg !== null ? `${c.errorDeg.toFixed(2)}°` : "-";
    const duration = `${c.durationMs.toFixed(0)}ms`;
    const result = c.pass ? "PASS" : "FAIL";
    lines.push(
      `| ${c.fixture.id} | ${expected} | ${actual} | ${error} | ${duration} | ${result} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}
