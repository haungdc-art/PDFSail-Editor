/**
 * scene-completeness.test.ts — Scene Completeness Engine Test（Sprint-112）
 *
 * 验证 PM 场景：
 *   1) 文本 PDF (Expected Text=113, Image=1, Vector=1) → Actual 全满足 = 100%
 *   2) 文本 PDF 但 Scene Builder 只建 Text → Completeness < 100%（Missing Image/Vector）
 *   3) 扫描 PDF (Expected Image=1, Text=0) → Actual Image=1 = 100%（无需 glyph>0）
 *   4) 空 Expected = 100%（无对象期望）
 */
import { computeSceneCompleteness, expectedFromCounts, actualFromCounts } from "./scene-completeness";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function testTextPDFComplete(): void {
  console.group("① 文本 PDF，Scene 完整 → 100%");
  const exp = expectedFromCounts({ text: 113, image: 1, vector: 1 });
  const act = actualFromCounts({ text: 113, image: 1, vector: 1 });
  const c = computeSceneCompleteness(exp, act);
  assert(c.complete === true, "complete=true");
  assert(c.ratio === 100, `ratio=${c.ratio}%`);
  assert(c.missing.length === 0, "无缺失");
  console.groupEnd();
}

function testTextPDFMissingImageVector(): void {
  console.group("② 文本 PDF，Scene 只建 Text → <100%");
  const exp = expectedFromCounts({ text: 113, image: 1, vector: 1 });
  const act = actualFromCounts({ text: 113, image: 0, vector: 0 });
  const c = computeSceneCompleteness(exp, act);
  assert(c.complete === false, "complete=false（缺 Image/Vector）");
  assert(c.ratio === 33.3, `ratio=${c.ratio}%（1/3 达标）`);
  assert(c.missing.length === 2, `缺失 2 项（${c.missing.map((m) => m.type).join(",")}）`);
  console.groupEnd();
}

function testScannedPDF(): void {
  console.group("③ 扫描 PDF (Expected Image=1, Text=0) → Image=1 即 100%");
  const exp = expectedFromCounts({ text: 0, image: 1 });
  const act = actualFromCounts({ text: 0, image: 1 });
  const c = computeSceneCompleteness(exp, act);
  assert(c.complete === true, "complete=true（无需 glyph>0，扫描件无文本）");
  assert(c.ratio === 100, `ratio=${c.ratio}%`);
  assert(c.notExpected.includes("text"), "text 标记为 notExpected（本 PDF 无文本）");
  console.groupEnd();
}

function testScannedPDFMissingImage(): void {
  console.group("④ 扫描 PDF 但 Image 缺失 → 0%");
  const exp = expectedFromCounts({ text: 0, image: 1 });
  const act = actualFromCounts({ text: 0, image: 0 });
  const c = computeSceneCompleteness(exp, act);
  assert(c.complete === false, "complete=false（缺 Image）");
  assert(c.ratio === 0, `ratio=${c.ratio}%`);
  console.groupEnd();
}

function testEmptyExpected(): void {
  console.group("⑤ 空 Expected → 100%");
  const c = computeSceneCompleteness(expectedFromCounts({}), actualFromCounts({}));
  assert(c.complete === true && c.ratio === 100, "空期望=100%（无对象要求）");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Scene Completeness Engine Test (Sprint-112) ──", "font-weight:bold;color:#8b5cf6;");
  testTextPDFComplete();
  testTextPDFMissingImageVector();
  testScannedPDF();
  testScannedPDFMissingImage();
  testEmptyExpected();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("scene-completeness.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
