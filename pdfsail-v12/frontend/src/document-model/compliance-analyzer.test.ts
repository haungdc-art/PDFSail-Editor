/**
 * compliance-analyzer.test.ts — Compliance Analyzer 测试
 *
 * 验证 Analyzer 能正确检测"reconstruct 是否覆盖 non-text"（Decision-001）。
 *
 * 运行：npx tsx frontend/src/document-model/compliance-analyzer.test.ts
 */
import { analyzeCompliance, formatCompliance } from "./compliance-analyzer";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造 w×h RGBA */
function makeRGBA(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fill(x, y);
    const i = (y * w + x) * 4;
    arr[i] = r; arr[i + 1] = g; arr[i + 2] = b; arr[i + 3] = a;
  }
  return arr;
}

function testCompliant(): void {
  console.group("① 合规：只改 mask=1（文字）像素 → changedNonText=0");
  const w = 10, h = 10;
  // 全白 before
  const before = makeRGBA(w, h, () => [255, 255, 255, 255]);
  // after：只改 mask=1 区域为黑色（模拟只擦文字）
  const mask = new Uint8Array(w * h);
  const after = before.slice();
  for (let y = 2; y < 4; y++) for (let x = 2; x < 5; x++) { mask[y * w + x] = 1; const i = (y * w + x) * 4; after[i]=0; after[i+1]=0; after[i+2]=0; }
  const a = analyzeCompliance(before, after, mask, w, h);
  assert(a.changedNonTextPixels === 0, `changedNonText=0（实际 ${a.changedNonTextPixels}）`);
  assert(a.changedTextPixels === 6, `changedText=6（2x3=6 个文字像素）`);
  assert(a.compliant === true, "compliant=true");
  assert(a.changedBBox?.width === 3 && a.changedBBox.height === 2, "BBox 正确");
  console.groupEnd();
}

function testViolation(): void {
  console.group("② 违规：改 mask=0（non-text）像素 → changedNonText>0");
  const w = 10, h = 10;
  const before = makeRGBA(w, h, () => [255, 255, 255, 255]);
  const mask = new Uint8Array(w * h); // 全 0（无文字）
  const after = before.slice();
  // 改一个 non-text 像素（mask=0 但被覆盖）
  after[3 * w * 4] = 0; after[3 * w * 4 + 1] = 0; after[3 * w * 4 + 2] = 0;
  const a = analyzeCompliance(before, after, mask, w, h);
  assert(a.changedNonTextPixels === 1, `changedNonText=1（实际 ${a.changedNonTextPixels}）`);
  assert(a.compliant === false, "compliant=false（violation）");
  assert(a.nonTextViolations.length === 1, "记录 violation 坐标");
  console.groupEnd();
}

function testNoChange(): void {
  console.group("③ 无变化 → changed=0, BBox=null");
  const w = 10, h = 10;
  const before = makeRGBA(w, h, () => [255, 255, 255, 255]);
  const mask = new Uint8Array(w * h);
  const a = analyzeCompliance(before, before.slice(), mask, w, h);
  assert(a.changedPixels === 0 && a.changedBBox === null, "无变化");
  assert(a.compliant === true, "无变化 → compliant");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Compliance Analyzer Test (Decision-001 验收) ──", "font-weight:bold;color:#22c55e;");
  testCompliant();
  testViolation();
  testNoChange();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/").replace(/^\//, "");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("compliance-analyzer.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
