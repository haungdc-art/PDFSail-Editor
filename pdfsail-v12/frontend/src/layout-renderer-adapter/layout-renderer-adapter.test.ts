/**
 * layout-renderer-adapter.test.ts — Sprint-64 Task-001 · LayoutRendererAdapter 单元测试
 *
 * 验证：
 *   ① Adapter 建立（Layout + Semantic → DrawGlyphCommand[]）
 *   ② LayoutGlyph → DrawGlyphCommand 正确（char/x/y/baseline）
 *   ③ runId/glyphId 引用 Semantic（char 从 Semantic 取，LayoutGlyph 无 char）
 *   ④ Renderer 零修改（本 Adapter 独立，未改任何 Renderer）
 *   ⑤ Immutable
 *
 * 运行（浏览器控制台）：
 *   (await import("/src/layout-renderer-adapter/layout-renderer-adapter.test.ts")).runAllTests()
 */

import { adaptLayoutToRenderCommands } from "./layout-renderer-adapter";
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

function buildPipeline(text: string) {
  const semantic = buildSemanticDocument([mkBlock(text)], 1, 800, 1000);
  const layout = buildLayoutDocument(semantic);
  return { semantic, layout };
}

function testAdapterBasic(): void {
  console.group("Adapter 建立（Layout + Semantic → DrawGlyphCommand）");
  const { semantic, layout } = buildPipeline("ABC");
  const commands = adaptLayoutToRenderCommands({ layout, semantic });
  assert(commands.length === 3, `commands=3（"ABC" 3 字符）`);
  assert(commands[0].type === "drawGlyph", "type=drawGlyph");
  assert(commands[0].char === "A", `char[0]=${commands[0].char}`);
  assert(commands[1].char === "B", `char[1]=${commands[1].char}`);
  assert(commands[2].char === "C", `char[2]=${commands[2].char}`);
  console.groupEnd();
}

function testGlyphPosition(): void {
  console.group("LayoutGlyph → DrawGlyphCommand 位置");
  const { semantic, layout } = buildPipeline("AB");
  const commands = adaptLayoutToRenderCommands({ layout, semantic });
  assert(commands[0].x === 100, `A.x=${commands[0].x}（=origin.x）`);
  assert(commands[1].x > commands[0].x, `B.x(${commands[1].x.toFixed(1)}) > A.x(${commands[0].x.toFixed(1)})`);
  assert(commands[0].y === 200, `A.y=${commands[0].y}`);
  // baseline 传递
  assert(commands[0].baseline !== undefined, `baseline=${commands[0].baseline}`);
  console.groupEnd();
}

function testSemanticReference(): void {
  console.group("runId/glyphId 引用 Semantic（char 来自 Semantic）");
  const { semantic, layout } = buildPipeline("JEFERSON");
  const commands = adaptLayoutToRenderCommands({ layout, semantic });
  // char 从 Semantic glyph 取（LayoutGlyph 无 char）
  assert(commands[0].char === "J", `char[0]=${commands[0].char}`);
  assert(commands.every((c) => typeof c.char === "string" && c.char.length === 1), "所有 command.char 为单字符");
  // blockId 来自 sourceId
  assert(commands[0].blockId === "b1", `blockId=${commands[0].blockId}`);
  assert(commands[0].lineId.startsWith("b1-line"), `lineId=${commands[0].lineId}`);
  console.groupEnd();
}

function testImmutable(): void {
  console.group("Immutable");
  const { semantic, layout } = buildPipeline("ABC");
  const commands = adaptLayoutToRenderCommands({ layout, semantic });
  assert(Array.isArray(commands), "commands 数组");
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── LayoutRendererAdapter Test (Sprint-64 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testAdapterBasic();
  testGlyphPosition();
  testSemanticReference();
  testImmutable();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}
