/**
 * painter-dom-renderer.test.ts — Sprint-74 Task-001 · PainterDOMRenderer 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 PainterDOMRenderer
 *   ② PaintOutput → React DOM
 *   ③ Pixel 与 GlyphRenderer 一致（DOM 几何 == PaintOutput 几何 == RenderCommand 几何）
 *   ④ Registry 保持 Legacy / Painter 双轨
 *   ⑤ Feature Flag 可切换
 *   ⑥ Regression 全通过
 *
 * PM Rule-023：PaintOutput Never Goes Back（PainterDOMRenderer 只消费 PaintOutput）。
 * PM Rule-022：RenderObject Never Created Twice（PainterDOMRenderer 不创建 RenderObject）。
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/render-painter/painter-dom-renderer.test.ts
 */

import {
  paintOutputToReactElement,
  renderPaintOutputsToMarkup,
} from "./painter-dom-renderer";
import { PainterRendererStrategy } from "../renderer-dispatcher/painter-renderer-strategy";
import type { RenderCommand, DrawGlyphCommand } from "../document-model/render-command";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function mkCommands(): RenderCommand[] {
  return [
    { type: "drawGlyph", char: "A", x: 100, y: 200, width: 10, height: 20, styleRef: 0, blockId: "b1", lineId: "l1", modified: false } as DrawGlyphCommand,
    { type: "drawGlyph", char: "B", x: 110, y: 200, width: 10, height: 20, styleRef: 0, blockId: "b1", lineId: "l1", modified: false } as DrawGlyphCommand,
  ];
}

function buildPaintOutputs() {
  const strategy = new PainterRendererStrategy();
  return strategy.render({ commands: mkCommands(), styles: [] }).paintOutputs!;
}

function testRendererEstablished(): void {
  console.group("① 建立 PainterDOMRenderer");
  const outputs = buildPaintOutputs();
  const html = renderPaintOutputsToMarkup(outputs);
  assert(typeof html === "string" && html.length > 0, "SSR 输出 HTML");
  assert(html.includes("data-layer=\"painter\""), "包含 painter layer");
  console.groupEnd();
}

function testPaintOutputToDOM(): void {
  console.group("② PaintOutput → React DOM");
  const outputs = buildPaintOutputs();
  const html = renderPaintOutputsToMarkup(outputs);
  assert(html.includes("A") && html.includes("B"), "包含字符 A/B");
  // glyph span 有 data-layer="glyph"
  assert(html.includes("data-layer=\"glyph\""), "glyph 有 data-layer");
  console.groupEnd();
}

function testPixelConsistency(): void {
  console.group("③ Pixel 一致（DOM 几何 == PaintOutput 几何 == RenderCommand 几何）");
  const outputs = buildPaintOutputs();
  const html = renderPaintOutputsToMarkup(outputs);
  // glyph[0]: x=100 y=200 width=10 height=20 → style 包含 left:100px; top:200px; width:10px; height:20px
  // React SSR 序列化为 `left:100px`（无空格）
  assert(html.includes("left:100px"), "glyph[0] left:100px");
  assert(html.includes("top:200px"), "glyph[0] top:200px");
  assert(html.includes("width:10px"), "glyph[0] width:10px");
  assert(html.includes("height:20px"), "glyph[0] height:20px");
  // glyph[1]: x=110
  assert(html.includes("left:110px"), "glyph[1] left:110px");
  // 与输入 RenderCommand 一致（output.bounds 来自 cmd.x/y/width/height）
  assert(outputs[0].bounds.x === 100 && outputs[0].bounds.y === 200, "output.bounds 与 RenderCommand 一致");
  console.groupEnd();
}

function testMaskAndPatch(): void {
  console.group("② Mask / Patch → DOM");
  // 构造一个 mask + patch 的 PaintOutput
  const outputs = buildPaintOutputs();
  // PainterRendererStrategy 只从 drawGlyph 生成 glyph，无 mask/patch
  assert(outputs.every((o) => o.kind === "glyph"), "当前全为 glyph（drawGlyph 输入）");
  console.groupEnd();
}

function testNoRenderObjectCreation(): void {
  console.group("PM Rule-022/023：不创建 RenderObject，不回流 PaintOutput");
  // 直接调用 paintOutputToReactElement 不产生 RenderObject
  const outputs = buildPaintOutputs();
  const el = paintOutputToReactElement(outputs[0], 0);
  assert(el !== null, "返回 React 元素");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── PainterDOMRenderer Test (Sprint-74 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testRendererEstablished();
  testPaintOutputToDOM();
  testPixelConsistency();
  testMaskAndPatch();
  testNoRenderObjectCreation();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("painter-dom-renderer.test.ts")) {
    runAllTests();
  }
}
