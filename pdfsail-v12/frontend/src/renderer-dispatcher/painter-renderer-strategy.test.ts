/**
 * painter-renderer-strategy.test.ts — Sprint-73 Task-001 · PainterRendererStrategy 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 PainterRendererStrategy
 *   ② PainterRendererStrategy 能消费 Painter（paintObject）
 *   ③ PainterRendererStrategy 输出 PaintOutput
 *   ④ Registry 注册 PainterRendererStrategy
 *   ⑤ Feature Flag：legacy → painter 可切换
 *   ⑥ Pixel Regression 全通过（RenderCommand → RenderObject → PaintOutput 几何一致）
 *
 * PM Rule-021：Registry Never Creates（本测试只 register，Registry 不 new）。
 * PM Rule-014：Legacy 仍默认，Painter 为 New Path（可回滚）。
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-dispatcher/painter-renderer-strategy.test.ts
 */

import {
  PainterRendererStrategy,
  commandsToRenderObjects,
} from "./painter-renderer-strategy";
import { dispatchRenderer } from "./renderer-dispatcher";
import { LegacyRendererStrategy } from "./renderer-strategy";
import { createDefaultRegistry, DefaultRendererRegistry } from "../renderer-registry/renderer-registry";
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

function testStrategyEstablished(): void {
  console.group("① 建立 PainterRendererStrategy");
  const strategy = new PainterRendererStrategy();
  assert(strategy.kind === "painter", `kind=${strategy.kind}`);
  assert(typeof strategy.render === "function", "render 方法存在");
  console.groupEnd();
}

function testConsumesPainter(): void {
  console.group("② PainterRendererStrategy 消费 Painter（RenderCommand → RenderObject → PaintOutput）");
  const objects = commandsToRenderObjects(mkCommands());
  assert(objects.length === 2, `RenderObject count=${objects.length}`);
  assert(objects[0].kind === "glyph", "object[0].kind=glyph");
  assert((objects[0] as any).char === "A", "glyph[0].char=A");
  // bounds 与输入一致（Pixel 一致性基础）
  const g0 = objects[0] as any;
  assert(g0.bounds.x === 100 && g0.bounds.y === 200 && g0.bounds.width === 10 && g0.bounds.height === 20,
    `glyph[0].bounds 与 RenderCommand 一致`);
  assert(g0.coverage && g0.coverage.maskBounds, "glyph 有 coverage（占位）");
  console.groupEnd();
}

function testOutputsPaintOutput(): void {
  console.group("③ PainterRendererStrategy 输出 PaintOutput");
  const strategy = new PainterRendererStrategy();
  const result = strategy.render({ commands: mkCommands(), styles: [] });
  assert(result.strategy === "painter", `strategy=${result.strategy}`);
  assert(result.renderer === "painter", `renderer=${result.renderer}`);
  assert(Array.isArray(result.paintOutputs), "paintOutputs 存在");
  assert(result.paintOutputs!.length === 2, `paintOutputs.length=${result.paintOutputs!.length}`);
  assert(result.paintOutputs![0].kind === "glyph", "output[0].kind=glyph");
  assert(result.paintOutputs![0].bounds.x === 100, "output[0].bounds.x=100（几何一致）");
  console.groupEnd();
}

function testRegistryRegistration(): void {
  console.group("④ Registry 注册 PainterRendererStrategy");
  const registry = new DefaultRendererRegistry();
  registry.register("legacy", new LegacyRendererStrategy());
  registry.register("painter", new PainterRendererStrategy());
  assert(registry.has("painter"), "has(painter)");
  assert(registry.list().includes("painter"), "list 含 painter");
  assert(registry.resolve("painter").kind === "painter", "resolve(painter).kind=painter");
  console.groupEnd();
}

function testFeatureFlagSwitch(): void {
  console.group("⑤ Feature Flag：legacy → painter 可切换");
  // 构造同时含 legacy + painter 的 registry
  const registry = createDefaultRegistry(new LegacyRendererStrategy(), "legacy");
  registry.register("painter", new PainterRendererStrategy());
  // legacy 模式
  const legacy = dispatchRenderer("legacy", { commands: mkCommands(), styles: [] }, registry);
  assert(legacy.renderer === "glyph-renderer", "legacy → glyph-renderer");
  // painter 模式
  const painter = dispatchRenderer("painter", { commands: mkCommands(), styles: [] }, registry);
  assert(painter.renderer === "painter", "painter → painter");
  assert(!!painter.paintOutputs && painter.paintOutputs.length === 2, "painter 有 paintOutputs");
  console.groupEnd();
}

function testPixelRegression(): void {
  console.group("⑥ Pixel Regression（RenderCommand → PaintOutput 几何一致）");
  const cmds = mkCommands();
  const strategy = new PainterRendererStrategy();
  const result = strategy.render({ commands: cmds, styles: [] });
  const outputs = result.paintOutputs!;
  assert(outputs[0].bounds.x === 100 && outputs[0].bounds.y === 200, "glyph[0] bounds 一致");
  assert(outputs[0].bounds.width === 10 && outputs[0].bounds.height === 20, "glyph[0] 尺寸一致");
  assert(outputs[1].bounds.x === 110, "glyph[1].x=110（不变）");
  // Legacy 默认仍可用（可回滚）
  assert(dispatchRenderer("legacy", { commands: cmds, styles: [] }).renderer === "glyph-renderer",
    "legacy 默认仍走 GlyphRenderer");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── PainterRendererStrategy Test (Sprint-73 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testStrategyEstablished();
  testConsumesPainter();
  testOutputsPaintOutput();
  testRegistryRegistration();
  testFeatureFlagSwitch();
  testPixelRegression();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("painter-renderer-strategy.test.ts")) {
    runAllTests();
  }
}
