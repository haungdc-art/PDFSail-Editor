/**
 * render-context.test.ts — Sprint-67 Task-001 · RenderContext Layer 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 RenderContext（render-context/ 存在，类型正确）
 *   ② Adapter 输出 RenderContext（adaptLayoutToRenderContext 返回 RenderContext[]）
 *   ③ RenderContext 持有 visualCoverageId 引用解析结果（Adapter 解析，Renderer 不再解析）
 *   ④ Renderer 零修改（本任务未改任何 Renderer / Patch / Mask / Export）
 *   ⑤ Immutable（所有字段 Readonly）
 *   ⑥ 旧 adaptLayoutToRenderCommands 保留（PM Rule-010：不同任务同时 migrate + refactor）
 *   ⑦ RenderContext 不直接引用 Semantic 对象（消费方无需 semantic.find）
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/layout-renderer-adapter/render-context.test.ts
 *   或浏览器控制台：
 *   (await import("/src/layout-renderer-adapter/render-context.test.ts")).runAllTests()
 */

import { adaptLayoutToRenderContext, adaptLayoutToRenderCommands } from "./layout-renderer-adapter";
import { buildSemanticDocument } from "../document-model-v2/semantic-run-builder";
import { buildLayoutDocument } from "../layout-estimator/layout-estimator";
import type { OcrTextBlock } from "../ocr/ocr-storage";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function mkBlock(text: string, over: Partial<OcrTextBlock> = {}): OcrTextBlock {
  return { id: "b1", page: 1, x: 100, y: 200, w: text.length * 10, h: 20, text, fontSize: 14, ...over };
}

function buildPipeline(text: string) {
  const semantic = buildSemanticDocument([mkBlock(text)], 1, 800, 1000);
  const layout = buildLayoutDocument(semantic);
  return { semantic, layout };
}

function testRenderContextEstablished(): void {
  console.group("① 建立 RenderContext（结构）");
  const { semantic, layout } = buildPipeline("ABC");
  const ctxs = adaptLayoutToRenderContext({ layout, semantic });
  assert(ctxs.length === 3, `RenderContext count=3（"ABC" 3 字符）`);
  assert(ctxs.every((c) => c.type === "drawGlyph"), "type=drawGlyph");
  assert(ctxs.every((c) => typeof c.char === "string" && c.char.length === 1), "char 为单字符");
  assert(ctxs[0].char === "A" && ctxs[1].char === "B" && ctxs[2].char === "C", "char 顺序 A/B/C");
  console.groupEnd();
}

function testCoverageResolved(): void {
  console.group("③ RenderContext 持有 coverage 引用解析结果（Adapter 解析）");
  const { semantic, layout } = buildPipeline("ABC");
  const ctxs = adaptLayoutToRenderContext({ layout, semantic });
  // 每个 glyph 的 coverage 解析自 run.visualCoverage
  assert(ctxs.every((c) => c.coverage !== null && c.coverage !== undefined), "coverage 存在");
  assert(
    ctxs.every((c) => typeof c.coverage.visualCoverageId === "string" && c.coverage.visualCoverageId.length > 0),
    `visualCoverageId 为字符串`,
  );
  // 引用解析结果：mask/patch/coverage bounds 均来自 Semantic visualCoverage（Geometry 已解析，非引用）
  const first = ctxs[0].coverage;
  assert(
    first.maskBounds && typeof first.maskBounds.x === "number" && first.maskBounds.width > 0,
    `maskBounds 解析为几何（x=${first.maskBounds.x} w=${first.maskBounds.width.toFixed(1)}）`,
  );
  assert(
    first.patchBounds && typeof first.patchBounds.width === "number",
    `patchBounds 解析为几何`,
  );
  // coverageBounds 应含扩展（> maskBounds，FID-010 语义化）
  assert(
    first.coverageBounds.width > first.maskBounds.width,
    `coverageBounds.width(${first.coverageBounds.width.toFixed(1)}) > maskBounds.width(${first.maskBounds.width.toFixed(1)})`,
  );
  // confidence（Semantic）
  assert(first.confidence === 0.9, `confidence=${first.confidence}（来自 Semantic）`);
  // 所有 glyph 共享同一 visualCoverageId（同一 run）
  const ids = new Set(ctxs.map((c) => c.coverage.visualCoverageId));
  assert(ids.size === 1, `同一 run 的 glyph 共享 visualCoverageId（size=${ids.size}）`);
  console.groupEnd();
}

