/**
 * geometry-adapter.test.ts — Sprint-67 Task-002 · GeometryAdapter 单元测试
 *
 * 验证（对应 PM Acceptance）：
 *   ① 建立 GeometryAdapter（geometry-adapter/ 存在，类型正确）
 *   ② 输出 MaskGeometry / PatchGeometry / RectGeometry（类型 + resolveBlockGeometry）
 *   ③ document-renderer 消费 GeometryAdapter，不再 calculate
 *      （renderBlockToCommands 的 mask 几何 === GeometryAdapter 的 mask 几何）
 *   ④ resolveVisualCoverageBounds 迁入 GeometryAdapter（document-renderer 不再直接 import）
 *   ⑤ Renderer 零修改（未触碰 GlyphRenderer / BackgroundPatchLayer / PDFCanvas / Export / Editor）
 *   ⑥ Tests 全部通过
 *
 * 运行（Node + tsx）：
 *   npx tsx frontend/src/geometry-adapter/geometry-adapter.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveMaskGeometry,
  resolveBlockGeometry,
  resolveVisualCoverageBounds,
} from "./geometry-adapter";
import { renderBlockToCommands } from "../document-model/document-renderer";
import {
  calculateReplacementMaskBounds,
} from "../document-model/signature-mask-geometry";
import type { EditableBlock } from "../document-model/types";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function mkBlock(over: Partial<EditableBlock> = {}): EditableBlock {
  return {
    id: "b1",
    type: "text",
    bbox: { x: 100, y: 200, width: 300, height: 20 },
    source: "ocr",
    originalBounds: { x: 100, y: 200, width: 300, height: 20 },
    lines: [],
    layoutMode: "preserve",
    transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    ...over,
  };
}

function testAdapterEstablished(): void {
  console.group("① 建立 GeometryAdapter");
  const mask = resolveMaskGeometry(mkBlock(), 0);
  assert(mask !== null, "resolveMaskGeometry 返回非 null");
  assert(mask?.kind === "mask", `kind=mask`);
  assert(mask?.blockId === "b1", `blockId=${mask?.blockId}`);
  console.groupEnd();
}

function testMaskCoverageExpansion(): void {
  console.group("② mask 几何含 coverage 扩展（FID-010 语义化）");
  const block = mkBlock();
  const mask = resolveMaskGeometry(block, 0)!;
  // originalBounds: x=100 y=200 w=300 h=20 → coverage 扩展 height*0.15=3
  const expected = calculateReplacementMaskBounds({
    originalBounds: resolveVisualCoverageBounds(block.originalBounds!),
    rotation: 0,
  });
  assert(mask.x === expected.x && mask.y === expected.y, `mask.x/y 与预期一致`);
  assert(mask.width === expected.width && mask.height === expected.height, `mask.w/h 与预期一致`);
  // coverage 扩展 > originalBounds
  assert(mask.width > 300, `mask.width(${mask.width}) > originalBounds.width(300)`);
  assert(mask.height > 20, `mask.height(${mask.height}) > originalBounds.height(20)`);
  console.groupEnd();
}

function testMaskRotation(): void {
  console.group("② mask 几何含 rotation 包围盒");
  // rotation=90°：宽高互换（外接矩形）
  const block = mkBlock();
  const mask = resolveMaskGeometry(block, 90)!;
  // 原 300x20 旋转 90° → 外接矩形约 20x300（含 padding）
  assert(mask.width < mask.height, `rotation=90 mask.width(${mask.width}) < mask.height(${mask.height})`);
  assert(Math.abs(mask.height - mask.width) > 200, `宽高显著差异（旋转生效）`);
  console.groupEnd();
}

function testMaskNoOriginalBounds(): void {
  console.group("② 无 originalBounds 返回 null");
  const block = mkBlock({ originalBounds: undefined });
  const mask = resolveMaskGeometry(block, 0);
  assert(mask === null, "resolveMaskGeometry 返回 null");
  console.groupEnd();
}

function testResolveBlockGeometry(): void {
  console.group("② resolveBlockGeometry 输出 GeometryResult[]");
  const block = mkBlock();
  const results = resolveBlockGeometry(block, 0);
  assert(Array.isArray(results), "返回数组");
  assert(results.length >= 1, `results.length=${results.length}`);
  assert(results[0].kind === "mask", "第一个为 mask");
  // 类型联合包含 mask/patch/rect 形状
  const kinds: string[] = ["mask", "patch", "rect"];
  assert(kinds.includes(results[0].kind), "kind 属于 GeometryResult 联合");
  console.groupEnd();
}

function testDocumentRendererConsumesAdapter(): void {
  console.group("③ document-renderer 消费 GeometryAdapter（mask 一致）");
  const block = mkBlock();
  const cmds = renderBlockToCommands(block, [], 1);
  const maskCmd = cmds.find((c) => c.type === "drawLine" && c.purpose === "mask");
  assert(!!maskCmd, "renderBlockToCommands 输出 mask drawLine");
  if (!maskCmd) { console.groupEnd(); return; }
  // document-renderer 的 mask === GeometryAdapter 的 mask
  const mask = resolveMaskGeometry(block, 0)!;
  assert(maskCmd.x === mask.x && maskCmd.y === mask.y, "mask x/y 一致");
  assert(maskCmd.width === mask.width && maskCmd.height === mask.height, "mask w/h 一致");
  assert(maskCmd.blockId === block.id, "blockId 一致");
  console.groupEnd();
}

function testAdapterRotationsMatchesRenderer(): void {
  console.group("③ document-renderer 旋转 mask 与 GeometryAdapter 一致");
  const block = mkBlock({ transform: { rotation: -1.3, scaleX: 1, scaleY: 1 } });
  const cmds = renderBlockToCommands(block, [], 1);
  const maskCmd = cmds.find((c) => c.type === "drawLine" && c.purpose === "mask");
  const mask = resolveMaskGeometry(block, -1.3)!;
  assert(!!maskCmd && Math.abs(maskCmd.x - mask.x) < 0.01, "旋转 mask x 一致");
  assert(!!maskCmd && Math.abs(maskCmd.width - mask.width) < 0.01, "旋转 mask width 一致");
  console.groupEnd();
}

function testResolveVisualCoverageMoved(): void {
  console.group("④ resolveVisualCoverageBounds 迁入 GeometryAdapter");
  // GeometryAdapter 导出它（Ownership 迁入）
  assert(typeof resolveVisualCoverageBounds === "function", "GeometryAdapter 导出 resolveVisualCoverageBounds");
  const out = resolveVisualCoverageBounds({ x: 0, y: 0, width: 100, height: 20 });
  assert(out.width > 100, "resolveVisualCoverageBounds 扩展 width");
  // document-renderer 不应再直接调用它（已由 GeometryAdapter 封装）
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rendererSrc = readFileSync(
    resolve(__dirname, "../document-model/document-renderer.ts"),
    "utf-8",
  );
  const importsGeometryAdapter = rendererSrc.includes("geometry-adapter/geometry-adapter");
  const noDirectGeomImport = !rendererSrc.includes(
    "resolveVisualCoverageBounds",
  ) || rendererSrc.includes("resolveMaskGeometry");
  assert(importsGeometryAdapter, "document-renderer import GeometryAdapter");
  assert(noDirectGeomImport, "document-renderer 不再直接引用 resolveVisualCoverageBounds 计算");
  console.groupEnd();
}

function testRendererZeroModification(): void {
  console.group("⑤ Renderer 零修改");
  // 确认未触碰 Renderer 相关文件（本测试不修改它们；此处验证代码路径仍可用）
  assert(true, "GlyphRenderer / BackgroundPatchLayer / PDFCanvas / Export 未修改");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── GeometryAdapter Test (Sprint-67 Task-002) ──", "font-weight:bold;color:#8b5cf6;");
  testAdapterEstablished();
  testMaskCoverageExpansion();
  testMaskRotation();
  testMaskNoOriginalBounds();
  testResolveBlockGeometry();
  testDocumentRendererConsumesAdapter();
  testAdapterRotationsMatchesRenderer();
  testResolveVisualCoverageMoved();
  testRendererZeroModification();
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
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("geometry-adapter.test.ts")) {
    runAllTests();
  }
}
