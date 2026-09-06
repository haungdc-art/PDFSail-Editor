/**
 * renderer-health.test.ts — Sprint-78 Task-004 · Renderer Health Dashboard 单元测试
 *
 * 验证：
 *   - computeRendererHealth 汇总 ShadowMetrics 为健康报告
 *   - health 判定（healthy/degraded/unhealthy）
 *   - RendererHealthPage SSR 输出（数据展示）
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-health/renderer-health.test.ts
 */

import { computeRendererHealth, toHealthRow } from "./renderer-health";
import { computeShadowMetrics } from "../renderer-dispatcher/shadow-metrics";
import type { GeomRecord } from "../renderer-dispatcher/shadow-metrics";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { RendererHealthPage } from "./RendererHealthPage";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function geom(x = 100): GeomRecord[] {
  return [{ x, y: 200, width: 10, height: 20, kind: "glyph" }];
}

function testHealthy(): void {
  console.group("① 全通过 → healthy");
  const m = computeShadowMetrics(geom(), geom());
  const report = computeRendererHealth([m, m]);
  assert(report.health === "healthy", "health=healthy");
  assert(report.passPages === 2 && report.failPages === 0, "2 pass 0 fail");
  assert(report.maxBBoxDiff === 0, "maxBBoxDiff=0");
  console.groupEnd();
}

function testDegraded(): void {
  console.group("② 有偏移 → degraded");
  const m = computeShadowMetrics(geom(), geom(105));
  const report = computeRendererHealth([m]);
  assert(report.health === "degraded", "health=degraded（bboxDiff>0.01）");
  assert(report.failPages === 1, "1 fail");
  console.groupEnd();
}

function testUnhealthy(): void {
  console.group("③ 有错误 → unhealthy");
  const m = computeShadowMetrics(geom(), geom());
  const report = computeRendererHealth([m], ["page1 render error"]);
  assert(report.health === "unhealthy", "health=unhealthy（有 errors）");
  assert(report.errors.length === 1, "errors=1");
  console.groupEnd();
}

function testAvgPaintTime(): void {
  console.group("④ avgPaintTime");
  const m1 = computeShadowMetrics(geom(), geom(), 2, 5);
  const m2 = computeShadowMetrics(geom(), geom(), 4, 8);
  const report = computeRendererHealth([m1, m2]);
  assert(report.avgPaintTime === 3, `avgPaintTime=${report.avgPaintTime}（(2+4)/2）`);
  console.groupEnd();
}

function testPageSSR(): void {
  console.group("⑤ RendererHealthPage SSR 输出");
  const m = computeShadowMetrics(geom(), geom(), 3, 6);
  const report = computeRendererHealth([m]);
  const html = renderToStaticMarkup(React.createElement(RendererHealthPage, { report }));
  assert(html.includes("Renderer Health"), "包含标题");
  assert(html.includes("healthy"), "包含健康状态");
  assert(html.includes("PASS"), "包含 PASS");
  assert(html.includes("data-testid=\"renderer-health\""), "包含 testid");
  console.groupEnd();
}

function testToHealthRow(): void {
  console.group("⑥ toHealthRow");
  const m = computeShadowMetrics(geom(), geom(), 1, 2);
  const row = toHealthRow(m, 3);
  assert(row.page === 3, "page=3");
  assert(row.legacyCount === 1 && row.painterCount === 1, "count 一致");
  assert(row.pass === true, "pass");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── Renderer Health Test (Sprint-78 Task-004) ──", "font-weight:bold;color:#8b5cf6;");
  testHealthy();
  testDegraded();
  testUnhealthy();
  testAvgPaintTime();
  testPageSSR();
  testToHealthRow();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}

// Node 直接运行支持（tsx：作为主模块执行时自动运行）
if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("renderer-health.test.ts")) {
    runAllTests();
  }
}
