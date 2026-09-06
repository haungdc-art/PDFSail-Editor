/**
 * renderer-registry.test.ts — Sprint-72 Task-001 · RendererRegistry 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 RendererRegistry
 *   ② Dispatcher 不再 switch Strategy（源码验证：dispatchRenderer 走 Registry.resolve）
 *   ③ Dispatcher 改为 Registry.resolve()
 *   ④ LegacyRendererStrategy 注册到 Registry
 *   ⑤ Feature Flag 保持
 *   ⑥ Pixel Regression 全通过（默认走 Legacy → GlyphRenderer，命令透传）
 *
 * PM Rule-020：Strategy never knows other strategies.
 *   - Registry 只负责注册/解析，Strategy 互不知晓。
 *   - Dispatcher select strategy → strategy.render()。
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-registry/renderer-registry.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultRendererRegistry,
  createDefaultRegistry,
  renderWithRegistry,
} from "./renderer-registry";
import { dispatchRenderer } from "../renderer-dispatcher/renderer-dispatcher";
import { LegacyRendererStrategy } from "../renderer-dispatcher/renderer-strategy";
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

function testRegistryEstablished(): void {
  console.group("① 建立 RendererRegistry");
  const reg = new DefaultRendererRegistry();
  assert(typeof reg.register === "function", "register 方法");
  assert(typeof reg.resolve === "function", "resolve 方法");
  assert(typeof reg.has === "function", "has 方法");
  assert(typeof reg.list === "function", "list 方法");
  assert(reg.list().length === 0, "初始为空");
  console.groupEnd();
}

function testRegisterResolve(): void {
  console.group("④ LegacyRendererStrategy 注册到 Registry");
  const reg = new DefaultRendererRegistry();
  reg.register("legacy", new LegacyRendererStrategy());
  assert(reg.has("legacy"), "has(legacy)");
  assert(reg.list().includes("legacy"), "list 含 legacy");
  const strategy = reg.resolve("legacy");
  assert(strategy.kind === "legacy", "resolve 返回 legacy strategy");
  console.groupEnd();
}

function testResolveUnknownThrows(): void {
  console.group("Registry.resolve 未知策略抛错");
  const reg = new DefaultRendererRegistry();
  reg.register("legacy", new LegacyRendererStrategy());
  let threw = false;
  try {
    reg.resolve("painter");
  } catch {
    threw = true;
  }
  assert(threw, "resolve(未注册) 抛错");
  console.groupEnd();
}

function testDispatcherUsesRegistry(): void {
  console.group("②③ Dispatcher 改为 Registry.resolve()（源码验证）");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dirname, "../renderer-dispatcher/renderer-dispatcher.ts"), "utf-8");
  // Dispatcher 不再用 switch(mode){case...} 列举 strategy（无 case 分支）
  assert(!/case\s*["'](legacy|painter)["']\s*:/.test(src), "Dispatcher 无 switch case 分支");
  // Dispatcher 走 renderWithRegistry（Registry.resolve）
  assert(src.includes("renderWithRegistry"), "Dispatcher 调用 renderWithRegistry（Registry.resolve）");
  assert(src.includes("createDefaultRegistry"), "Dispatcher 用 createDefaultRegistry");
  console.groupEnd();
}

function testDispatcherThroughRegistry(): void {
  console.group("③ Dispatcher 通过 Registry 解析 Legacy");
  const result = dispatchRenderer("legacy", { commands: mkCommands(), styles: [] });
  assert(result.strategy === "legacy", `strategy=${result.strategy}`);
  assert(result.renderer === "glyph-renderer", `renderer=${result.renderer}`);
  assert(result.props.commands.length === 2, "commands 透传");
  const first = result.props.commands[0] as DrawGlyphCommand;
  assert(first.char === "A", "glyph[0].char=A");
  console.groupEnd();
}

function testCustomRegistryDispatch(): void {
  console.group("③ 自定义 Registry 经 dispatchWithRegistry");
  const reg = createDefaultRegistry(new LegacyRendererStrategy(), "legacy");
  const result = renderWithRegistry(reg, "legacy", { commands: mkCommands(), styles: [] });
  assert(result.renderer === "glyph-renderer", "renderWithRegistry 经自定义 registry");
  console.groupEnd();
}

function testFeatureFlagKept(): void {
  console.group("⑤ Feature Flag 保持");
  // legacy 可调度
  assert(dispatchRenderer("legacy", { commands: mkCommands(), styles: [] }).renderer === "glyph-renderer", "legacy 模式可用");
  console.groupEnd();
}

function testPixelRegression(): void {
  console.group("⑥ Pixel Regression（默认 Legacy，命令透传）");
  const cmds = mkCommands();
  const result = dispatchRenderer("legacy", { commands: cmds, styles: [] });
  const out = result.props.commands;
  assert(out[0].x === 100 && out[0].y === 200 && out[0].width === 10 && out[0].height === 20, "glyph[0] 几何透传不变");
  assert(out[1].x === 110, "glyph[1].x=110（不变）");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── RendererRegistry Test (Sprint-72 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testRegistryEstablished();
  testRegisterResolve();
  testResolveUnknownThrows();
  testDispatcherUsesRegistry();
  testDispatcherThroughRegistry();
  testCustomRegistryDispatch();
  testFeatureFlagKept();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("renderer-registry.test.ts")) {
    runAllTests();
  }
}
