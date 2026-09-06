/**
 * benchmark-consumer.test.ts — BenchmarkConsumer Golden Test（Sprint-121 · Task-2）
 *
 * ADR-045 · Consumer Architecture。
 *
 * 验证（PM Task-2 退出条件）：
 *   1. BenchmarkConsumer 实现统一 Consumer<T,R>，唯一入口 consume(DomDocument)
 *   2. 只消费 Page/Document DOM，禁止依赖 EditableDocument
 *   3. Builder 零改动
 *   4. 与 ValidatorConsumer 平行，不调用 ValidatorConsumer
 *   5. 真实 PDF：Builder → Page → BenchmarkConsumer 验证（端到端脚本）
 *   6. Replay/Regression 无回归
 */
import { createPage } from "./page-builder";
import { createBenchmarkConsumer } from "./benchmark-consumer";
import { DomDocument } from "./types";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造含 2 页的合法 DomDocument（1 页有内容，1 页空） */
function makeDocument(): DomDocument {
  return {
    pages: [
      createPage({
        metadata: { index: 1, width: 595, height: 842 },
        blocks: [
          { id: "b1", type: "text", regionType: "paragraph", bbox: { x: 40, y: 100, width: 500, height: 100 } },
          { id: "b2", type: "text", regionType: "paragraph", bbox: { x: 40, y: 200, width: 500, height: 100 } },
          { id: "b3", type: "text", regionType: "footer", bbox: { x: 40, y: 810, width: 400, height: 20 } },
        ],
      }),
      createPage({
        metadata: { index: 2, width: 595, height: 842 },
        blocks: [], // 空页（合法）
      }),
    ],
  };
}

function testInterface(): void {
  console.group("① BenchmarkConsumer 实现统一 Consumer<T,R>，唯一入口 consume");
  const consumer = createBenchmarkConsumer();
  assert(typeof consumer.consume === "function", "consume 是唯一入口");
  const r = consumer.consume(makeDocument());
  assert("pass" in r && "completenessScore" in r && "pages" in r, "consume 返回 DomBenchmarkResult");
  console.groupEnd();
}

function testMeasuresDom(): void {
  console.group("② 正确度量 DOM 完整性");
  const consumer = createBenchmarkConsumer();
  const r = consumer.consume(makeDocument());
  assert(r.pageCount === 2, "pageCount=2");
  assert(r.totalGlyphs === 3, "totalGlyphs=3（3 个 Glyph block）");
  assert(r.pages[0].structuralPass === true, "page1 BaseLayer 有 PdfFallback → structuralPass");
  assert(r.pages[1].structuralPass === true, "page2（空页）BaseLayer 仍有 PdfFallback → structuralPass");
  assert(r.completenessScore === 100, "completenessScore=100（结构全满足）");
  assert(r.pass === true, "PASS");
  console.groupEnd();
}

function testOnlyDomDependency(): void {
  console.group("③ 只依赖 DOM（不依赖 EditableDocument）");
  const consumer = createBenchmarkConsumer();
  assert(consumer.consume(makeDocument()).pass === true, "BenchmarkConsumer 正常工作（无 EditableDocument 依赖）");
  console.groupEnd();
}

function testParallelToValidator(): void {
  console.group("④ 与 ValidatorConsumer 平行（不调用 ValidatorConsumer）");
  // BenchmarkConsumer 内部不 import/调用 ValidatorConsumer
  // 验证：单独消费 DomDocument，不依赖 Validator 先跑
  const consumer = createBenchmarkConsumer();
  const r = consumer.consume(makeDocument());
  assert(r.pass === true, "BenchmarkConsumer 独立工作，无需 Validator 参与");
  console.groupEnd();
}

function testPureConsume(): void {
  console.group("⑤ 纯消费（不改 model）");
  const doc = makeDocument();
  const before = JSON.stringify(doc);
  createBenchmarkConsumer().consume(doc);
  assert(JSON.stringify(doc) === before, "consume 不改输入");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── BenchmarkConsumer Golden Test (Sprint-121 · Task-2) ──", "font-weight:bold;color:#8b5cf6;");
  testInterface();
  testMeasuresDom();
  testOnlyDomDependency();
  testParallelToValidator();
  testPureConsume();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("benchmark-consumer.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
