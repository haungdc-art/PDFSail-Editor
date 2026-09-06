/**
 * renderer-strategy.test.ts — Sprint-71 Task-001 · RendererStrategy Layer 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 RendererStrategy 接口
 *   ② 建立 LegacyRendererStrategy（内部调用现有 GlyphRenderer）
 *   ③ Dispatcher 能 dispatch LegacyRendererStrategy
 *   ④ GlyphRenderer 渲染逻辑零修改（源码验证）
 *   ⑤ Feature Flag（legacy → dispatcher）可切换
 *   ⑥ Pixel 一致（默认走 Legacy → GlyphRenderer，命令数据透传）
 *
 * PM Rule-019：Dispatcher dispatches Renderers, not RenderObjects.
 *   - Dispatcher 调度 Renderer（Strategy），不涉及 RenderObject/Semantic。
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-dispatcher/renderer-strategy.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchRenderer, dispatchRenderObjects } from "./renderer-dispatcher";
import { LegacyRendererStrategy } from "./renderer-strategy";
import type { RendererStrategy, RendererStrategyResult } from "./renderer-strategy";
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

function testStrategyInterface(): void {
  console.group("① 建立 RendererStrategy 接口");
  const strategy: RendererStrategy = new LegacyRendererStrategy();
  assert(strategy.kind === "legacy", `kind=${strategy.kind}`);
  assert(typeof strategy.render === "function", "render 方法存在");
  console.groupEnd();
}

function testLegacyStrategy(): void {
  console.group("② LegacyRendererStrategy 内部调用 GlyphRenderer");
  const strategy = new LegacyRendererStrategy();
  const result = strategy.render({ commands: mkCommands(), styles: [] });
  assert(result.strategy === "legacy", `strategy=${result.strategy}`);
  assert(result.renderer === "glyph-renderer", `renderer=${result.renderer}`);
  // props.commands 透传给 GlyphRenderer（RenderCommand[]）
  assert(result.props.commands.length === 2, `props.commands.length=${result.props.commands.length}`);
  const first = result.props.commands[0] as DrawGlyphCommand;
  assert(first.char === "A", "props.commands[0].char=A");
  console.groupEnd();
}

function testDispatchLegacy(): void {
  console.group("③ Dispatcher 能 dispatch LegacyRendererStrategy");
  const result = dispatchRenderer("legacy", { commands: mkCommands(), styles: [] });
  assert(result.strategy === "legacy", `result.strategy=${result.strategy}`);
  assert(result.renderer === "glyph-renderer", `result.renderer=${result.renderer}`);
  assert(result.props.commands.length === 2, `dispatch 透传 commands=${result.props.commands.length}`);
  console.groupEnd();
}

function testFeatureFlagSwitch(): void {
  console.group("⑤ Feature Flag（legacy → painter → legacy fallback）");
  // legacy 模式 → LegacyRendererStrategy
  const legacy = dispatchRenderer("legacy", { commands: mkCommands(), styles: [] });
  assert(legacy.renderer === "glyph-renderer", "legacy 模式 → glyph-renderer");
  // painter 模式（Sprint-72 未实现）→ 当前 fallback 到 legacy，保证可回滚
  const painter = dispatchRenderer("painter", { commands: mkCommands(), styles: [] });
  assert(painter.renderer === "glyph-renderer", "painter 模式当前 fallback 到 legacy（可回滚）");
  // 可切换回 legacy
  const back = dispatchRenderer("legacy", { commands: mkCommands(), styles: [] });
  assert(back.renderer === "glyph-renderer", "可切回 legacy");
  console.groupEnd();
}

function testGlyphRendererZeroMod(): void {
  console.group("④ GlyphRenderer 渲染逻辑零修改（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dirname, "../document-model/glyph-renderer.tsx"), "utf-8");
  // GlyphRenderer 未 import renderer-dispatcher / renderer-strategy
  assert(!src.includes("renderer-dispatcher"), "GlyphRenderer 未引用 renderer-dispatcher");
  assert(!src.includes("renderer-strategy"), "GlyphRenderer 未引用 renderer-strategy");
  assert(!src.includes("RenderObject"), "GlyphRenderer 未引用 RenderObject");
  assert(!src.includes("RendererStrategy"), "GlyphRenderer 未引用 RendererStrategy");
  console.groupEnd();
}

function testPixelConsistency(): void {
  console.group("⑥ Pixel 一致（默认走 Legacy → GlyphRenderer）");
  // 默认（legacy）→ GlyphRenderer，命令数据完全透传（不改 x/y/width/height）
  const cmds = mkCommands();
  const result: RendererStrategyResult = dispatchRenderer("legacy", { commands: cmds, styles: [] });
  const out = result.props.commands;
  assert(out[0].x === 100 && out[0].y === 200, "glyph[0] 位置透传（x=100 y=200）");
  assert(out[0].width === 10 && out[0].height === 20, "glyph[0] 尺寸透传");
  assert(out[1].x === 110, "glyph[1].x=110（不变）");
  // 引用语义：返回新的数组拷贝，但元素值不变
  assert(out.length === cmds.length, "命令数量一致");
  console.groupEnd();
}

function testNoRenderObjectInDispatch(): void {
  console.group("PM Rule-019：Dispatcher 调度 Renderer，不涉及 RenderObject");
  // dispatchRenderer 输入是 RenderCommand[]（非 RenderObject[]）
  const result = dispatchRenderer("legacy", { commands: mkCommands(), styles: [] });
  assert(result.props.commands[0].type === "drawGlyph", "输入为 RenderCommand（drawGlyph）");
  // dispatchRenderObjects（Sprint-70 Prototype）仍保留，但独立于 Strategy 调度
  assert(typeof dispatchRenderObjects === "function", "dispatchRenderObjects（Painter 路径）保留");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── RendererStrategy Layer Test (Sprint-71 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testStrategyInterface();
  testLegacyStrategy();
  testDispatchLegacy();
  testFeatureFlagSwitch();
  testGlyphRendererZeroMod();
  testPixelConsistency();
  testNoRenderObjectInDispatch();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("renderer-strategy.test.ts")) {
    runAllTests();
  }
}
