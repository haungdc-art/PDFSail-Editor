/**
 * compliance-acceptance.test.ts — Compliance-2 验收（Decision-001）
 *
 * 端到端：detectGlyphMask → reconstructPixels → analyzeCompliance
 * 验证：含"文字 + 表格线"的图像，重建后 changedNonText 是否 = 0（表格线未覆盖）。
 *
 * 若表格线被 excludeLines 排除（mask=0）→ reconstruct 不改 → changedNonText=0 → ✅ 合规
 * 若表格线未排除（mask=1）→ reconstruct 覆盖 → changedNonText>0 → ❌ 违规
 *
 * 运行：npx tsx frontend/src/document-model/compliance-acceptance.test.ts
 */
import { detectGlyphMask } from "./glyph-mask";
import { analyzeCompliance, formatCompliance } from "./compliance-analyzer";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 内联 reconstruct（与 background-text-remover 的 reconstructPixels 等价）：mask=1 → bgColor，mask=0 → 保留 */
function reconstruct(imageData: ImageData, mask: Uint8Array, bgColor: [number, number, number]): Uint8ClampedArray {
  const src = imageData.data;
  const dst = new Uint8ClampedArray(src.length);
  const w = imageData.width;
  for (let i = 0; i < w * imageData.height; i++) {
    const px = i * 4;
    if (mask[i] === 1) {
      dst[px] = bgColor[0]; dst[px + 1] = bgColor[1]; dst[px + 2] = bgColor[2]; dst[px + 3] = 255;
    } else {
      dst[px] = src[px]; dst[px + 1] = src[px + 1]; dst[px + 2] = src[px + 2]; dst[px + 3] = src[px + 3];
    }
  }
  return dst;
}

/** 构造图像：白底 + 暗文字字形（短 run）+ 暗表格横线（长 run）+ 暗边框（垂直长 run） */
function buildScenario(w: number, h: number): { imageData: ImageData; textPixels: Set<number>; linePixels: Set<number> } {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const textPixels = new Set<number>();
  const linePixels = new Set<number>();
  const setDark = (i: number) => { data[i*4]=0; data[i*4+1]=0; data[i*4+2]=0; };

  // 文字字形（短 run）：3x4 块（y=3..6, x=4..6）
  for (let y = 3; y < 7; y++) for (let x = 4; x < 7; x++) { setDark(y*w+x); textPixels.add(y*w+x); }
  // 表格横线（长 run）：y=2 整行
  for (let x = 0; x < w; x++) { setDark(2*w+x); linePixels.add(2*w+x); }
  // 表格竖线/边框（长 run）：x=8 整列
  for (let y = 0; y < h; y++) { setDark(y*w+8); linePixels.add(y*w+8); }

  return { imageData: { data, width: w, height: h } as unknown as ImageData, textPixels, linePixels };
}

function testCompliance2(): void {
  console.group("① Compliance-2: 文字+表格线场景 → changedNonText=0?");
  const w = 20, h = 20;
  const { imageData } = buildScenario(w, h);
  const mask = detectGlyphMask(imageData, w, h); // excludeLines 默认 true
  const after = reconstruct(imageData, mask, [255, 255, 255]);
  const a = analyzeCompliance(imageData.data, after, mask, w, h);

  console.log(formatCompliance(a));
  assert(a.compliant === true, `合规（changedNonText=${a.changedNonTextPixels}）`);

  // 表格线像素（linePixels）不应被覆盖（mask=0 + before==after）
  const { linePixels } = buildScenario(w, h);
  let lineChanged = 0;
  for (const i of linePixels) {
    const px = i * 4;
    if (imageData.data[px] !== after[px]) lineChanged++;
  }
  assert(lineChanged === 0, `表格线保留（0 被覆盖，实际 ${lineChanged}）`);
  console.groupEnd();
}

function testNoExcludeLines(): void {
  console.group("② 对照组：excludeLines=false（旧行为）→ 表格线被覆盖（违规）");
  const w = 20, h = 20;
  const { imageData, linePixels } = buildScenario(w, h);
  const mask = detectGlyphMask(imageData, w, h, { excludeLines: false }); // 旧行为
  const after = reconstruct(imageData, mask, [255, 255, 255]);
  const a = analyzeCompliance(imageData.data, after, mask, w, h);
  let lineChanged = 0;
  for (const i of linePixels) {
    const px = i * 4;
    if (imageData.data[px] !== after[px]) lineChanged++;
  }
  console.log(`旧行为: changedNonText=${a.changedNonTextPixels}, 表格线被覆盖=${lineChanged}`);
  assert(lineChanged > 0, `旧行为表格线被覆盖（${lineChanged}）→ 对照组确认 Analyzer 能检测违规`);
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Compliance-2 验收 (Decision-001) ──", "font-weight:bold;color:#22c55e;");
  testCompliance2();
  testNoExcludeLines();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/").replace(/^\//, "");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("compliance-acceptance.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
