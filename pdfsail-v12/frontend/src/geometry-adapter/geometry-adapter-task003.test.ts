/**
 * geometry-adapter-task003.test.ts — Sprint-67 Task-003 · Semantic Geometry Input 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① GeometryAdapter 输入改为 SemanticRun.visualCoverage
 *   ② 不再依赖 EditableBlock.originalBounds
 *   ③ DocumentRenderer 零修改（源码级验证：resolveMaskGeometry(block, rot) 调用保留）
 *   ④ RenderContext 不修改（源码级验证：render-context 未改）
 *   ⑤ Tests 全部通过
 *   ⑥ FID-010 回归测试：coverage 扩展 + rotation 覆盖原文（mask 覆盖完整文字区）
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/geometry-adapter/geometry-adapter-task003.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveMaskGeometryFromRun,
  resolveSemanticGeometry,
  resolveMaskGeometry,
} from "./geometry-adapter";
import { buildSemanticDocument } from "../document-model-v2/semantic-run-builder";
import type { OcrTextBlock } from "../ocr/ocr-storage";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function mkBlock(text: string, over: Partial<OcrTextBlock> = {}): OcrTextBlock {
  return { id: "b1", page: 1, x: 100, y: 200, w: text.length * 10, h: 20, text, fontSize: 14, ...over };
}

/** 从 block 构建 SemanticDocument，取第一个 run */
function buildRun(text: string, over: Partial<OcrTextBlock> = {}) {
  const semantic = buildSemanticDocument([mkBlock(text, over)], 1, 800, 1000);
  const run = semantic.pages[0].paragraphs[0].lines[0].runs[0];
  return { semantic, run };
}

function testInputIsSemantic(): void {
  console.group("① GeometryAdapter 输入改为 SemanticRun.visualCoverage");
  const { run } = buildRun("JEFERSON");
  const mask = resolveMaskGeometryFromRun(run);
  assert(mask !== null, "resolveMaskGeometryFromRun 返回非 null");
  assert(mask?.kind === "mask", "kind=mask");
  // blockId 来自 run.sourceId（Semantic），非 EditableBlock
  assert(mask?.blockId === "b1", `blockId=${mask?.blockId}（来自 run.sourceId）`);
  // coverage 来自 run.visualCoverage
  assert(mask?.source === "coverage", "source=coverage");
  console.groupEnd();
}

function testNoEditableBlockDependency(): void {
  console.group("② 不再依赖 EditableBlock.originalBounds");
  const { run } = buildRun("ABC");
  const mask = resolveMaskGeometryFromRun(run);
  // mask 几何完全来自 run.visualCoverage.coverageBounds（Semantic），
  // 不读 block.originalBounds
  assert(!!mask, "mask 存在");
  if (!mask) { console.groupEnd(); return; }
  // coverageBounds = 100-3=97, 200-3=197, w=30+6=36, h=20+6=26
  assert(Math.abs(mask.x - 97) < 0.01, `mask.x=${mask.x}（来自 coverageBounds.x-pad）`);
  assert(Math.abs(mask.width - 36) < 0.01, `mask.width=${mask.width}（coverage 扩展）`);
  console.groupEnd();
}

function testDocumentRendererZeroMod(): void {
  console.group("③ DocumentRenderer 零修改（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dirname, "../document-model/document-renderer.ts"), "utf-8");
  // document-renderer 仍调用 resolveMaskGeometry(block, rot)（EditableBlock 版），未被改动
  assert(src.includes("resolveMaskGeometry(block, rot)"), "document-renderer 调用 resolveMaskGeometry(block, rot)");
  // document-renderer 不应引用 resolveMaskGeometryFromRun（Task-003 不动它）
  assert(!src.includes("resolveMaskGeometryFromRun"), "document-renderer 未引用 Semantic 版入口");
  assert(!src.includes("SemanticRun"), "document-renderer 未引入 SemanticRun 类型");
  console.groupEnd();
}

function testRenderContextUnchanged(): void {
  console.group("④ RenderContext 不修改（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rc = readFileSync(resolve(__dirname, "../render-context/render-context.ts"), "utf-8");
  assert(rc.includes("interface RenderContext"), "render-context.ts 保留 RenderContext 接口");
  assert(rc.includes("RenderCoverage"), "render-context.ts 保留 RenderCoverage");
  // 未因 Task-003 改动（无 SemanticRun import）
  assert(!rc.includes("geometry-adapter"), "render-context 未依赖 geometry-adapter");
  console.groupEnd();
}

function testFid010Regression(): void {
  console.group("⑥ FID-010 回归：coverage 扩展 + rotation 覆盖原文");
  const { run } = buildRun("JEFERSON");
  // 无 rotation：mask 应覆盖 coverageBounds（扩展后），宽于原始 bbox
  const mask0 = resolveMaskGeometryFromRun(run)!;
  assert(mask0.width > 80, `无旋转 mask.width(${mask0.width}) > 原文宽度(80)`);
  // rotation 存在：mask 用旋转包围盒（宽高随旋转变化）
  const mask90 = resolveMaskGeometryFromRun(run, 90)!;
  assert(mask90.height > mask0.width * 0.9, `旋转90 mask.height(${mask90.height}) 显著增大`);
  // 与 EditableBlock 路径数值一致（coverageBounds == resolveVisualCoverageBounds(originalBounds)）
  const blockMask = resolveMaskGeometry(
    {
      id: "b1", type: "text",
      bbox: { x: 100, y: 200, width: 80, height: 20 },
      source: "ocr",
      originalBounds: { x: 100, y: 200, width: 80, height: 20 },
      lines: [], layoutMode: "preserve",
      transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    } as any,
    0,
  )!;
  assert(Math.abs(mask0.x - blockMask.x) < 0.01 && Math.abs(mask0.width - blockMask.width) < 0.01,
    `Semantic mask 与 EditableBlock mask 数值一致（x=${mask0.x} w=${mask0.width}）`);
  console.groupEnd();
}

function testResolveSemanticGeometry(): void {
  console.group("resolveSemanticGeometry 遍历 Semantic 输出 MaskGeometry[]");
  const { semantic } = buildRun("ABC", { id: "b2" });
  const results = resolveSemanticGeometry(semantic);
  assert(Array.isArray(results), "返回数组");
  assert(results.length === 1, `results.length=${results.length}（1 个 run → 1 个 mask）`);
  assert(results[0].kind === "mask", "结果类型为 mask");
  assert(results[0].blockId === "b2", `blockId=${results[0].blockId}`);
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── Semantic Geometry Input Test (Sprint-67 Task-003) ──", "font-weight:bold;color:#8b5cf6;");
  testInputIsSemantic();
  testNoEditableBlockDependency();
  testDocumentRendererZeroMod();
  testRenderContextUnchanged();
  testFid010Regression();
  testResolveSemanticGeometry();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("geometry-adapter-task003.test.ts")) {
    runAllTests();
  }
}
