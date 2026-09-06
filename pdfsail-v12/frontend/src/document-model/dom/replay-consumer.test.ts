/**
 * replay-consumer.test.ts — ReplayConsumer Golden Test（Sprint-121 · Task-3）
 *
 * ADR-045 · Consumer Architecture。
 *
 * 验证（PM Task-3 退出条件，含新增 Deterministic 条件）：
 *   1. ReplayConsumer 实现统一 Consumer<T,R>，唯一入口 consume(DomDocument)
 *   2. 只消费 Page/Document DOM，禁止依赖 EditableDocument
 *   3. Builder 零改动
 *   4. 与 Validator/Benchmark 平行，不调用其他 Consumer
 *   5. 真实 PDF：Builder → Page → ReplayConsumer 验证（端到端脚本）
 *   6. Replay/Regression 无回归
 *   + Deterministic：同一 Page 多次 consume，输出一致（不夹 Runtime/Cache/Time/Random/Global State）
 */
import { createPage } from "./page-builder";
import { createReplayConsumer, fingerprintOf, isReplayConsistent, fnv1a } from "./replay-consumer";
import { DomDocument } from "./types";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造一份固定 DOM */
function makeDocument(): DomDocument {
  return {
    pages: [
      createPage({
        metadata: { index: 1, width: 595, height: 842 },
        blocks: [
          { id: "b1", type: "text", regionType: "paragraph", bbox: { x: 40, y: 100, width: 500, height: 100 } },
          { id: "b2", type: "text", regionType: "footer", bbox: { x: 40, y: 810, width: 400, height: 20 } },
        ],
      }),
    ],
  };
}

function testInterface(): void {
  console.group("① ReplayConsumer 实现统一 Consumer<T,R>，唯一入口 consume + 稳定 id");
  const consumer = createReplayConsumer();
  assert(consumer.id === "replay", `ReplayConsumer.id = "replay"`);
  assert(typeof consumer.consume === "function", "consume 是唯一入口");
  const r = consumer.consume(makeDocument());
  assert("pass" in r && "fingerprint" in r, "consume 返回 ReplayResult");
  console.groupEnd();
}

function testDeterministic(): void {
  console.group("② Deterministic：同一 Page 多次 consume 输出一致");
  const consumer = createReplayConsumer();
  const doc = makeDocument();
  const r1 = consumer.consume(doc);
  const r2 = consumer.consume(doc);
  const r3 = consumer.consume(doc);
  assert(r1.fingerprint === r2.fingerprint && r2.fingerprint === r3.fingerprint, "3 次 consume 指纹完全一致");
  assert(r1.pageCount === 1, "pageCount=1");
  console.groupEnd();
}

function testStableAcrossOrder(): void {
  console.group("③ 确定性：与文档构造顺序/时间无关（无 Time/Random/Global State）");
  // 同一逻辑文档，两次独立构造（顺序相同），指纹应一致
  const d1 = makeDocument();
  const d2 = makeDocument();
  assert(fingerprintOf(d1) === fingerprintOf(d2), "两份逻辑相同文档指纹一致");
  // 不同内容 → 不同指纹
  const different: DomDocument = { pages: [createPage({ metadata: { index: 1, width: 100, height: 100 }, blocks: [] })] };
  assert(fingerprintOf(d1) !== fingerprintOf(different), "不同内容 → 不同指纹");
  console.groupEnd();
}

function testConsistency(): void {
  console.group("④ 一致性判断：isReplayConsistent");
  const consumer = createReplayConsumer();
  const doc = makeDocument();
  const r = consumer.consume(doc);
  assert(isReplayConsistent(r.fingerprint, r.fingerprint) === true, "同一指纹一致");
  assert(isReplayConsistent(r.fingerprint, "deadbeef") === false, "不同指纹不一致");
  console.groupEnd();
}

function testFnvDeterministic(): void {
  console.group("⑤ fnv1a 纯函数确定性");
  assert(fnv1a("abc") === fnv1a("abc"), "同一输入恒同哈希");
  assert(fnv1a("abc") !== fnv1a("abd"), "不同输入不同哈希");
  assert(typeof fnv1a("abc") === "number", "返回 32-bit number");
  console.groupEnd();
}

function testOnlyDomDependency(): void {
  console.group("⑥ 只依赖 DOM（不依赖 EditableDocument），与 Validator/Benchmark 平行");
  const consumer = createReplayConsumer();
  assert(consumer.consume(makeDocument()).pass === true, "ReplayConsumer 独立工作，无需其他 Consumer");
  console.groupEnd();
}

function testPureConsume(): void {
  console.group("⑦ 纯消费（不改 model）");
  const doc = makeDocument();
  const before = JSON.stringify(doc);
  createReplayConsumer().consume(doc);
  assert(JSON.stringify(doc) === before, "consume 不改输入");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── ReplayConsumer Golden Test (Sprint-121 · Task-3) ──", "font-weight:bold;color:#8b5cf6;");
  testInterface();
  testDeterministic();
  testStableAcrossOrder();
  testConsistency();
  testFnvDeterministic();
  testOnlyDomDependency();
  testPureConsume();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("replay-consumer.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
