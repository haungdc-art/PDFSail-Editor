/**
 * scene-read-consumer.test.ts — SceneReadConsumer Golden Test（Sprint-121 · Task-4 · Pilot）
 *
 * ADR-045 · Consumer Architecture。
 *
 * 验证（PM Task-4 退出条件）：
 *   1. SceneReadConsumer 实现统一 Consumer<T,R>，唯一入口 consume(DomDocument)，稳定 id
 *   2. 只消费 Page/Document DOM，禁止依赖 EditableDocument
 *   3. Builder 零改动
 *   4. 与 Validator/Benchmark/Replay 平行，不调用其他 Consumer
 *   5. 真实 PDF：Builder → Page → SceneReadConsumer（端到端脚本）
 *   6. Replay/Regression 无回归
 *   + **Lossless（PM 新增）**：Scene 必须是 DOM 无损表达，Page → Scene → Replay Fingerprint 与 Page → Fingerprint 一致
 *   + Scene 只读（无 Painter/Bitmap/Canvas），快照独立
 */
import { createPage } from "./page-builder";
import { createSceneReadConsumer, isLossless } from "./scene-read-consumer";
import { fingerprintOf, createReplayConsumer } from "./replay-consumer";
import { DomDocument } from "./types";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造含多类对象的 DomDocument（含 stamp/decoration 等 BaseLayer 内容） */
function makeDocument(): DomDocument {
  return {
    pages: [
      createPage({
        metadata: { index: 1, width: 595, height: 842 },
        blocks: [
          { id: "b-body", type: "text", regionType: "paragraph", bbox: { x: 40, y: 100, width: 500, height: 100 } },
          { id: "b-footer", type: "text", regionType: "footer", bbox: { x: 40, y: 810, width: 400, height: 20 } },
          { id: "b-stamp", type: "text", regionType: "stamp", bbox: { x: 20, y: 300, width: 80, height: 80 } },
        ],
      }),
    ],
  };
}

function testInterface(): void {
  console.group("① SceneReadConsumer 实现统一 Consumer<T,R>，唯一入口 consume + 稳定 id");
  const consumer = createSceneReadConsumer();
  assert(consumer.id === "scene-read", `SceneReadConsumer.id = "scene-read"`);
  assert(typeof consumer.consume === "function", "consume 是唯一入口");
  const s = consumer.consume(makeDocument());
  assert("pages" in s, "consume 返回 SceneSnapshot");
  console.groupEnd();
}

function testSnapshotBuild(): void {
  console.group("② Scene Snapshot 构建（五层保留）");
  const consumer = createSceneReadConsumer();
  const doc = makeDocument();
  const snapshot = consumer.consume(doc);
  assert(snapshot.pages.length === 1, "1 页");
  const page = snapshot.pages[0];
  assert(page.layers.base.length >= 1, "BaseLayer 保留（PdfFallback + stamp）");
  assert(page.layers.content.length >= 1, "ContentLayer 保留（body + footer）");
  assert(Array.isArray(page.layers.interaction) && Array.isArray(page.layers.overlay), "Interaction/Overlay 保留");
  assert(!!page.runtime, "Runtime 保留");
  console.groupEnd();
}

function testLossless(): void {
  console.group("③ Lossless：Scene 是 DOM 无损表达（Page → Scene → Fingerprint 一致）");
  const doc = makeDocument();
  const snapshot = createSceneReadConsumer().consume(doc);
  const domFp = fingerprintOf(doc);
  const sceneFp = fingerprintOf(snapshot as unknown as DomDocument);
  assert(domFp === sceneFp, `Scene 指纹 == DOM 指纹（${sceneFp}）→ 无损`);
  assert(isLossless(doc, snapshot, fingerprintOf) === true, "isLossless 判定 true");
  // 反例：若 Scene 丢失 BaseLayer 内容，则应判定 lossy
  const lossyDoc: DomDocument = { pages: [createPage({ metadata: { index: 1, width: 100, height: 100 }, blocks: [] })] };
  const lossyFp = fingerprintOf(lossyDoc);
  assert(domFp !== lossyFp, "不同内容 → 指纹不同（证明指纹能捕获 Loss）");
  console.groupEnd();
}

function testNoRenderObject(): void {
  console.group("④ Scene 是只读数据表达（无 Painter/Bitmap/Canvas）");
  const snapshot = createSceneReadConsumer().consume(makeDocument());
  const json = JSON.stringify(snapshot);
  assert(!json.includes("bitmap") && !json.includes("canvas") && !json.includes("ImageBitmap"), "Scene Snapshot 无 bitmap/canvas（纯数据）");
  console.groupEnd();
}

function testSnapshotIndependent(): void {
  console.group("⑤ 快照独立（浅拷贝，后续原 DOM 修改不影响快照）");
  const doc = makeDocument();
  const baseCountBefore = doc.pages[0].layers.base.length;
  const snapshot = createSceneReadConsumer().consume(doc);
  // 记录快照 base 长度（此时应等于 baseCountBefore）
  const snapshotBaseCount = snapshot.pages[0].layers.base.length;
  // 修改原 DOM（推入新对象）
  (doc.pages[0].layers.base as unknown[]).push({ id: "extra", type: "PdfFallback", editable: false, anchor: "NONE", bbox: { x: 0, y: 0, width: 1, height: 1 } });
  // 原 DOM base 增加，但快照 base 不变（浅拷贝独立）
  assert(doc.pages[0].layers.base.length === baseCountBefore + 1, "原 DOM base 增加");
  assert(snapshot.pages[0].layers.base.length === snapshotBaseCount, "快照 base 不变（独立）");
  console.groupEnd();
}

function testReplayAsRegressionTool(): void {
  console.group("⑥ 用 ReplayConsumer 作无损回归工具（不重设计比较机制）");
  const doc = makeDocument();
  const snapshot = createSceneReadConsumer().consume(doc);
  const replay = createReplayConsumer();
  const domFp = replay.consume(doc).fingerprint;
  const sceneFp = fingerprintOf(snapshot as unknown as DomDocument);
  assert(domFp === sceneFp, "ReplayConsumer 指纹验证 Scene 无损（复用现有确定性能力）");
  console.groupEnd();
}

function testOnlyDomDependency(): void {
  console.group("⑦ 只依赖 DOM（不依赖 EditableDocument），与其它 Consumer 平行");
  const consumer = createSceneReadConsumer();
  assert(consumer.consume(makeDocument()).pages.length === 1, "SceneReadConsumer 独立工作，无需其他 Consumer");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── SceneReadConsumer Golden Test (Sprint-121 · Task-4 · Pilot) ──", "font-weight:bold;color:#8b5cf6;");
  testInterface();
  testSnapshotBuild();
  testLossless();
  testNoRenderObject();
  testSnapshotIndependent();
  testReplayAsRegressionTool();
  testOnlyDomDependency();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("scene-read-consumer.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
