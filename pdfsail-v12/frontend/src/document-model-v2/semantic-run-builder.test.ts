/**
 * semantic-run-builder.test.ts — Sprint-60 Task-001 · Builder 单元测试
 *
 * 验证：
 *   ① OCR block → SemanticDocumentV2（Run[] 生成）
 *   ② Run.text / Run.rotation / Run.visualBounds 正确
 *   ③ Merge Gates：schemaVersion / sourceId / backgroundRegionId（稳定 ID）
 *
 * 运行（浏览器控制台）：
 *   (await import("/src/document-model-v2/semantic-run-builder.test.ts")).runAllTests()
 */

import { buildSemanticDocument, buildRunFromBlock } from "./semantic-run-builder";
import { SEMANTIC_DOCUMENT_SCHEMA_VERSION } from "./semantic-run";
import type { OcrTextBlock } from "../ocr/ocr-storage";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function mkBlock(over: Partial<OcrTextBlock> = {}): OcrTextBlock {
  return {
    id: "b1", page: 1, x: 100, y: 200, w: 300, h: 30, text: "Hello World", fontSize: 14,
    ...over,
  };
}

function testSingleBlock(): void {
  console.group("单个 OCR block → Run[]");
  const doc = buildSemanticDocument([mkBlock()], 1, 800, 1000);
  assert(doc.pages.length === 1, "页数=1");
  assert(doc.pages[0].paragraphs.length === 1, "段落数=1");
  const run = doc.pages[0].paragraphs[0].lines[0].runs[0];
  assert(run.text === "Hello World", `Run.text = "${run.text}"`);
  assert(run.rotation === 0, `Run.rotation = ${run.rotation}`);
  assert(run.visualBounds.x === 100 && run.visualBounds.width === 300, `visualBounds = ${JSON.stringify(run.visualBounds)}`);
  assert(run.glyphs.length === 11, `glyphs 数 = ${run.glyphs.length}`);
  assert(run.metrics && typeof run.metrics === "object", "metrics 为空对象");
  assert(run.style && typeof run.style === "object", "style 为空对象");
  assert(run.source === "ocr", "source=ocr");
  console.groupEnd();
}

function testMultiLine(): void {
  console.group("多行 block → 每行一个 Run");
  const doc = buildSemanticDocument([mkBlock({ text: "Line One\nLine Two" })], 1, 800, 1000);
  const lines = doc.pages[0].paragraphs[0].lines;
  assert(lines.length === 2, `lines 数 = ${lines.length}`);
  assert(lines[0].runs[0].text === "Line One", `run0.text="${lines[0].runs[0].text}"`);
  assert(lines[1].runs[0].text === "Line Two", `run1.text="${lines[1].runs[0].text}"`);
  const y0 = lines[0].runs[0].visualBounds.y;
  const y1 = lines[1].runs[0].visualBounds.y;
  assert(y1 > y0, `行 y 递增：${y0.toFixed(1)} < ${y1.toFixed(1)}`);
  console.groupEnd();
}

function testRotation(): void {
  console.group("带旋转的 block");
  const block = mkBlock({ geometry: { angle: -7.5, transform: [0.9914, -0.1305, 0.1305, 0.9914, 0, 0] } });
  const doc = buildSemanticDocument([block], 1, 800, 1000);
  const run = doc.pages[0].paragraphs[0].lines[0].runs[0];
  assert(Math.abs(run.rotation - (-7.5)) < 0.01, `Run.rotation = ${run.rotation}（预期 -7.5）`);
  console.groupEnd();
}

function testRunFromBlock(): void {
  console.group("buildRunFromBlock");
  const run = buildRunFromBlock(mkBlock({ text: "CRM: 269473" }));
  assert(run.text === "CRM: 269473", `Run.text="${run.text}"`);
  assert(run.glyphs.length === 11, `glyphs=${run.glyphs.length}`);
  assert(run.visualBounds.width === 300, `visualBounds.w=${run.visualBounds.width}`);
  console.groupEnd();
}

function testGlyphGeometry(): void {
  console.group("glyph 几何分配");
  const run = buildRunFromBlock(mkBlock({ text: "ABC", w: 120, x: 0 }));
  assert(run.glyphs[0].bbox.width === 40, `glyph0.w=${run.glyphs[0].bbox.width}`);
  assert(run.glyphs[1].bbox.x === 40, `glyph1.x=${run.glyphs[1].bbox.x}`);
  assert(run.glyphs[2].bbox.x === 80, `glyph2.x=${run.glyphs[2].bbox.x}`);
  console.groupEnd();
}

