/**
 * glyph-mask.test.ts — Implementation-001 Phase-1 · Compliance-1
 *
 * 验证 GlyphDetector（detectGlyphMask）：
 *   - 暗像素（gray<128）→ mask=1（文字/线条）
 *   - 亮像素（gray>=128）→ mask=0（背景）
 *   - 与旧 eraseTextPixels 的判定一致（C1 Behavior preserved）
 *
 * 运行：npx tsx frontend/src/document-model/glyph-mask.test.ts
 */
import { detectGlyphMask, emptyGlyphMask, countGlyphPixels, DARK_THRESHOLD } from "./glyph-mask";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造 2x2 ImageData */
function makeImageData(rgba: number[]): ImageData {
  return { data: new Uint8ClampedArray(rgba), width: 2, height: 2 } as unknown as ImageData;
}

function testDarkDetection(): void {
  console.group("① 暗像素 → mask=1（文字/线条，excludeLines 关）");
  // 2x2，全黑（gray=0 < 128）；excludeLines:false 只测灰度判定（Compliance-1 行为）
  const black = makeImageData([0,0,0,255, 0,0,0,255, 0,0,0,255, 0,0,0,255]);
  const m = detectGlyphMask(black, 2, 2, { excludeLines: false });
  assert(m[0] === 1 && m[1] === 1 && m[2] === 1 && m[3] === 1, "全黑 → mask 全 1");
  console.groupEnd();
}

function testLightDetection(): void {
  console.group("② 亮像素 → mask=0（背景）");
  const white = makeImageData([255,255,255,255, 255,255,255,255, 255,255,255,255, 255,255,255,255]);
  const m = detectGlyphMask(white, 2, 2, { excludeLines: false });
  assert(m[0] === 0 && m[1] === 0 && m[2] === 0 && m[3] === 0, "全白 → mask 全 0");
  console.groupEnd();
}

function testMixed(): void {
  console.group("③ 混合：暗像素 vs 亮像素（excludeLines 关）");
  // 2x2: [黑, 白, 灰128, 灰100]
  // 注：灰128 因浮点精度 (128*0.299+128*0.587+128*0.114=127.999...) 略小于 128 → mask=1，
  //     这与旧 eraseTextPixels 的判定完全一致（C1 Behavior preserved），非 bug。
  const mixed = makeImageData([0,0,0,255, 255,255,255,255, 128,128,128,255, 100,100,100,255]);
  const m = detectGlyphMask(mixed, 2, 2, { excludeLines: false });
  assert(m[0] === 1, "纯黑(0) → 1");
  assert(m[1] === 0, "纯白(255) → 0");
  assert(m[2] === 1, "灰128（浮点 127.999<128，与旧算法一致）→ 1");
  assert(m[3] === 1, "灰100 (明确暗) → 1");
  console.groupEnd();
}

/** Compliance-2：排除表格线（长直线） */
function testExcludeLines(): void {
  console.group("⑤ Compliance-2: 排除表格线（长直线）");
  // 构造 8x8 图像：
  //   - 第 3 行全黑（水平长 run = 8 >= 0.5*8=4）→ 表格横线 → mask 应排除
  //   - 第 0 列全黑（垂直长 run = 8 >= 0.5*8=4）→ 表格竖线 → mask 应排除
  //   - 中间一个 2x2 黑块（文字字形，短 run）→ 保留 mask=1
  const w = 8, h = 8;
  const px = new Uint8ClampedArray(w * h * 4).fill(255); // 全白
  // 第 3 行全黑
  for (let x = 0; x < w; x++) { const i = (3 * w + x) * 4; px[i]=0; px[i+1]=0; px[i+2]=0; }
  // 第 0 列全黑
  for (let y = 0; y < h; y++) { const i = (y * w + 0) * 4; px[i]=0; px[i+1]=0; px[i+2]=0; }
  // 2x2 文字块（y=6,7, x=4,5，避开第3行表格线和第0列表格线，短 run 应保留）
  for (let y = 6; y < 8; y++) for (let x = 4; x < 6; x++) { const i = (y * w + x) * 4; px[i]=0; px[i+1]=0; px[i+2]=0; }
  const img = { data: px, width: w, height: h } as unknown as ImageData;

  const m = detectGlyphMask(img, w, h); // 默认 excludeLines: true
  // 表格横线（第3行）应排除
  assert(m[3*w + 0] === 0 && m[3*w + 7] === 0, "水平表格线（非文字区）→ 排除");
  // 表格竖线（第0列）应排除
  assert(m[1*w + 0] === 0 && m[7*w + 0] === 0, "垂直表格线 → 排除");
  // 文字字形（短 run，不在表格线上）保留
  assert(m[6*w + 4] === 1 && m[7*w + 5] === 1, "文字字形（短 run）→ 保留");
  console.groupEnd();
}

function testHelpers(): void {
  console.group("④ 辅助函数");
  const empty = emptyGlyphMask(2, 2);
  assert(empty.length === 4 && empty.every((v) => v === 0), "emptyGlyphMask 全 0");
  const m = new Uint8Array([1, 0, 1, 0]);
  assert(countGlyphPixels(m) === 2, "countGlyphPixels=2");
  assert(DARK_THRESHOLD === 128, "DARK_THRESHOLD=128（与旧 eraseTextPixels 一致）");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── GlyphMask Test (Implementation-001 Compliance-1/2) ──", "font-weight:bold;color:#22c55e;");
  testDarkDetection();
  testLightDetection();
  testMixed();
  testHelpers();
  testExcludeLines();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/").replace(/^\//, "");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("glyph-mask.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
