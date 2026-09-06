/**
 * rule-engine-smoke.test.ts — Sprint35 · D3-3E（Rule Engine Smoke Test）
 *
 * 验证 Rule Engine 能够稳定承载业务 Rule，而不是继续堆 Rule。
 *
 * 覆盖两条 Case：
 *   Case 1: Unknown    → IgnoreUnknownRule → ignore
 *   Case 2: Signature  → SignatureRule     → analyze_visual
 *
 * 验证整条链路已跑通：
 *   DecisionContext → Resolver → Registry → Rule → Proposal → Decision
 *
 * 运行方式（浏览器控制台）：
 *   (await import("/src/document-model/resolver/rule-engine-smoke.test.ts")).runAllTests()
 */

import { DefaultProcessingDecisionResolver } from "./default-processing-decision-resolver";
import { IgnoreUnknownRule } from "./ignore-unknown-rule";
import { SignatureRule } from "./signature-rule";
import { SimpleIncrementDecisionIdProvider } from "./simple-increment-decision-id-provider";
import type { DecisionContext } from "../decision-context";
import { VisualObjectType, VisualRepresentation } from "../visual-semantic";
import type { EngineCapability } from "../engine-capability";

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

/** 构造一个含指定 objectType 的 DecisionContext（capability 用占位值） */
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

// ── 业务规则 Registry（含冒烟 Rule + 业务 Rule）──────────────

/** 含两条 Rule 的 Registry：验证 Engine 承载多个业务 Rule */
const businessRuleRegistry = {
  getRules() {
    return [IgnoreUnknownRule, SignatureRule];
  },
};

// ── Case 1: Unknown → IgnoreUnknownRule → ignore ────────────────

function testUnknownIgnore(): void {
  console.group("%cCase 1: Unknown → ignore", "font-weight:bold;color:#f59e0b;");

  const resolver = DefaultProcessingDecisionResolver(businessRuleRegistry, SimpleIncrementDecisionIdProvider);
  const list = resolver.resolve(makeContext(VisualObjectType.Unknown));

  assert(list.decisions.length === 1, "Unknown → exactly 1 decision", `got ${list.decisions.length}`);
  assert(list.decisions[0]?.type === "ignore", "Unknown → decision.type = ignore", `got ${list.decisions[0]?.type}`);
  assert(list.decisions[0]?.reasonCode === "unknown-object", "Unknown → reasonCode = unknown-object", `got ${list.decisions[0]?.reasonCode}`);
  assert(typeof list.decisions[0]?.id === "string" && list.decisions[0]!.id.length > 0, "Decision has generated id", `got ${list.decisions[0]?.id}`);

  console.groupEnd();
}

// ── Case 2: Signature → SignatureRule → analyze_visual ─────────

function testSignatureAnalyzeVisual(): void {
  console.group("%cCase 2: Signature → analyze_visual", "font-weight:bold;color:#f59e0b;");

  const resolver = DefaultProcessingDecisionResolver(businessRuleRegistry, SimpleIncrementDecisionIdProvider);
  const list = resolver.resolve(makeContext(VisualObjectType.Signature));

  assert(list.decisions.length === 1, "Signature → exactly 1 decision", `got ${list.decisions.length}`);
  assert(list.decisions[0]?.type === "analyze_visual", "Signature → decision.type = analyze_visual", `got ${list.decisions[0]?.type}`);
  assert(list.decisions[0]?.priority === "high", "Signature → priority = high", `got ${list.decisions[0]?.priority}`);
  assert(list.decisions[0]?.reasonCode === "signature-requires-visual-analysis", "Signature → reasonCode set", `got ${list.decisions[0]?.reasonCode}`);

  console.groupEnd();
}

// ── Case 3: Multi-rule coexistence（Signature + Unknown 同时接入）──

function testMultiRuleCoexistence(): void {
  console.group("%cCase 3: Multi-rule coexistence", "font-weight:bold;color:#f59e0b;");

  const resolver = DefaultProcessingDecisionResolver(businessRuleRegistry, SimpleIncrementDecisionIdProvider);

  // Signature context：只命中 SignatureRule，IgnoreUnknownRule 返回 null
  const sigList = resolver.resolve(makeContext(VisualObjectType.Signature));
  assert(sigList.decisions.length === 1, "Signature + multi-rule → 1 decision (not 2)", `got ${sigList.decisions.length}`);
  assert(sigList.decisions[0]?.type === "analyze_visual", "Signature + multi-rule → analyze_visual", `got ${sigList.decisions[0]?.type}`);

  // Unknown context：只命中 IgnoreUnknownRule，SignatureRule 返回 null
  const unknownList = resolver.resolve(makeContext(VisualObjectType.Unknown));
  assert(unknownList.decisions.length === 1, "Unknown + multi-rule → 1 decision (not 2)", `got ${unknownList.decisions.length}`);
  assert(unknownList.decisions[0]?.type === "ignore", "Unknown + multi-rule → ignore", `got ${unknownList.decisions[0]?.type}`);

  // 不相关类型：无 Rule 命中 → 0 decision
  const textList = resolver.resolve(makeContext(VisualObjectType.Text));
  assert(textList.decisions.length === 0, "Text + multi-rule → 0 decision", `got ${textList.decisions.length}`);

  console.groupEnd();
}

// ── Test Runner ─────────────────────────────────────────────────

export function runAllTests(): TestResult[] {
  results = [];
  console.log(
    "%c── Rule Engine Smoke Test (Sprint35 · D3-3E) ──",
    "font-weight:bold;font-size:14px;color:#8b5cf6;",
  );

  testUnknownIgnore();
  testSignatureAnalyzeVisual();
  testMultiRuleCoexistence();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) {
    console.log("%cFAILED: %d", "color:#ef4444", failed);
  }

  return results;
}
