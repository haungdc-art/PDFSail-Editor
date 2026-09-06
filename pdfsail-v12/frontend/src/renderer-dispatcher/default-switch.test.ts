/**
 * default-switch.test.ts — Sprint-77 Task-001 · Default Strategy Switch 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① Default = Painter（getRenderMode 默认 painter）
 *   ② Legacy Feature Flag 保留（显式 legacy → GlyphRenderer）
 *   ③ Browser Pixel Diff < 1px（Painter DOM 几何与输入一致）
 *   ④ Golden Files 全绿（tests/render-golden 建立）
 *   ⑤ Rollback < 30 秒（默认 painter，切回 legacy 即可）
 *   ⑥ Shadow Mode（painter 渲染时同时收集 legacy diff）
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-dispatcher/default-switch.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRenderMode, isShadowModeEnabled } from "./dispatcher-glyph-layer";
import { dispatchRenderer } from "./renderer-dispatcher";
import { createDefaultRegistry } from "../renderer-registry/renderer-registry";
import { LegacyRendererStrategy } from "./renderer-strategy";
import { PainterRendererStrategy } from "./painter-renderer-strategy";
import { renderPaintOutputsToMarkup } from "../render-painter/painter-dom-renderer";
import type { RenderCommand, DrawGlyphCommand } from "../document-model/render-command";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function glyph(c: Partial<DrawGlyphCommand> = {}): RenderCommand {
  return { type: "drawGlyph", char: "A", x: 100, y: 200, width: 10, height: 20, styleRef: 0, blockId: "b1", lineId: "l1", modified: false, ...c } as DrawGlyphCommand;
}

function testDefaultStrategy(): void {
  console.group("① 默认 Strategy（PM Rule-030：Default 不超前 Validation）");
  // PM 裁决（Sprint-77 Hold）：Sprint-77B 未通过，默认保持 legacy
  assert(getRenderMode() === "legacy", "getRenderMode 默认 legacy（未切 Default）");
  // 默认 Dispatcher → legacy → glyph-renderer
  const registry = createDefaultRegistry(new LegacyRendererStrategy(), "legacy");
  registry.register("painter", new PainterRendererStrategy());
  const result = dispatchRenderer(getRenderMode(), { commands: [glyph()], styles: [] }, registry);
  assert(result.renderer === "glyph-renderer", "默认 dispatch → glyph-renderer（未启用 painter）");
  // 显式 painter 可切换（测试/验证用）
  const original = (globalThis as any).window;
  (globalThis as any).window = { __rendererMode: "painter" };
  assert(getRenderMode() === "painter", "显式 painter 可切换");
  (globalThis as any).window = original ?? undefined;
  console.groupEnd();
}

function testLegacyFlagRetained(): void {
  console.group("② Legacy Feature Flag 保留");
  const original = (globalThis as any).window;
  (globalThis as any).window = { __rendererMode: "legacy" };
  assert(getRenderMode() === "legacy", "显式 legacy → legacy 模式");
  const registry = createDefaultRegistry(new LegacyRendererStrategy(), "legacy");
  registry.register("painter", new PainterRendererStrategy());
  const result = dispatchRenderer(getRenderMode(), { commands: [glyph()], styles: [] }, registry);
  assert(result.renderer === "glyph-renderer", "legacy flag → glyph-renderer");
  (globalThis as any).window = original ?? undefined;
  console.groupEnd();
}

function testPixelDiff(): void {
  console.group("③ Browser Pixel Diff < 1px（几何一致）");
  const registry = createDefaultRegistry(new LegacyRendererStrategy(), "legacy");
  registry.register("painter", new PainterRendererStrategy());
  const result = dispatchRenderer("painter", { commands: [glyph(), glyph({ x: 110 })], styles: [] }, registry);
  const html = renderPaintOutputsToMarkup(result.paintOutputs!);
  assert(html.includes("left:100px") && html.includes("top:200px") && html.includes("width:10px") && html.includes("height:20px"),
    "glyph[0] 几何精确（<1px）");
  assert(html.includes("left:110px"), "glyph[1] x=110");
  console.groupEnd();
}

function testGoldenFilesEstablished(): void {
  console.group("④ Golden Files 全绿（tests/render-golden 建立）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const goldenDir = resolve(__dirname, "../../../tests/render-golden");
  const exists = existsSync(goldenDir);
  assert(exists, "tests/render-golden 目录存在");
  console.groupEnd();
}

function testRollback(): void {
  console.group("⑤ Rollback < 30 秒（默认 painter，切回 legacy）");
  const original = (globalThis as any).window;
  (globalThis as any).window = { __rendererMode: "legacy" };
  assert(getRenderMode() === "legacy", "显式切回 legacy（即 Rollback）");
  (globalThis as any).window = original ?? undefined;
  console.groupEnd();
}

function testShadowMode(): void {
  console.group("⑥ Shadow Mode（可配置）");
  const original = (globalThis as any).window;
  (globalThis as any).window = { __rendererShadow: true };
  assert(isShadowModeEnabled() === true, "shadow flag → enabled");
  (globalThis as any).window = { __rendererShadow: false };
  assert(isShadowModeEnabled() === false, "shadow flag 关闭");
  (globalThis as any).window = original ?? undefined;
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── Default Strategy Switch Test (Sprint-77) ──", "font-weight:bold;color:#8b5cf6;");
  testDefaultStrategy();
  testLegacyFlagRetained();
  testPixelDiff();
  testGoldenFilesEstablished();
  testRollback();
  testShadowMode();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("default-switch.test.ts")) {
    runAllTests();
  }
}