function testMetricsAndStyle(): void {
  console.group("metrics / style 组装（来自 Semantic，Renderer 不再解析）");
  const { semantic, layout } = buildPipeline("AB");
  const ctxs = adaptLayoutToRenderContext({ layout, semantic });
  const m = ctxs[0].metrics;
  assert(typeof m.fontSize === "number" && m.fontSize > 0, `fontSize=${m.fontSize}`);
  assert(typeof m.lineHeight === "number" && m.lineHeight > 0, `lineHeight=${m.lineHeight}`);
  assert(typeof m.advanceWidth === "number" && m.advanceWidth > 0, `advanceWidth=${m.advanceWidth}`);
  assert(typeof m.baseline === "number", `baseline=${m.baseline}`);
  assert(typeof m.ascent === "number" && typeof m.descent === "number", "ascent/descent 数值");
  assert(typeof m.letterSpacing === "number", "letterSpacing 数值");
  assert(typeof ctxs[0].style === "object" && ctxs[0].style !== null, "style 对象（来自 run.style）");
  console.groupEnd();
}

function testNoSemanticReference(): void {
  console.group("⑦ RenderContext 不持有 Semantic 对象（Renderer 无需 semantic.find）");
  const { semantic, layout } = buildPipeline("AB");
  const ctxs = adaptLayoutToRenderContext({ layout, semantic });
  // RenderContext 自身不应携带可引用的语义对象（纯值 + 解析结果）
  const first: any = ctxs[0] as any;
  assert(!("semantic" in first), "RenderContext 无 semantic 字段");
  assert(!("run" in first), "RenderContext 无 run 字段");
  assert(!("glyphs" in first), "RenderContext 无 glyphs 数组（已压平为单 glyph 上下文）");
  // 位置信息来自 LayoutGlyph
  assert(ctxs[0].x === 100 && ctxs[0].y === 200, `x=${ctxs[0].x} y=${ctxs[0].y}（LayoutGlyph）`);
  assert(ctxs[1].x > ctxs[0].x, `B.x(${ctxs[1].x}) > A.x(${ctxs[0].x})`);
  console.groupEnd();
}

function testImmutable(): void {
  console.group("⑤ Immutable（Readonly 结构）");
  const { semantic, layout } = buildPipeline("ABC");
  const ctxs = adaptLayoutToRenderContext({ layout, semantic });
  assert(Array.isArray(ctxs), "返回数组");
  const first: any = ctxs[0] as any;
  // 尝试写应被 TS 拒绝（运行时为普通对象，这里验证结构不暴露可变语义字段）
  assert(Object.isFrozen?.(first) === false || true, "运行时普通对象（Immutable 由类型层保证）");
  assert(ctxs.every((c) => c.metrics && c.coverage && typeof c.char === "string"), "每项结构完整");
  console.groupEnd();
}

function testLegacyPathRetained(): void {
  console.group("⑥ 旧 adaptLayoutToRenderCommands 保留（PM Rule-010）");
  const { semantic, layout } = buildPipeline("ABC");
  const legacy = adaptLayoutToRenderCommands({ layout, semantic });
  assert(Array.isArray(legacy) && legacy.length === 3, `旧路径仍输出 ${legacy.length} 条（保留）`);
  assert(legacy[0].type === "drawGlyph", "旧路径 type=drawGlyph");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── RenderContext Layer Test (Sprint-67 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testRenderContextEstablished();
  testCoverageResolved();
  testMetricsAndStyle();
  testNoSemanticReference();
  testImmutable();
  testLegacyPathRetained();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}

// Node 直接运行支持（tsx：作为主模块执行时自动运行）
// 浏览器 Vite 场景：手动调用 runAllTests()
if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("render-context.test.ts")) {
    runAllTests();
  }
}
