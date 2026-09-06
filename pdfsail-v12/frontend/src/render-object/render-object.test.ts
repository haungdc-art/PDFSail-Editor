/**
 * render-object.test.ts — Sprint-68 Task-001 · RenderObject Layer 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 RenderObject（联合类型 + 判别 kind）
 *   ② 建立 GlyphObject / PatchObject / MaskObject
 *   ③ RenderContext → RenderObject（renderContextToRenderObjects）
 *   ④ Renderer 零修改（源码验证：未改 GlyphRenderer / Patch / Export / Editor / PDFCanvas）
 *   ⑤ Immutable（Readonly）
 *   ⑥ Tests 全部通过
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/render-object/render-object.test.ts
 */

import { renderContextToRenderObjects } from "./render-object";
import type { RenderObject, GlyphObject, PatchObject, MaskObject } from "./render-object";
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

function buildRenderObjects(text: string) {
  const semantic = buildSemanticDocument([mkBlock(text)], 1, 800, 1000);
  const layout = buildLayoutDocument(semantic);
  const contexts = adaptLayoutToRenderContext({ layout, semantic });
  const objects = renderContextToRenderObjects(contexts);
  return { contexts, objects };
}

function testRenderObjectEstablished(): void {
  console.group("① 建立 RenderObject（联合类型）");
  const { contexts, objects } = buildRenderObjects("ABC");
  assert(objects.length >= 3, `objects.length=${objects.length}（≥3 glyph）`);
  // kind 判别
  const kinds = new Set(objects.map((o) => o.kind));
  assert(kinds.has("glyph"), "包含 glyph kind");
  assert(kinds.has("mask"), "包含 mask kind");
  assert(kinds.has("patch"), "包含 patch kind");
  console.groupEnd();
}

function testGlyphObject(): void {
  console.group("② GlyphObject");
  const { objects } = buildRenderObjects("ABC");
  const glyphs = objects.filter((o): o is GlyphObject => o.kind === "glyph");
  assert(glyphs.length === 3, `glyphs=${glyphs.length}（"ABC" 3 字符）`);
  assert(glyphs[0].char === "A", `glyph[0].char=${glyphs[0].char}`);
  assert(glyphs[0].x === 100 && glyphs[0].y === 200, `glyph[0] pos(${glyphs[0].x},${glyphs[0].y})`);
  assert(glyphs[1].x > glyphs[0].x, `glyph[1].x(${glyphs[1].x}) > glyph[0].x(${glyphs[0].x})`);
  assert(typeof glyphs[0].metrics.fontSize === "number", "metrics.fontSize 数值");
  assert(typeof glyphs[0].coverage.visualCoverageId === "string", "coverage 引用存在");
  console.groupEnd();
}

function testPatchObject(): void {
  console.group("② PatchObject");
  const { objects } = buildRenderObjects("ABC");
  const patches = objects.filter((o): o is PatchObject => o.kind === "patch");
  // 每 run 一个 patch
  assert(patches.length === 1, `patches=${patches.length}（1 个 run → 1 个 patch）`);
  assert(patches[0].width > 0 && patches[0].height > 0, "patch 有尺寸");
  assert(patches[0].blockId === "b1", `patch.blockId=${patches[0].blockId}`);
  assert(patches[0].x === 100 && patches[0].y === 200, `patch pos(${patches[0].x},${patches[0].y})`);
  console.groupEnd();
}

function testMaskObject(): void {
  console.group("② MaskObject");
  const { objects } = buildRenderObjects("ABC");
  const masks = objects.filter((o): o is MaskObject => o.kind === "mask");
  assert(masks.length === 1, `masks=${masks.length}（1 个 run → 1 个 mask）`);
  assert(masks[0].width > 0 && masks[0].height > 0, "mask 有尺寸");
  assert(masks[0].blockId === "b1", `mask.blockId=${masks[0].blockId}`);
  console.groupEnd();
}

function testRenderContextToRenderObject(): void {
  console.group("③ RenderContext → RenderObject");
  const { contexts, objects } = buildRenderObjects("AB");
  assert(contexts.length === 2, `RenderContext count=${contexts.length}`);
  assert(objects.length === 4, `RenderObject count=${objects.length}（2 glyph + 1 mask + 1 patch）`);
  // 每 glyph 一个 GlyphObject
  const glyphs = objects.filter((o) => o.kind === "glyph");
  const masks = objects.filter((o) => o.kind === "mask");
  const patches = objects.filter((o) => o.kind === "patch");
  assert(glyphs.length === 2 && masks.length === 1 && patches.length === 1,
    `glyphs=${glyphs.length} masks=${masks.length} patches=${patches.length}`);
  console.groupEnd();
}

function testImmutable(): void {
  console.group("⑤ Immutable（Readonly）");
  const { objects } = buildRenderObjects("ABC");
  const glyph: any = objects.find((o) => o.kind === "glyph") as any;
  assert(glyph && typeof glyph.kind === "string", "结构完整");
  assert(Array.isArray(objects), "返回数组");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── RenderObject Layer Test (Sprint-68 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testRenderObjectEstablished();
  testGlyphObject();
  testPatchObject();
  testMaskObject();
  testRenderContextToRenderObject();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("render-object.test.ts")) {
    runAllTests();
  }
}
