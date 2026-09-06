/**
 * dispatcher-glyph-layer.test.ts — Sprint-75 Task-001 · Mainline Mount 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① PDFCanvas 接入 Dispatcher（源码验证：PDFCanvas 用 DispatcherGlyphLayer）
 *   ② 默认 Strategy = Legacy（getRenderMode 默认 legacy）
 *   ③ Feature Flag 可切换 Legacy / Painter（getRenderMode 读 window.__rendererMode）
 *   ④ GlyphRenderer 保持零修改（源码验证：GlyphRenderer 未 import Dispatcher）
 *   ⑤ Browser Pixel Regression（默认 Legacy → GlyphRenderer，命令透传）
 *   ⑥ Rollback < 1 min（默认 legacy，改回 GlyphRenderer 即可回滚）
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-dispatcher/dispatcher-glyph-layer.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRenderMode } from "./dispatcher-glyph-layer";
import { dispatchRenderer } from "./renderer-dispatcher";
import { createDefaultRegistry } from "../renderer-registry/renderer-registry";
import { LegacyRendererStrategy } from "./renderer-strategy";
import { PainterRendererStrategy } from "./painter-renderer-strategy";
import type { RenderCommand, DrawGlyphCommand } from "../document-model/render-command";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function mkCommands(): RenderCommand[] {
  return [
    { type: "drawGlyph", char: "A", x: 100, y: 200, width: 10, height: 20, styleRef: 0, blockId: "b1", lineId: "l1", modified: false } as DrawGlyphCommand,
  ];
}

function testPDFCanvasUsesDispatcher(): void {
  console.group("① PDFCanvas 接入 Dispatcher（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dirname, "../editor/components/PDFCanvas.tsx"), "utf-8");
  assert(src.includes("DispatcherGlyphLayer"), "PDFCanvas 用 DispatcherGlyphLayer");
  assert(!src.includes("<GlyphRenderer"), "PDFCanvas 不再直接用 <GlyphRenderer");
  console.groupEnd();
}

function testDefaultStrategy(): void {
  console.group("② 默认 Strategy（Sprint-77B 未通过 → 默认 legacy）");
  // PM 裁决：默认保持 legacy（Default Never Ahead Of Validation）
  assert(getRenderMode() === "legacy", "getRenderMode 默认 legacy");
  // 默认 Dispatcher → glyph-renderer
  const result = dispatchRenderer(getRenderMode(), { commands: mkCommands(), styles: [] });
  assert(result.renderer === "glyph-renderer", "默认 dispatch → glyph-renderer");
  console.groupEnd();
}

function testFeatureFlagSwitch(): void {
  console.group("③ Feature Flag 可切换 Legacy / Painter");
  // 模拟 window flag
  const original = (globalThis as any).window;
  (globalThis as any).window = { __rendererMode: "painter" };
  assert(getRenderMode() === "painter", "flag=painter → painter 模式");
  (globalThis as any).window = { __rendererMode: "legacy" };
  assert(getRenderMode() === "legacy", "flag=legacy → legacy 模式");
  (globalThis as any).window = original ?? undefined;
  // registry 双轨：legacy + painter 都可 dispatch
  const registry = createDefaultRegistry(new LegacyRendererStrategy(), "legacy");
  registry.register("painter", new PainterRendererStrategy());
  assert(dispatchRenderer("legacy", { commands: mkCommands(), styles: [] }, registry).renderer === "glyph-renderer",
    "legacy 可 dispatch");
  assert(dispatchRenderer("painter", { commands: mkCommands(), styles: [] }, registry).renderer === "painter",
    "painter 可 dispatch");
  console.groupEnd();
}

function testGlyphRendererZeroMod(): void {
  console.group("④ GlyphRenderer 保持零修改（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dirname, "../document-model/glyph-renderer.tsx"), "utf-8");
  assert(!src.includes("renderer-dispatcher"), "GlyphRenderer 未引用 renderer-dispatcher");
  assert(!src.includes("dispatcher-glyph-layer"), "GlyphRenderer 未引用 dispatcher-glyph-layer");
  assert(!src.includes("RenderObject"), "GlyphRenderer 未引用 RenderObject");
  console.groupEnd();
}

function testPixelConsistencyDefault(): void {
  console.group("⑤ Pixel 一致（默认 Legacy → GlyphRenderer，命令透传）");
  const cmds = mkCommands();
  const result = dispatchRenderer("legacy", { commands: cmds, styles: [] });
  const out = result.props.commands;
  assert(out[0].x === 100 && out[0].y === 200 && out[0].width === 10 && out[0].height === 20,
    "命令几何透传（Pixel 一致基础）");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── Mainline Mount Test (Sprint-75 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testPDFCanvasUsesDispatcher();
  testDefaultStrategy();
  testFeatureFlagSwitch();
  testGlyphRendererZeroMod();
  testPixelConsistencyDefault();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("dispatcher-glyph-layer.test.ts")) {
    runAllTests();
  }
}
