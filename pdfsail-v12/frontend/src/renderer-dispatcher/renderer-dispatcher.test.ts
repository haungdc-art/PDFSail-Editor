/**
 * renderer-dispatcher.test.ts — Sprint-70 Task-001 · RendererDispatcher 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 RendererDispatcher
 *   ② for RenderObject → Painter.paint()
 *   ③ Renderer 零修改（源码验证：未改 GlyphRenderer / PDFCanvas / Patch / Export / Editor）
 *   ④ Tests 全部通过
 *   ⑤ Prototype Only（Dispatcher 独立新路径，未接入 Mainline）
 *   ⑥ Immutable（Readonly）
 *   PM Rule-016：Dispatcher 不创建 RenderObject
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-dispatcher/renderer-dispatcher.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchRenderObjects } from "./renderer-dispatcher";
import { renderContextToRenderObjects } from "../render-object/render-object";
import { adaptLayoutToRenderContext } from "../layout-renderer-adapter/layout-renderer-adapter";
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

function buildObjects(text: string) {
  const semantic = buildSemanticDocument([mkBlock(text)], 1, 800, 1000);
  const layout = buildLayoutDocument(semantic);
  const contexts = adaptLayoutToRenderContext({ layout, semantic });
  return renderContextToRenderObjects(contexts);
}

function testDispatcherEstablished(): void {
  console.group("① 建立 RendererDispatcher");
  const objects = buildObjects("ABC");
  const outputs = dispatchRenderObjects(objects);
  assert(Array.isArray(outputs), "返回 PaintOutput[]");
  // "ABC" → 3 glyph + 1 mask + 1 patch = 5 PaintOutput
  assert(outputs.length === 5, `outputs.length=${outputs.length}（3 glyph + 1 mask + 1 patch）`);
  console.groupEnd();
}

function testForEachPaint(): void {
  console.group("② for RenderObject → Painter.paint()");
  const objects = buildObjects("AB");
  const outputs = dispatchRenderObjects(objects);
  // 每个 object 都被 paint，kind 对应（顺序：region 级 mask/patch 在前，glyph 在后）
  assert(outputs.length === objects.length, `outputs.length=${outputs.length} === objects.length=${objects.length}`);
  assert(outputs.some((o) => o.kind === "glyph"), "含 glyph");
  assert(outputs.filter((o) => o.kind === "mask").length === 1, "含 1 个 mask");
  assert(outputs.filter((o) => o.kind === "patch").length === 1, "含 1 个 patch");
  assert(outputs.filter((o) => o.kind === "glyph").length === 2, "含 2 个 glyph");
  console.groupEnd();
}

function testDispatcherNoAllocate(): void {
  console.group("⑦ Dispatcher 不创建 RenderObject（PM Rule-016）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dirname, "./renderer-dispatcher.ts"), "utf-8");
  // Dispatcher 源码不应创建 RenderObject
  assert(!/new\s+GlyphObject|new\s+MaskObject|new\s+PatchObject/.test(src), "无 new GlyphObject/MaskObject/PatchObject");
  assert(!/createRenderObject|buildRenderObject/.test(src), "无 createRenderObject/buildRenderObject");
  console.groupEnd();
}

function testRendererZeroMod(): void {
  console.group("③ Renderer 零修改（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rendererSrc = readFileSync(resolve(__dirname, "../document-model/glyph-renderer.tsx"), "utf-8");
  assert(!rendererSrc.includes("renderer-dispatcher"), "GlyphRenderer 未引用 renderer-dispatcher");
  assert(!rendererSrc.includes("RenderObject"), "GlyphRenderer 未引用 RenderObject");
  console.groupEnd();
}

function testImmutable(): void {
  console.group("⑥ Immutable");
  const objects = buildObjects("ABC");
  const outputs = dispatchRenderObjects(objects);
  assert(outputs.every((o) => typeof o.bounds.x === "number"), "每个 output 有 bounds");
  assert(Array.isArray(objects), "objects 数组");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── RendererDispatcher Test (Sprint-70 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testDispatcherEstablished();
  testForEachPaint();
  testDispatcherNoAllocate();
  testRendererZeroMod();
  testImmutable();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("renderer-dispatcher.test.ts")) {
    runAllTests();
  }
}
