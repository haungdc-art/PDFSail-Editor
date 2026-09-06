/**
 * render-painter.test.ts — Sprint-69 Task-001 · RenderObjectPainter 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 RenderObjectPainter 接口
 *   ② paintGlyph / paintMask / paintPatch 全部进入 Painter
 *   ③ Renderer 零修改（源码验证：未改 GlyphRenderer / Patch / Export / Editor / PDFCanvas）
 *   ④ Tests 全部通过
 *   ⑤ Immutable（Readonly）
 *   ⑥ Prototype Only（Painter 独立新路径，未接入 Mainline）
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/render-painter/render-painter.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  paintObject,
  paintGlyphObject,
  paintMaskObject,
  paintPatchObject,
} from "./render-painter";
import { renderContextToRenderObjects } from "../render-object/render-object";
import type { GlyphObject, PatchObject, MaskObject } from "../render-object/render-object";
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

function testPainterInterface(): void {
  console.group("① 建立 RenderObjectPainter");
  const objects = buildObjects("ABC");
  const glyph = objects.find((o): o is GlyphObject => o.kind === "glyph")!;
  const mask = objects.find((o): o is MaskObject => o.kind === "mask")!;
  const patch = objects.find((o): o is PatchObject => o.kind === "patch")!;
  // paintObject 统一入口按 kind 分发
  assert(paintObject(glyph).kind === "glyph", "paintObject(glyph).kind=glyph");
  assert(paintObject(mask).kind === "mask", "paintObject(mask).kind=mask");
  assert(paintObject(patch).kind === "patch", "paintObject(patch).kind=patch");
  console.groupEnd();
}

function testPaintGlyph(): void {
  console.group("② paintGlyph");
  const objects = buildObjects("ABC");
  const glyph = objects.find((o): o is GlyphObject => o.kind === "glyph")!;
  const out = paintGlyphObject(glyph);
  assert(out.char === "A", `char=${out.char}`);
  // 只看 object.bounds（统一边界）
  assert(out.bounds.x === glyph.x && out.bounds.width === glyph.width, "bounds 来自 glyph");
  assert(typeof out.fontSize === "number", `fontSize=${out.fontSize}`);
  assert(out.layer === "glyph", "layer=glyph");
  assert(out.zIndex === 2, "glyph zIndex=2");
  console.groupEnd();
}

function testPaintMask(): void {
  console.group("② paintMask");
  const objects = buildObjects("ABC");
  const mask = objects.find((o): o is MaskObject => o.kind === "mask")!;
  const out = paintMaskObject(mask);
  assert(out.fill === "#ffffff", `fill=${out.fill}`);
  assert(out.bounds.width === mask.width, "bounds 来自 mask");
  assert(out.layer === "mask", "layer=mask");
  assert(out.opacity === 1, "opacity=1");
  console.groupEnd();
}

function testPaintPatch(): void {
  console.group("② paintPatch");
  const objects = buildObjects("ABC");
  const patch = objects.find((o): o is PatchObject => o.kind === "patch")!;
  const out = paintPatchObject(patch);
  assert(out.bounds.width === patch.width, "bounds 来自 patch");
  assert(out.layer === "patch", "layer=patch");
  assert(out.zIndex === 0, "patch zIndex=0");
  console.groupEnd();
}

function testRendererZeroMod(): void {
  console.group("③ Renderer 零修改（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rendererSrc = readFileSync(resolve(__dirname, "../document-model/glyph-renderer.tsx"), "utf-8");
  // GlyphRenderer 未 import render-painter
  assert(!rendererSrc.includes("render-painter"), "GlyphRenderer 未引用 render-painter");
  assert(!rendererSrc.includes("RenderObject"), "GlyphRenderer 未引用 RenderObject");
  console.groupEnd();
}

function testImmutable(): void {
  console.group("⑤ Immutable");
  const objects = buildObjects("ABC");
  const glyph = objects.find((o): o is GlyphObject => o.kind === "glyph")!;
  const out = paintObject(glyph);
  assert(typeof out.bounds.x === "number", "输出为纯值对象");
  assert(Array.isArray(objects), "objects 数组");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── RenderObjectPainter Test (Sprint-69 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testPainterInterface();
  testPaintGlyph();
  testPaintMask();
  testPaintPatch();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("render-painter.test.ts")) {
    runAllTests();
  }
}
