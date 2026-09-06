/**
 * shadow-metrics.test.ts — Sprint-78 Task-003 · Shadow Metrics 单元测试
 *
 * 验证（对应 PM Acceptance / PM Rule-031）：
 *   Shadow 必须统计 DOM/BBox/Rotation/Patch/Mask/Render Time，不能只统计 count。
 *
 *   指标：count / bboxDiff / rotationDiff / maskDiff / patchDiff / paintTime / renderTime / pass
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/renderer-dispatcher/shadow-metrics.test.ts
 */

import {
  computeShadowMetrics,
  computeGeomDiff,
  objectsToGeom,
  outputsToGeom,
} from "./shadow-metrics";
import { commandsToRenderObjects } from "./painter-renderer-strategy";
import { PainterRendererStrategy } from "./painter-renderer-strategy";
import type { GeomRecord } from "./shadow-metrics";
import type { RenderCommand, DrawGlyphCommand } from "../document-model/render-command";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function glyph(c: Partial<DrawGlyphCommand> = {}): RenderCommand {
  return { type: "drawGlyph", char: "A", x: 100, y: 200, width: 10, height: 20, styleRef: 0, blockId: "b1", lineId: "l1", modified: false, ...c } as DrawGlyphCommand;
}

function testIdentical(): void {
  console.group("① 完全一致 → pass=true, diff=0");
  const geom: GeomRecord[] = [
    { x: 100, y: 200, width: 10, height: 20, kind: "glyph" },
    { x: 110, y: 200, width: 10, height: 20, kind: "glyph" },
  ];
  const m = computeShadowMetrics(geom, geom);
  assert(m.countDiff === 0, "countDiff=0");
  assert(m.bboxDiff === 0, "bboxDiff=0");
  assert(m.rotationDiff === 0, "rotationDiff=0");
  assert(m.pass === true, "pass=true");
  console.groupEnd();
}

function testCountDiff(): void {
  console.group("② count 差异");
  const a: GeomRecord[] = [{ x: 100, y: 200, width: 10, height: 20, kind: "glyph" }];
  const b: GeomRecord[] = [
    { x: 100, y: 200, width: 10, height: 20, kind: "glyph" },
    { x: 110, y: 200, width: 10, height: 20, kind: "glyph" },
  ];
  const m = computeShadowMetrics(a, b);
  assert(m.countDiff === 1, "countDiff=1");
  assert(m.pass === false, "count 不一致 → pass=false");
  console.groupEnd();
}

function testBBoxDiff(): void {
  console.group("③ BBox 差异（归一化）");
  const a: GeomRecord[] = [{ x: 100, y: 200, width: 10, height: 20, kind: "glyph" }];
  // painter 偏移 5px
  const b: GeomRecord[] = [{ x: 105, y: 200, width: 10, height: 20, kind: "glyph" }];
  const m = computeShadowMetrics(a, b);
  assert(m.bboxDiff > 0, `bboxDiff>0（${m.bboxDiff.toFixed(3)}）`);
  assert(m.bboxDiff < 1, "bboxDiff 归一化 < 1");
  assert(m.pass === false, "偏移 → pass=false");
  console.groupEnd();
}

function testRotationDiff(): void {
  console.group("④ Rotation 差异（度）");
  const a: GeomRecord[] = [{ x: 100, y: 200, width: 10, height: 20, kind: "glyph", rotation: 0 }];
  const b: GeomRecord[] = [{ x: 100, y: 200, width: 10, height: 20, kind: "glyph", rotation: 45 }];
  const m = computeShadowMetrics(a, b);
  assert(Math.abs(m.rotationDiff - 45) < 0.01, `rotationDiff=${m.rotationDiff}（45°）`);
  console.groupEnd();
}

function testMaskPatchDiff(): void {
  console.group("⑤ Mask / Patch 差异");
  const a: GeomRecord[] = [
    { x: 100, y: 200, width: 300, height: 20, kind: "mask" },
    { x: 100, y: 200, width: 300, height: 20, kind: "patch" },
  ];
  const b: GeomRecord[] = [{ x: 100, y: 200, width: 300, height: 20, kind: "mask" }];
  const m = computeShadowMetrics(a, b);
  assert(m.maskDiff === 0, "maskDiff=0");
  assert(m.patchDiff === 1, "patchDiff=1");
  console.groupEnd();
}

function testTiming(): void {
  console.group("⑥ Paint / Render Time");
  const g: GeomRecord[] = [{ x: 100, y: 200, width: 10, height: 20, kind: "glyph" }];
  const m = computeShadowMetrics(g, g, 3.5, 12.1);
  assert(m.paintTime === 3.5, "paintTime=3.5ms");
  assert(m.renderTime === 12.1, "renderTime=12.1ms");
  console.groupEnd();
}

function testIntegrationWithPainter(): void {
  console.group("⑦ 集成：Painter 路径几何可采集");
  const cmds: RenderCommand[] = [glyph({}), glyph({ x: 110 }), { type: "drawLine", x: 100, y: 200, width: 300, height: 20, purpose: "mask", blockId: "b1" } as any];
  const objects = commandsToRenderObjects(cmds);
  const strategy = new PainterRendererStrategy();
  const result = strategy.render({ commands: cmds, styles: [] });
  const painterGeom = objectsToGeom(objects);
  const painterOutputGeom = outputsToGeom(result.paintOutputs!);
  assert(painterGeom.length === 3, "painter 几何含 2 glyph + 1 mask");
  assert(painterOutputGeom.length === 3, "paintOutput 几何可采集");
  const m = computeShadowMetrics(painterGeom, painterOutputGeom);
  assert(m.pass === true, "painter RenderObject 与 PaintOutput 一致（pass）");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── Shadow Metrics Test (Sprint-78 Task-003) ──", "font-weight:bold;color:#8b5cf6;");
  testIdentical();
  testCountDiff();
  testBBoxDiff();
  testRotationDiff();
  testMaskPatchDiff();
  testTiming();
  testIntegrationWithPainter();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("shadow-metrics.test.ts")) {
    runAllTests();
  }
}
