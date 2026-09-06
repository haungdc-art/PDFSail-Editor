/**
 * glyph-column-align.test.ts — M7.8-043-FIX 回归测试
 *
 * 背景（用户报告导出 PDF 的「69」未居中）：
 *   glyph-mapping.ts 的 suffix 平移在编辑某列后把「后续列」文字整体平移，
 *   导致列对齐 / 居中丢失（"69" 右偏 23.6pt）。
 *   修复：按原始坐标检测列边界（列间隙 >> 正常字距），跨列 glyph 保持原位置。
 *
 * 运行：npx tsx frontend/src/document-model/glyph-column-align.test.ts
 */
import { mapNewTextToOriginalGlyphs } from "./glyph-mapping";

type G = any;
const mk = (char: string, x: number, w: number, y = 700, h = 8.5): G => ({
  char,
  originalChar: char,
  modified: false,
  bbox: { x, y, width: w, height: h },
  originalBBox: { x, y, width: w, height: h },
  styleRef: 0,
  transform: [1, 0, 0, 1, x, y] as any,
  metrics: { pdfTransform: [1, 0, 0, 1, x, y] as any },
  baseline: y + h,
  operatorId: "op",
  operatorCharIndex: 0,
});

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

// ── 1. 表格多列：编辑「描述」列后，「数量」列保持居中（不平移）──
{
  console.log("\n[1] 多列表格：编辑描述列，数量列保持原位置");
  // 原行 "4 Bidens 69"：描述列 x≈98.54 结束于 ~127，数量列 "69" 在 x=487.82（居中）
  const glyphs: G[] = [
    mk("4", 72.41, 5.41),
    mk(" ", 77.82, 2.44),
    mk("B", 98.54, 4.77), mk("i", 103.31, 4.77), mk("d", 108.08, 4.77),
    mk("e", 112.85, 4.77), mk("n", 117.62, 4.77), mk("s", 122.39, 4.77),
    mk("6", 487.82, 5.41), mk("9", 498.63, 5.41),
  ];
  // 编辑 "Bidens" -> "Bidens de"（range = 索引 2..7）
  const r = mapNewTextToOriginalGlyphs(glyphs, "4 Bidens de 69", { fontSize: 8.5 } as any, 0, { start: 2, end: 7 });
  const out = r.newGlyphs;
  const six = out.find((g: G) => g.char === "6" && !g.modified);
  const nine = out.find((g: G) => g.char === "9" && !g.modified);
  check("1a '6' 仍存在且未编辑", !!six);
  check("1b '9' 仍存在且未编辑", !!nine);
  check("1c '6' 原始位置未右移（保持 487.82，非 ~511.42）",
    !!(six && Math.abs((six.originalBBox?.x ?? six.bbox.x) - 487.82) < 0.5),
    `x=${six?.originalBBox?.x ?? six?.bbox?.x}`);
  check("1d '9' 原始位置未右移（保持 498.63）",
    !!(nine && Math.abs((nine.originalBBox?.x ?? nine.bbox.x) - 498.63) < 0.5),
    `x=${nine?.originalBBox?.x ?? nine?.bbox?.x}`);
  // 描述列内同列 glyph 应随编辑平移（"B".."s" 是 replacement，已移动）
  const b = out.find((g: G) => g.char === "B" && g.modified);
  check("1e 描述列插入了 ' de'（新增字符被标记 modified）",
    out.some((g: G) => (g.char === "d" || g.char === "e") && g.modified));
}

// ── 2. 单段文本：删除中间空格后，后续字符应左移（避免留空洞）──
{
  console.log("\n[2] 单段文本：删除空格后后续字符左移（重排不破坏）");
  const glyphs: G[] = [
    mk("A", 0, 5), mk("B", 5, 5),
    mk(" ", 10, 5),          // 被删除的空格
    mk("C", 15, 5), mk("D", 20, 5),
  ];
  // 选中空格（索引 2）删除 -> 新文本 "ABCD"
  const r = mapNewTextToOriginalGlyphs(glyphs, "ABCD", { fontSize: 8.5 } as any, 0, { start: 2, end: 2 });
  const out = r.newGlyphs;
  const c = out.find((g: G) => g.char === "C" && !g.modified);
  const d = out.find((g: G) => g.char === "D" && !g.modified);
  check("2a 'C' 左移（原始位置 15 -> ~10）",
    !!(c && Math.abs((c.originalBBox?.x ?? c.bbox.x) - 10) < 0.5),
    `x=${c?.originalBBox?.x ?? c?.bbox?.x}`);
  check("2b 'D' 左移（原始位置 20 -> ~15）",
    !!(d && Math.abs((d.originalBBox?.x ?? d.bbox.x) - 15) < 0.5),
    `x=${d?.originalBBox?.x ?? d?.bbox?.x}`);
}

// ── 3. 单段文本：中间插入字符，后续同列字符右移（不重叠）──
{
  console.log("\n[3] 单段文本：中间插入字符，后续同列字符右移");
  const glyphs: G[] = [
    mk("A", 0, 5), mk(" ", 5, 5), mk("B", 10, 5), mk("C", 15, 5),
  ];
  // 选中 "A"(索引0) 改为 "AX"（插入 X），新文本 "AX B C"
  const r = mapNewTextToOriginalGlyphs(glyphs, "AX B C", { fontSize: 8.5 } as any, 0, { start: 0, end: 0 });
  const out = r.newGlyphs;
  const b = out.find((g: G) => g.char === "B" && !g.modified);
  const c = out.find((g: G) => g.char === "C" && !g.modified);
  check("3a 'B' 右移（原始 10 -> 更大）",
    !!(b && (b.originalBBox?.x ?? b.bbox.x) > 10.5),
    `x=${b?.originalBBox?.x ?? b?.bbox?.x}`);
  check("3b 'C' 右移且顺序/间距保持（C 在 B 右侧，间距≈5）",
    !!(b && c && (c.originalBBox?.x ?? c.bbox.x) > (b.originalBBox?.x ?? b.bbox.x) &&
      Math.abs(((c.originalBBox?.x ?? c.bbox.x) - (b.originalBBox?.x ?? b.bbox.x)) - 5) < 1.5),
    `B=${b?.originalBBox?.x ?? b?.bbox?.x} C=${c?.originalBBox?.x ?? c?.bbox?.x}`);
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
