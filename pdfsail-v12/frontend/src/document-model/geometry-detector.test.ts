/**
 * geometry-detector.test.ts — Sprint-50 Task-011 · Commit 1
 *
 * 验证 Authoritative Rotation Resolution API `resolveBlockRotation`。
 *
 * 测的是 **API Contract**（输入一个 Block → 输出权威 Rotation），
 * 而不是 `transformMatrixToAngle`（那是另一个函数的职责，已有自身测试）。
 * 这样未来 rotation Provider 更换（block.rotation / geometry.rotation / glyph.transform），
 * 这些 Contract 测试依然有效。
 *
 * 运行方式（浏览器控制台）：
 *   (await import("/src/document-model/geometry-detector.test.ts")).runAllTests()
 */

import { resolveBlockRotation } from "./geometry-detector";
import type { TransformMatrix } from "./types";

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
    console.log(`  %c✗ %s`, "color:#ef4444;", name, detail ?? "");
  }
}

interface BlockLike {
  rotation?: number;
  geometry?: { rotation?: number };
  lines: Array<{ glyphs: Array<{ transform?: TransformMatrix }> }>;
}

/** 构造一个 block */
function makeBlock(overrides: Partial<Omit<BlockLike, "lines">> & { glyphTransforms?: (TransformMatrix | undefined)[] } = {}): BlockLike {
  return {
    ...(overrides.rotation != null ? { rotation: overrides.rotation } : {}),
    ...(overrides.geometry != null ? { geometry: overrides.geometry } : {}),
    lines: [
      {
        glyphs: (overrides.glyphTransforms ?? []).map((t) => ({ transform: t })),
      },
    ],
  };
}

const rot7_5: TransformMatrix = [0.9914448613738104, -0.13052619222005157, 0.13052619222005157, 0.9914448613738104, 0, 0]; // -7.5°
const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

// ── Tests（API Contract）────────────────────────────────────────

function testPriority1_blockRotation(): void {
  console.group("Priority 1: block.rotation 优先");
  // block.rotation 显式提供 → 用它（即使 glyph 有不同角度）
  const rot = resolveBlockRotation(makeBlock({ rotation: -3, glyphTransforms: [rot7_5] }));
  assert(Math.abs(rot - (-3)) < 0.01, "block.rotation=-3 → resolve=-3", `got ${rot}`);
  console.groupEnd();
}

function testPriority2_geometryRotation(): void {
  console.group("Priority 2: geometry.rotation 优先于 glyph");
  const rot = resolveBlockRotation(makeBlock({ geometry: { rotation: 5 }, glyphTransforms: [rot7_5] }));
  assert(Math.abs(rot - 5) < 0.01, "geometry.rotation=5 → resolve=5", `got ${rot}`);
  console.groupEnd();
}

function testPriority3_glyphTransform(): void {
  console.group("Priority 3: glyph.transform（倾斜行）");
  const rot = resolveBlockRotation(makeBlock({ glyphTransforms: [rot7_5, rot7_5, rot7_5] }));
  assert(Math.abs(rot - (-7.5)) < 0.01, "glyph 全 -7.5° → resolve=-7.5", `got ${rot}`);
  console.groupEnd();
}

function testHorizontalBlock(): void {
  console.group("水平行（JEFERSON）");
  const rot = resolveBlockRotation(makeBlock({ glyphTransforms: [IDENTITY, IDENTITY, IDENTITY] }));
  assert(Math.abs(rot) < 0.01, "glyph 全 identity → resolve=0", `got ${rot}`);
  console.groupEnd();
}

function testMixedGlyphBlock(): void {
  console.group("混合 glyph（部分倾斜）");
  const rot = resolveBlockRotation(makeBlock({ glyphTransforms: [rot7_5, IDENTITY, IDENTITY] }));
  assert(Math.abs(rot - (-7.5)) < 0.01, "首个非 identity glyph=-7.5° → resolve=-7.5", `got ${rot}`);
  console.groupEnd();
}

function testNoTransform(): void {
  console.group("无 transform / 空 block");
  assert(Math.abs(resolveBlockRotation(makeBlock({ glyphTransforms: [] }))) < 0.01, "空 glyph → resolve=0");
  assert(Math.abs(resolveBlockRotation(makeBlock())) < 0.01, "无 lines → resolve=0");
  console.groupEnd();
}

function testPriorityOrder(): void {
  console.group("优先级顺序（block.rotation > geometry > glyph > 0）");
  const r1 = resolveBlockRotation(makeBlock({ rotation: 2, geometry: { rotation: 3 }, glyphTransforms: [rot7_5] }));
  assert(Math.abs(r1 - 2) < 0.01, "rotation=2 覆盖 geometry=3/glyph → 2", `got ${r1}`);
  const r2 = resolveBlockRotation(makeBlock({ geometry: { rotation: 3 }, glyphTransforms: [rot7_5] }));
  assert(Math.abs(r2 - 3) < 0.01, "geometry=3 覆盖 glyph → 3", `got ${r2}`);
  const r3 = resolveBlockRotation(makeBlock({ glyphTransforms: [rot7_5] }));
  assert(Math.abs(r3 - (-7.5)) < 0.01, "无 rotation/geometry → glyph -7.5", `got ${r3}`);
  const r4 = resolveBlockRotation(makeBlock({ glyphTransforms: [IDENTITY] }));
  assert(Math.abs(r4) < 0.01, "全 identity → 0", `got ${r4}`);
  console.groupEnd();
}

// ── Test Runner ─────────────────────────────────────────────────

export function runAllTests(): TestResult[] {
  results = [];
  console.log(
    "%c── resolveBlockRotation Test (Sprint-50 Task-011 Commit 1) ──",
    "font-weight:bold;font-size:14px;color:#8b5cf6;",
  );

  testPriority1_blockRotation();
  testPriority2_geometryRotation();
  testPriority3_glyphTransform();
  testHorizontalBlock();
  testMixedGlyphBlock();
  testNoTransform();
  testPriorityOrder();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) {
    console.log("%cFAILED: %d", "color:#ef4444", failed);
  }

  return results;
}
