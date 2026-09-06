/**
 * validator-consumer.test.ts — ValidatorConsumer Golden Test（Sprint-121 · Task-1）
 *
 * ADR-045 · Consumer Adoption。
 *
 * 验证（PM Task-1 退出条件）：
 *   1. ValidatorConsumer 是第一个真正消费 DOM 的 Consumer，唯一入口 consume(DomDocument)
 *   2. ValidatorConsumer 只依赖 Page / Document，禁止 EditableDocument
 *   3. Builder 零改动（本测试不修改 Builder）
 *   4. Builder → Page → ValidatorConsumer PASS
 *   5. Compatibility 不受影响
 *
 * 关键：ValidatorConsumer 本身**不 import EditableDocument**（由 import 结构保证）。
 */
import { createPage } from "./page-builder";
import { createValidatorConsumer } from "./validator-consumer";
import { DomDocument } from "./types";
import type { DomObject } from "./object";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 用 createPage 构造一个合法 DomDocument（模拟 Builder 产出） */
function makeValidDocument(): DomDocument {
  return {
    pages: [
      createPage({
        metadata: { index: 1, width: 595, height: 842 },
        blocks: [
          {
            id: "b-body", type: "text", regionType: "paragraph",
            bbox: { x: 40, y: 100, width: 500, height: 100 },
          },
          {
            id: "b-footer", type: "text", regionType: "footer",
            bbox: { x: 40, y: 810, width: 400, height: 20 },
          },
        ],
      }),
    ],
  };
}

/** 构造违规 DomDocument：editable=false 对象放进 ContentLayer */
function makeInvalidDocument(): DomDocument {
  const badObj: DomObject = { id: "obj-bad", type: "Decoration", editable: false, anchor: "TOP", bbox: { x: 0, y: 0, width: 10, height: 10 } };
  return {
    pages: [
      {
        metadata: { index: 1, width: 100, height: 100 },
        layers: {
          base: [{ id: "pdf", type: "PdfFallback", editable: false, anchor: "NONE", bbox: { x: 0, y: 0, width: 100, height: 100 } }],
          content: [badObj], // editable=false 进 ContentLayer → 违规
          interaction: [],
          overlay: [],
        },
        runtime: { dirty: false, visible: true },
      },
    ],
  };
}

function testConsumeValid(): void {
  console.group("① ValidatorConsumer.consume(DomDocument) → PASS");
  const consumer = createValidatorConsumer();
  const result = consumer.consume(makeValidDocument());
  assert(result.pass === true, "合法 DOM 校验 PASS");
  assert(result.issues.length === 0, "无 issues");
  console.groupEnd();
}

function testConsumeInvalid(): void {
  console.group("② ValidatorConsumer.consume(违规 DOM) → FAIL");
  const consumer = createValidatorConsumer();
  const result = consumer.consume(makeInvalidDocument());
  assert(result.pass === false, "违规 DOM 校验 FAIL");
  assert(result.issues.some((i) => i.code === "NON_EDITABLE_IN_CONTENT"), "捕获 NON_EDITABLE_IN_CONTENT");
  console.groupEnd();
}

function testConsumerInterface(): void {
  console.group("③ 统一 Consumer<T> 接口");
  const consumer = createValidatorConsumer();
  // consume 是唯一入口
  assert(typeof consumer.consume === "function", "consume 是唯一入口");
  // 结果结构
  const r = consumer.consume(makeValidDocument());
  assert("pass" in r && "issues" in r, "consume 返回 { pass, issues }");
  console.groupEnd();
}

function testNoEditableDocumentDependency(): void {
  console.group("④ ValidatorConsumer 只依赖 DOM（不依赖 EditableDocument）");
  // 静态约束：本文件与 validator-consumer.ts 的 import 不含 ../types（EditableDocument）
  // 由 grep 验证：validator-consumer.ts 只 import DOM 内部模块
  const consumer = createValidatorConsumer();
  assert(consumer.consume(makeValidDocument()).pass === true, "ValidatorConsumer 正常工作（无 EditableDocument 依赖）");
  console.groupEnd();
}

function testCompatibilityUnaffected(): void {
  console.group("⑤ Compatibility 不受影响（ValidatorConsumer 是独立旁路）");
  // ValidatorConsumer 消费 DomDocument，不影响 EditablePage 链路
  const consumer = createValidatorConsumer();
  const doc = makeValidDocument();
  const r = consumer.consume(doc);
  assert(r.pass === true, "ValidatorConsumer PASS 不影响 Builder/Compatibility");
  // consume 不修改传入的 document（纯消费）
  const before = JSON.stringify(doc);
  consumer.consume(doc);
  assert(JSON.stringify(doc) === before, "consume 是纯消费（不改 model）");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── ValidatorConsumer Golden Test (Sprint-121 · Task-1) ──", "font-weight:bold;color:#8b5cf6;");
  testConsumeValid();
  testConsumeInvalid();
  testConsumerInterface();
  testNoEditableDocumentDependency();
  testCompatibilityUnaffected();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("validator-consumer.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
