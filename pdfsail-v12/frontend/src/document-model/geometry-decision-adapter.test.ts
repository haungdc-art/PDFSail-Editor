/**
 * geometry-decision-adapter.test.ts — Sprint36 · Story-1 Commit 1.2（Fake Geometry Test）
 *
 * 用最小验证证明：Decision 真正驱动 Geometry。
 *
 *   Decision
 *        ↓
 *   GeometryDecisionAdapter
 *        ↓
 *   GeometryRequest
 *        ↓
 *   Fake Geometry Engine（console.log 模拟，证明请求真正到达 Geometry）
 *
 * 【不是 Integration Test，是 Adapter 验证 + Fake Geometry 接收证明。】
 *
 * 运行方式（浏览器控制台）：
 *   (await import("/src/document-model/geometry-decision-adapter.test.ts")).runAllTests()
 */

import { GeometryDecisionAdapter, GeometryTargetKind, type GeometryRequest } from "./geometry-decision-adapter";
import type { DecisionContext } from "./decision-context";
import type { ProcessingDecision } from "./processing-decision";
import { VisualObjectType, VisualRepresentation } from "./visual-semantic";
import type { EngineCapability } from "./engine-capability";

// ── Helper ──────────────────────────────────────────────────────

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
}

let results: TestResult[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  results.push({ name, pass: condition, detail });
  if (condition) {
    console.log(`  %c✓ %s`, "color:#22c55e;", name);
  } else {
    console.log(`  %c✗ %s%c ${detail ?? ""}`, "color:#ef4444;", name, "");
  }
}

/** 构造一个含指定 objectType 的 DecisionContext */
function makeContext(objectType: VisualObjectType): DecisionContext {
  const semantic = {
    objectType,
    representation: VisualRepresentation.Unknown,
    confidence: 0.9,
    evidence: [],
  };
  const capability: EngineCapability = {
    supportsGeometry: false,
    supportsOCR: false,
    supportsMetadata: false,
    supportsDecode: false,
  };
  return { semantic, capability };
}

/** 构造一个 analyze_visual 决策（模拟 SignatureRule 产出） */
function makeAnalyzeVisualDecision(): ProcessingDecision {
  return {
    id: "decision-0001",
    type: "analyze_visual",
    priority: "high",
    reasonCode: "signature-requires-visual-analysis",
  };
}

/** Fake Geometry Engine：接收 GeometryRequest 并记录，证明请求真正到达 Geometry */
const fakeGeometryEngine = {
  received: [] as GeometryRequest[],
  handle(request: GeometryRequest): void {
    this.received.push(request);
    console.log("    [FakeGeometry] request:", JSON.stringify(request));
  },
};

// ── Case 1: Signature → GeometryRequest(signature) → Fake Geometry 收到 ──

function testSignatureDrivesGeometry(): void {
  console.group("%cCase 1: Signature → Geometry (signature)", "font-weight:bold;color:#f59e0b;");

  const context = makeContext(VisualObjectType.Signature);
  const decision = makeAnalyzeVisualDecision();
  const target = { id: "sig-block-1", kind: GeometryTargetKind.Region };

  const requests = GeometryDecisionAdapter.adapt([{ decision, context, target }]);
  assert(requests.length === 1, "Signature → exactly 1 GeometryRequest", `got ${requests.length}`);
  assert(requests[0]?.target.id === "sig-block-1", "Request.target.id 正确", `got ${requests[0]?.target.id}`);
  assert(requests[0]?.target.kind === "region", "Request.target.kind 支持 region（Composite）", `got ${requests[0]?.target.kind}`);
  assert(requests[0]?.geometryKind === "signature", "Request.geometryKind = signature", `got ${requests[0]?.geometryKind}`);

  // Fake Geometry 收到请求（证明 Decision 真正驱动 Geometry）
  fakeGeometryEngine.received = [];
  for (const r of requests) fakeGeometryEngine.handle(r);
  assert(fakeGeometryEngine.received.length === 1, "Fake Geometry 收到 1 个请求", `got ${fakeGeometryEngine.received.length}`);

  console.groupEnd();
}

// ── Case 2: Stamp → GeometryRequest(stamp) ─────────────────────

function testStampDrivesGeometry(): void {
  console.group("%cCase 2: Stamp → Geometry (stamp)", "font-weight:bold;color:#f59e0b;");

  const context = makeContext(VisualObjectType.Stamp);
  const decision = makeAnalyzeVisualDecision();
  const target = { id: "stamp-block-1", kind: GeometryTargetKind.Block };

  const requests = GeometryDecisionAdapter.adapt([{ decision, context, target }]);
  assert(requests.length === 1, "Stamp → exactly 1 GeometryRequest", `got ${requests.length}`);
  assert(requests[0]?.geometryKind === "stamp", "Request.geometryKind = stamp", `got ${requests[0]?.geometryKind}`);
  assert(requests[0]?.target.kind === GeometryTargetKind.Block, "Request.target.kind 支持 block", `got ${requests[0]?.target.kind}`);

  console.groupEnd();
}

// ── Case 3: 不相关类型（Text）→ 不生成 GeometryRequest ─────────

function testTextNoGeometry(): void {
  console.group("%cCase 3: Text → no GeometryRequest", "font-weight:bold;color:#f59e0b;");

  const context = makeContext(VisualObjectType.Text);
  const decision = makeAnalyzeVisualDecision();
  const target = { id: "text-block-1", kind: GeometryTargetKind.Block };

  const requests = GeometryDecisionAdapter.adapt([{ decision, context, target }]);
  assert(requests.length === 0, "Text → 0 GeometryRequest", `got ${requests.length}`);

  console.groupEnd();
}

// ── Case 4: 非 analyze_visual 决策 → 不生成 ─────────────────────

function testNonVisualDecisionNoGeometry(): void {
  console.group("%cCase 4: non-analyze_visual → no GeometryRequest", "font-weight:bold;color:#f59e0b;");

  const context = makeContext(VisualObjectType.Signature);
  // 即使对象是 Signature，但决策是 decode（非 analyze_visual）→ 不驱动 Geometry
  const decision: ProcessingDecision = { id: "d2", type: "decode", priority: "high", reasonCode: "qr-decode" };
  const target = { id: "sig-block-2", kind: GeometryTargetKind.Block };

  const requests = GeometryDecisionAdapter.adapt([{ decision, context, target }]);
  assert(requests.length === 0, "decode 决策 → 0 GeometryRequest", `got ${requests.length}`);

  console.groupEnd();
}

// ── Test Runner ─────────────────────────────────────────────────

export function runAllTests(): TestResult[] {
  results = [];
  console.log(
    "%c── Geometry Decision Adapter Test (Sprint36 · Story-1 Commit1.2) ──",
    "font-weight:bold;font-size:14px;color:#8b5cf6;",
  );

  testSignatureDrivesGeometry();
  testStampDrivesGeometry();
  testTextNoGeometry();
  testNonVisualDecisionNoGeometry();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) {
    console.log("%cFAILED: %d", "color:#ef4444", failed);
  }

  return results;
}