// Merge Gate 测试
function testMergeGates(): void {
  console.group("Merge Gates（schemaVersion / 稳定 ID / Immutable）");
  const doc = buildSemanticDocument([mkBlock({ label: "signature", id: "block-abc" })], 1, 800, 1000);
  const run = doc.pages[0].paragraphs[0].lines[0].runs[0];
  assert(doc.schemaVersion === SEMANTIC_DOCUMENT_SCHEMA_VERSION, `doc.schemaVersion = ${doc.schemaVersion}`);
  assert(run.schemaVersion === SEMANTIC_DOCUMENT_SCHEMA_VERSION, `run.schemaVersion = ${run.schemaVersion}`);
  assert(run.sourceId === "block-abc", `run.sourceId = ${run.sourceId}（稳定 ID，非对象引用）`);
  assert(run.backgroundRegionId === "signature", `run.backgroundRegionId = ${run.backgroundRegionId}（稳定 ID）`);
  // Immutable 编译期保证：Readonly / ReadonlyArray（此处运行期断言不可写不可行，靠 TS 类型）
  assert(Array.isArray(run.glyphs), "glyphs 是数组（ReadonlyArray 类型）");
  console.groupEnd();
}

// Sprint-61 Metrics 测试
function testMetrics(): void {
  console.group("Run.metrics（Typography Pipeline）");
  const block = mkBlock({ text: "Hello World", w: 300, h: 30, id: "b-metrics" });
  const run = buildRunFromBlock(block);
  const m = run.metrics;
  // 全字段建立（不 undefined）
  const fields = ["fontSize", "lineHeight", "baseline", "ascent", "descent", "advanceWidth", "letterSpacing"] as const;
  fields.forEach((f) => assert(m[f] !== undefined && Number.isFinite(m[f]), `${f} 已建立（=${m[f]?.toFixed?.(2) ?? m[f]}）`));
  // 估算正确性
  assert(Math.abs(m.fontSize - 30) < 0.01, `fontSize ≈ bbox.height = ${m.fontSize}`);
  assert(Math.abs(m.lineHeight - 36) < 0.01, `lineHeight = fontSize*1.2 = ${m.lineHeight}`);
  assert(Math.abs(m.advanceWidth - (300 / 11)) < 0.01, `advanceWidth = w/字符数 = ${m.advanceWidth?.toFixed(2)}`);
  // Typography 归属：metrics 结构固定
  assert(!("geometry" in m), "metrics 不含 geometry（Typography 归属）");
  console.groupEnd();
}

// 字段归属检查（PM 纪律：字段必须回答归属）
function testFieldOwnership(): void {
  console.group("字段归属（Typography vs Geometry vs Semantic vs Rendering）");
  const m = buildRunFromBlock(mkBlock()).metrics;
  const typoKeys = Object.keys(m);
  // metrics 只应包含 Typography 字段
  assert(typoKeys.length === 7, `metrics 恰好 7 个 Typography 字段（=${typoKeys.length}）`);
  assert(!typoKeys.includes("x") && !typoKeys.includes("width"), "metrics 不含几何字段（x/width）→ 归属正确");
  console.groupEnd();
}

// Sprint-62 VisualCoverage 测试
function testVisualCoverage(): void {
  console.group("Run.visualCoverage（Coverage Domain）");
  const block = mkBlock({ text: "JEFERSON", x: 100, y: 200, w: 200, h: 30, id: "b-vc" });
  const run = buildRunFromBlock(block);
  const vc = run.visualCoverage;
  // 全字段建立
  const fields = ["maskBounds", "patchBounds", "coverageBounds", "confidence"] as const;
  fields.forEach((f) => assert(vc[f] !== undefined, `${f} 已建立`));
  // maskBounds = OCR bbox（原始）
  assert(vc.maskBounds.x === 100 && vc.maskBounds.width === 200, `maskBounds=${JSON.stringify(vc.maskBounds)}`);
  // coverageBounds 扩展（> maskBounds，盖住原文边缘）
  assert(vc.coverageBounds.width > vc.maskBounds.width, `coverageBounds.w(${vc.coverageBounds.width.toFixed(1)}) > maskBounds.w(${vc.maskBounds.width})`);
  assert(vc.coverageBounds.x < vc.maskBounds.x, `coverageBounds.x(${vc.coverageBounds.x.toFixed(1)}) < maskBounds.x(${vc.maskBounds.x})`);
  // padding = height*0.15
  const pad = 30 * 0.15;
  assert(Math.abs(vc.coverageBounds.width - (200 + pad * 2)) < 0.01, `coverageBounds.w = 200+2*${pad.toFixed(1)} = ${vc.coverageBounds.width.toFixed(1)}`);
  // confidence 0~1
  assert(vc.confidence >= 0 && vc.confidence <= 1, `confidence=${vc.confidence}（0~1）`);
  console.groupEnd();
}

export function runAllTests() {
  results = [];
  console.log("%c── SemanticRunBuilder Test (Sprint-60 Task-001) ──", "font-weight:bold;color:#8b5cf6;");
  testSingleBlock();
  testMultiLine();
  testRotation();
  testRunFromBlock();
  testGlyphGeometry();
  testMergeGates();
  testMetrics();
  testFieldOwnership();
  testVisualCoverage();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}
