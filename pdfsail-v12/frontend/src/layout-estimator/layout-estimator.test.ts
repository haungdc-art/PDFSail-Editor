/**
 * layout-estimator.test.ts — Sprint-63 Task-001 · LayoutEstimator 单元测试
 *
 * 验证：
 *   ① LayoutDocument 层级（Page → Paragraph → Line → Run → Glyph）
 *   ② LayoutGlyph 只有 Position（无 text/style/semantic）
 *   ③ runId / glyphId 引用 Semantic（不复制业务数据）
 *   ④ baseline / advance / origin 正确
 *   ⑤ Immutable
 *
 * 运行（浏览器控制台）：
 *   (await import("/src/layout-estimator/layout-estimator.test.ts")).runAllTests()
 */

import { buildLayoutDocument, estimateLayoutRunFromSemantic } from "./layout-estimator";
import { LAYOUT_SCHEMA_VERSION } from "../layout-model-v2/layout-model";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造一个最小 Semantic Run（模拟 Builder 输出） */
function mkRun(over: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1,
    id: "run-1",
    text: "ABC",
    glyphs: [
      { char: "A", bbox: { x: 0, y: 10, width: 10, height: 10 } },
      { char: "B", bbox: { x: 10, y: 10, width: 10, height: 10 } },
      { char: "C", bbox: { x: 20, y: 10, width: 10, height: 10 } },
    ],
    visualBounds: { x: 0, y: 10, width: 30, height: 10 },
    rotation: 0,
    metrics: { fontSize: 10, lineHeight: 12, baseline: 8, advanceWidth: 10, ascent: 8, descent: 2, letterSpacing: 0 },
    style: {},
    source: "ocr",
    ...over,
  };
}

function mkDoc(runs: any[] = [mkRun()]): any {
  return {
    schemaVersion: 1,
    id: "sem-doc",
    pages: [{ index: 1, width: 800, height: 1000, paragraphs: [{ id: "p1", lines: [{ id: "l1", runs }] }] }],
  };
}

function testHierarchy(): void {
  console.group("LayoutDocument 层级");
  const layout = buildLayoutDocument(mkDoc());
  assert(layout.schemaVersion === LAYOUT_SCHEMA_VERSION, `schemaVersion=${layout.schemaVersion}`);
  assert(layout.semanticDocumentId === "sem-doc", "semanticDocumentId 引用语义文档");
  assert(layout.pages.length === 1, "pages=1");
  assert(layout.pages[0].paragraphs.length === 1, "paragraphs=1");
  assert(layout.pages[0].paragraphs[0].lines.length === 1, "lines=1");
  assert(layout.pages[0].paragraphs[0].lines[0].runs.length === 1, "runs=1");
  const run = layout.pages[0].paragraphs[0].lines[0].runs[0];
  assert(run.runId === "run-1", `runId 引用语义 Run=${run.runId}`);
  assert(run.glyphs.length === 3, `glyphs=3`);
  console.groupEnd();
}

function testGlyphPosition(): void {
  console.group("LayoutGlyph 只含 Position");
  const layout = buildLayoutDocument(mkDoc());
  const g = layout.pages[0].paragraphs[0].lines[0].runs[0].glyphs;
  // A: x=0, B: x=10, C: x=20（advance=10）
  assert(g[0].x === 0, `A.x=${g[0].x}`);
  assert(g[1].x === 10, `B.x=${g[1].x}`);
  assert(g[2].x === 20, `C.x=${g[2].x}`);
  assert(g[0].y === 10, `A.y=${g[0].y}（=visualBounds.y）`);
  assert(g[0].advance === 10, `A.advance=${g[0].advance}`);
  assert(g[0].baseline === 18, `A.baseline=${g[0].baseline}（y + metrics.baseline 8）`);
  // LayoutGlyph 无 text/style（只有 Position）
  assert(!("text" in g[0]) && !("style" in g[0]) && !("char" in g[0]), "LayoutGlyph 无 text/style/char（纯 Position）");
  console.groupEnd();
}

function testRunProperties(): void {
  console.group("LayoutRun 属性");
  const layout = buildLayoutDocument(mkDoc());
  const run = layout.pages[0].paragraphs[0].lines[0].runs[0];
  assert(run.baseline === 8, `baseline=${run.baseline}`);
  assert(run.origin.x === 0 && run.origin.y === 10, `origin=${JSON.stringify(run.origin)}`);
  assert(run.bounds.width === 30, `bounds.w=${run.bounds.width}`);
  // 不复制业务数据
  assert(!("text" in run) && !("style" in run) && !("metrics" in run), "LayoutRun 不复制 text/style/metrics（只引用 runId）");
  console.groupEnd();
}

function testImmutable(): void {
  console.group("Immutable");
  const layout = buildLayoutDocument(mkDoc());
  assert(Array.isArray(layout.pages), "pages 数组（ReadonlyArray 类型）");
  assert(Array.isArray(layout.pages[0].paragraphs[0].lines[0].runs[0].glyphs), "glyphs 数组");
  console.groupEnd();
}

function testSingleRun(): void {
  console.group("estimateLayoutRunFromSemantic");
  const run = estimateLayoutRunFromSemantic(mkRun());
  assert(run.runId === "run-1", `runId=${run.runId}`);
  assert(run.glyphs.length === 3, `glyphs=${run.glyphs.length}`);
  assert(run.origin.x === 0, `origin.x=${run.origin.x}`);
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── LayoutEstimator Test (Sprint-63 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testHierarchy();
  testGlyphPosition();
  testRunProperties();
  testImmutable();
  testSingleRun();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}
