/**
 * M7.8-022A — Overflow Behavior Audit
 *
 * 目的：把「编辑后行的几何行为」变成可执行契约，而不是靠肉眼看截图。
 *
 * 三个 Case：
 *   Case A（短文本）   — 新文本比原文本短
 *   Case B（等宽附近） — 新文本宽度 ≈ 原文本宽度
 *   Case C（明显超长） — 新文本远超容器（本 audit 的重点）
 *
 * 核心契约（PM 明确）：原文是什么样，编辑时就是什么样。
 *   编辑**不允许**触发：reflow / wrap / font-size 缩放 / font-family 变化 /
 *   baseline 偏移 / container 位移或伸缩 / 邻行位移。
 *   overflow 时：wrap=false，overflow=true，但视觉墨迹不得进入邻行。
 *
 * 运行：npx tsx frontend/src/document-model/overflow-behavior-audit.test.ts
 */
import type {
  EditableBlock,
  EditableDocument,
  EditableGlyph,
  EditableLine,
  BBox,
} from "./types";

// ─────────────────────────────────────────────────────────────
// 0. 确定性 canvas stub（measureCharWidth 依赖 DOM canvas）
// ─────────────────────────────────────────────────────────────
const CHAR_W = 8;
const SPACE_W = 4;

function installCanvasStub(): void {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return; // 浏览器环境已有真实 DOM
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag: string) {
        if (tag !== "canvas") return {};
        return {
          getContext: () => ({
            font: "",
            measureText: (t: string) => ({
              width: Array.from(String(t)).reduce(
                (s, c) => s + (c === " " ? SPACE_W : CHAR_W),
                0
              ),
            }),
          }),
        };
      },
    },
  });
}
installCanvasStub();

// 运行时 import（stub 必须先生效：text-measurement 在调用时才访问 document）
const { applyTextOperation } = await import("./text-operation");
const { renderBlockToExportCommands } = await import("./export-renderer");

// ─────────────────────────────────────────────────────────────
// 1. Fixture
// ─────────────────────────────────────────────────────────────
const PAGE_W = 800;
const PAGE_H = 1000;
const FONT_SIZE = 12;
const GLYPH_H = 16;
const LINE_X = 60;
const TARGET_Y = 200;
const NEIGHBOR_Y = 220; // 邻行（下一行）顶部
const BASELINE_OFFSET = 12; // baseline 相对行顶的偏移

/** 本 fixture 下 computeAvailableLineWidth = PAGE_W - 2*LINE_X = 680 */
const MAX_WIDTH = PAGE_W - LINE_X - LINE_X;

function buildLine(id: string, text: string, y: number): EditableLine {
  let x = LINE_X;
  const glyphs: EditableGlyph[] = Array.from(text).map((ch) => {
    const w = ch === " " ? SPACE_W : CHAR_W;
    const bbox: BBox = { x, y, width: w, height: GLYPH_H };
    x += w;
    return {
      char: ch,
      originalChar: ch,
      bbox: { ...bbox },
      originalBBox: { ...bbox },
      styleRef: 0,
      modified: false,
      baseline: y + BASELINE_OFFSET,
      transform: [1, 0, 0, 1, 0, 0] as EditableGlyph["transform"],
    };
  });
  const width = x - LINE_X;
  return {
    id,
    source: "vector",
    bbox: { x: LINE_X, y, width, height: GLYPH_H },
    baseline: y + BASELINE_OFFSET,
    glyphs,
    style: { fontSize: FONT_SIZE, fontFamily: "Helvetica", fontWeight: 400 },
  };
}

function buildDoc(targetText: string, neighborText: string): EditableDocument {
  const target = buildLine("b1_L1", targetText, TARGET_Y);
  const neighbor = buildLine("b1_L2", neighborText, NEIGHBOR_Y);
  const blockW = Math.max(target.bbox.width, neighbor.bbox.width);
  const blockH = NEIGHBOR_Y - TARGET_Y + GLYPH_H;
  const block: EditableBlock = {
    id: "b1",
    type: "text",
    bbox: { x: LINE_X, y: TARGET_Y, width: blockW, height: blockH },
    source: "pdf_native",
    originalBounds: { x: LINE_X, y: TARGET_Y, width: blockW, height: blockH },
    lines: [target, neighbor],
    layoutMode: "preserve",
    regionType: "paragraph",
  };
  return {
    pages: [{ index: 0, width: PAGE_W, height: PAGE_H, blocks: [block] }],
    styles: [{ fontSize: FONT_SIZE, fontFamily: "Helvetica", fontWeight: 400 }],
    metadata: { fileName: "audit.pdf", pageCount: 1, createdAt: 0 },
    runtime: {
      renderScale: 1,
      cssScale: 1,
      pageMetrics: [{ width: PAGE_W, height: PAGE_H }],
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 2. 断言 / 度量工具
// ─────────────────────────────────────────────────────────────
let results: { name: string; pass: boolean; detail?: string }[] = [];

function assert(cond: boolean, name: string, detail?: string): void {
  results.push({ name, pass: cond, detail });
  console.log(
    `  %c${cond ? "✓" : "✗"} %s%s`,
    cond ? "color:#22c55e" : "color:#ef4444",
    name,
    detail ? `  ${detail}` : ""
  );
}

function near(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 取 block 内指定 line */
function lineOf(doc: EditableDocument, lineId: string): EditableLine {
  const l = doc.pages[0].blocks[0].lines.find((x) => x.id === lineId);
  if (!l) throw new Error(`line not found: ${lineId}`);
  return l;
}

/** glyph 墨迹的垂直下边界（visual ink bottom） */
function inkBottom(line: EditableLine): number {
  return Math.max(...line.glyphs.map((g) => g.bbox.y + g.bbox.height));
}

/** glyph 累积内容宽度（首 glyph.x → 末 glyph.x+width） */
function contentWidth(line: EditableLine): number {
  if (line.glyphs.length === 0) return 0;
  const first = line.glyphs[0];
  const last = line.glyphs[line.glyphs.length - 1];
  return last.bbox.x + last.bbox.width - first.bbox.x;
}

interface RunResult {
  doc: EditableDocument;
  before: EditableLine;
  after: EditableLine;
  beforeNeighbor: EditableLine;
  afterNeighbor: EditableLine;
  beforeLineCount: number;
  afterLineCount: number;
  overflow?: { overflow: boolean; width: number; maxWidth: number };
  mutated: boolean;
}

function runReplace(
  originalText: string,
  newText: string,
  neighborText: string
): RunResult {
  const doc = buildDoc(originalText, neighborText);
  const before = lineOf(doc, "b1_L1");
  const beforeNeighbor = lineOf(doc, "b1_L2");
  const beforeLineCount = doc.pages[0].blocks[0].lines.length;

  const result = applyTextOperation(doc, {
    type: "replace",
    blockId: "b1",
    lineId: "b1_L1",
    range: { start: 0, end: Array.from(originalText).length - 1 },
    text: newText,
  });

  return {
    doc: result.document,
    before,
    after: lineOf(result.document, "b1_L1"),
    beforeNeighbor,
    afterNeighbor: lineOf(result.document, "b1_L2"),
    beforeLineCount,
    afterLineCount: result.document.pages[0].blocks[0].lines.length,
    overflow: result.overflow,
    mutated: result.mutated,
  };
}

/**
 * 所有 Case 共用的「几何不变性」检查：
 * font / x / y / baseline / container 尺寸与位置 / 邻行 / 不换行。
 */
function assertGeometryInvariant(r: RunResult, label: string): void {
  const { before, after, beforeNeighbor, afterNeighbor } = r;
  const style = r.doc.styles[0];

  // font-size / font-family 不变（glyph 全部沿用 styles[0]，且 styles 表未被改写）
  const fsUnchanged = style.fontSize === FONT_SIZE;
  const ffUnchanged = style.fontFamily === "Helvetica";
  assert(fsUnchanged, `${label}: font-size unchanged`, `=${style.fontSize}`);
  assert(ffUnchanged, `${label}: font-family unchanged`, `=${style.fontFamily}`);

  // 所有 glyph 仍指向同一 styleRef（没有引入新样式 → 无缩放/换字体）
  const styleRefs = new Set(after.glyphs.map((g) => g.styleRef));
  assert(
    styleRefs.size === 1 && styleRefs.has(0),
    `${label}: glyph styleRef 未漂移`,
    `refs={${[...styleRefs].join(",")}}`
  );

  // x 不变（首 glyph 起点 = 原行起点）
  assert(
    near(after.glyphs[0].bbox.x, before.glyphs[0].bbox.x),
    `${label}: x unchanged`,
    `${r2(before.glyphs[0].bbox.x)} → ${r2(after.glyphs[0].bbox.x)}`
  );

  // y 不变（全行共享同一行 y，不产生换行/下移）
  const afterYs = new Set(after.glyphs.map((g) => g.bbox.y));
  assert(
    afterYs.size === 1 && near([...afterYs][0], before.glyphs[0].bbox.y),
    `${label}: y unchanged（单行，未换行）`,
    `y=${r2([...afterYs][0])}（原 ${r2(before.glyphs[0].bbox.y)}）`
  );

  // baseline 不变
  const afterBls = new Set(after.glyphs.map((g) => g.baseline ?? NaN));
  assert(
    afterBls.size === 1 && near([...afterBls][0], before.baseline ?? NaN),
    `${label}: baseline unchanged`,
    `bl=${r2([...afterBls][0])}（原 ${r2(before.baseline ?? NaN)}）`
  );

  // glyph 高度不变（无纵向缩放）
  const afterHs = new Set(after.glyphs.map((g) => g.bbox.height));
  assert(
    afterHs.size === 1 && near([...afterHs][0], GLYPH_H),
    `${label}: glyph height unchanged（无缩放）`,
    `h=${r2([...afterHs][0])}`
  );

  // container（line.bbox）x / y / width / height 全部不变
  assert(
    near(after.bbox.x, before.bbox.x) &&
      near(after.bbox.y, before.bbox.y) &&
      near(after.bbox.width, before.bbox.width) &&
      near(after.bbox.height, before.bbox.height),
    `${label}: container x/y/width/height unchanged`,
    `x=${r2(after.bbox.x)} y=${r2(after.bbox.y)} w=${r2(after.bbox.width)} h=${r2(after.bbox.height)}`
  );

  // 邻行不变
  assert(
    near(afterNeighbor.bbox.x, beforeNeighbor.bbox.x) &&
      near(afterNeighbor.bbox.y, beforeNeighbor.bbox.y) &&
      near(afterNeighbor.bbox.width, beforeNeighbor.bbox.width) &&
      near(afterNeighbor.bbox.height, beforeNeighbor.bbox.height),
    `${label}: neighbor line unchanged`,
    `y=${r2(afterNeighbor.bbox.y)}`
  );

  // wrap=false（未产生新行）
  assert(
    r.afterLineCount === r.beforeLineCount,
    `${label}: wrap=false（未 reflow / 未 split）`,
    `lines ${r.beforeLineCount} → ${r.afterLineCount}`
  );

  // visual ink 不进入邻行
  const bottom = inkBottom(after);
  assert(
    bottom <= afterNeighbor.bbox.y + 0.01,
    `${label}: visual ink does not enter neighbor line`,
    `inkBottom=${r2(bottom)} ≤ neighborY=${r2(afterNeighbor.bbox.y)}`
  );
}

// ─────────────────────────────────────────────────────────────
// 3. Case A — 短文本
// ─────────────────────────────────────────────────────────────
function caseA(): void {
  console.group("① Case A — 短文本（原 40 chars → 新 15 chars）");
  const original = "This solution addressed impulsive hiring";
  const next = "Hiring solution";
  const r = runReplace(original, next, "recruiters review a minimum number of proposals");

  assert(r.mutated, "Case A: mutation 已生效");
  assertGeometryInvariant(r, "Case A");

  const cw = contentWidth(r.after);
  assert(
    r.overflow !== undefined && r.overflow.overflow === false,
    "Case A: overflow=false（短文本不溢出）",
    `content=${r2(cw)} maxWidth=${r2(MAX_WIDTH)}`
  );
  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────
// 4. Case B — 等宽附近
// ─────────────────────────────────────────────────────────────
function caseB(): void {
  console.group("② Case B — 等宽附近（新文本宽度 ≈ 原文本宽度）");
  const original = "This solution addressed impulsive hiring";
  // 与原文本等长（40 chars）→ 宽度几乎一致
  const next = "This solution addressed impulsive hirinX";
  const r = runReplace(original, next, "recruiters review a minimum number of proposals");

  assert(r.mutated, "Case B: mutation 已生效");
  assertGeometryInvariant(r, "Case B");

  const beforeW = contentWidth(r.before);
  const afterW = contentWidth(r.after);
  assert(
    near(beforeW, afterW, 1),
    "Case B: 内容宽度 ≈ 原宽度（等宽替换）",
    `${r2(beforeW)} → ${r2(afterW)}`
  );
  assert(
    r.overflow !== undefined && r.overflow.overflow === false,
    "Case B: overflow=false",
    `content=${r2(afterW)} maxWidth=${r2(MAX_WIDTH)}`
  );
  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────
// 5. Case C — 明显超长（本 audit 的重点）
// ─────────────────────────────────────────────────────────────
function caseC(): void {
  console.group("③ Case C — 明显超长（原 53 chars → 新 ~129 chars）");
  const original = "This solution addressed impulsive hiring by ensuring";
  const next =
    "This solution addressed impulsive hiring by ensuring recruiters review a " +
    "minimum number of proposals before closing a vacancy";
  const neighbor = "recruiters review a minimum number of proposals before closing";
  const r = runReplace(original, next, neighbor);

  assert(r.mutated, "Case C: mutation 已生效");

  // 先确认「确实超长」这个前提成立，否则后面的 overflow 断言无意义
  const cw = contentWidth(r.after);
  assert(
    cw > MAX_WIDTH,
    "Case C: 前提成立——内容确实超出可用宽度",
    `content=${r2(cw)} > maxWidth=${r2(MAX_WIDTH)}`
  );

  assertGeometryInvariant(r, "Case C");

  // overflow=true（detect only，不 reflow）
  assert(
    r.overflow !== undefined && r.overflow.overflow === true,
    "Case C: overflow=true（已检测，未 reflow）",
    `width=${r2(r.overflow?.width ?? -1)} maxWidth=${r2(r.overflow?.maxWidth ?? -1)}`
  );

  // 容器未被内容撑开（宽度锁死 = 原容器宽度）
  assert(
    near(r.after.bbox.width, r.before.bbox.width),
    "Case C: container width 未被内容撑开",
    `containerW=${r2(r.after.bbox.width)}（原 ${r2(r.before.bbox.width)}），content=${r2(cw)}`
  );
  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────
// 4c. Case E — fallback 路径（无 editedLineBoxes）★ 用户真实场景
// ─────────────────────────────────────────────────────────────
function caseE(): void {
  console.group("⑤ Case E — fallback 路径（editedLineBoxes 为空）★ 用户真实场景");
  // 用户场景：markLineEdited 仅在 onTextEditSave 内被调用（2 处）。
  // 非该路径的编辑（AI segment / inline tools）不会写入 editedLineBoxes
  // → 导出 mask 走 fallback（line.bbox ∪ glyph 并集）。此前 fallback 无任何邻行保护
  // → 白色 mask 侵占下一行 + 旧文字残留（用户报告现象）。
  // 本 Case 不传 editedLineBoxes，直接验证 fallback 分支已修复。
  const original = "This solution addressed impulsive hiring";
  const edited = "Hiring solution";
  const doc0 = buildDoc(original, "recruiters review a minimum number of proposals");
  const mutated = applyTextOperation(doc0, {
    type: "replace",
    blockId: "b1",
    lineId: "b1_L1",
    range: { start: 0, end: Array.from(original).length - 1 },
    text: edited,
  });
  const doc = mutated.document;
  // 构造一个「比实际墨迹更靠下、更高」的坏 line.bbox（模拟模型 bbox 垂直偏移 ~11px 的情况）
  const block = doc.pages[0].blocks[0];
  const badLine = {
    ...block.lines[0],
    bbox: { x: LINE_X, y: TARGET_Y + 8, width: 400, height: 30 }, // 下移 8、高 30 → 下沿 238 > NEIGHBOR_Y 220
  };
  const badBlock = { ...block, lines: [badLine, block.lines[1]] };
  const ctx = {
    renderScale: 1,
    cssScale: 1,
    pageHeightPt: PAGE_H,
  } as unknown as Parameters<typeof renderBlockToExportCommands>[2];
  const cmds = renderBlockToExportCommands(badBlock, doc.styles, ctx, 0);
  const maskCmds = cmds.filter(
    (c: any) => c.purpose === "mask" && c.type === "drawLine"
  ) as Array<{ y: number; height: number; lineIndex?: number }>;
  console.log(`  mask 命令数 = ${maskCmds.length}（fallback，无 editedLineBoxes）`);
  for (const m of maskCmds) {
    console.log(
      `  mask lineIndex=${m.lineIndex} y_pt=${m.y?.toFixed(2)} height_pt=${m.height?.toFixed(2)}`
    );
  }
  assert(maskCmds.length > 0, "Case E: fallback 路径生成了 mask 命令", `count=${maskCmds.length}`);
  if (maskCmds.length > 0) {
    const targetMask = maskCmds.find((m) => m.lineIndex === 0) ?? maskCmds[0];
    const cssBottom = PAGE_H - targetMask.y;
    assert(
      cssBottom <= NEIGHBOR_Y + 0.01,
      "Case E: ★ fallback mask css 下沿 ≤ 邻行顶部（用户 bug 已修）",
      `cssBottom=${cssBottom.toFixed(2)} ≤ NEIGHBOR_Y=${NEIGHBOR_Y}`
    );
  }
  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────
// 4d. Case F — originalChar 保真（native rewrite 匹配的前提）
// ─────────────────────────────────────────────────────────────
function caseF(): void {
  console.group("⑥ Case F — originalChar 必须保留原 PDF 字符（native 匹配前提）");
  // 一级根因：glyph-mapping 的 replacement 分支曾把 originalChar 写成 newChar，
  // 导致 buildNativeExportPlan 的回退拼接（glyph.originalChar.join("")）产出「新文本」，
  // 使 native-batch-replace.resolveBoundRun 无法匹配原 PDF 的 Tj/TJ 算子
  // → 原文残留 + 新文字错位/换行（用户报告现象）。
  const original = "This solution addressed impulsive hiring";
  const next = "Hiring solution";
  const doc0 = buildDoc(original, "recruiters review a minimum number of proposals");
  const r = applyTextOperation(doc0, {
    type: "replace",
    blockId: "b1",
    lineId: "b1_L1",
    range: { start: 0, end: Array.from(original).length - 1 },
    text: next,
  });
  const after = lineOf(r.document, "b1_L1");
  const before = lineOf(doc0, "b1_L1");

  // 1) 被替换区间内：char 是新字符，originalChar 必须是对应位置的原字符
  const firstOrigChar = before.glyphs[0].originalChar ?? before.glyphs[0].char;
  assert(
    after.glyphs[0].char === "H" && after.glyphs[0].originalChar === firstOrigChar,
    "Case F: replacement 首字符 char=新字符 / originalChar=原字符",
    `char="${after.glyphs[0].char}" originalChar="${after.glyphs[0].originalChar}"（原 "${firstOrigChar}"）`
  );

  // 2) 关键不变量：等长替换时 originalChar 拼接 = 原 PDF 文本。
  //    注意：长度变化的替换无法用 originalChar 还原原文（glyph 数 = 编辑后长度），
  //    这正是 native rewrite 必须依赖 binding.originalText 的原因（types.ts 已注明）。
  const sameLen = "This solution addressed impulsive hirinX"; // 与原文等长
  const docS = buildDoc(original, "recruiters review a minimum number of proposals");
  const rS = applyTextOperation(docS, {
    type: "replace",
    blockId: "b1",
    lineId: "b1_L1",
    range: { start: 0, end: Array.from(original).length - 1 },
    text: sameLen,
  });
  const afterS = lineOf(rS.document, "b1_L1");
  const joinS = afterS.glyphs.map((g) => g.originalChar ?? g.char).join("");
  assert(
    joinS === original,
    "Case F: ★ 等长替换时 glyph.originalChar 拼接 === 原 PDF 文本",
    `joined="${joinS}"`
  );

  // 2b) 长度变化时：originalChar 拼接只到新文本长度（不可用于 native 匹配）
  //     → 因此 native rewrite 必须有 binding.originalText，否则须回退 overlay（M7.8-022A）
  const joinShort = after.glyphs.map((g) => g.originalChar ?? g.char).join("");
  assert(
    joinShort.length === next.length && joinShort !== original,
    "Case F: 长度变化替换 → originalChar 拼接无法还原原文（故须回退 overlay）",
    `joined="${joinShort}"(${joinShort.length}) vs 原(${original.length})`
  );

  // 3) char 拼接 = 用户新文本
  const charJoin = after.glyphs.map((g) => g.char).join("");
  assert(charJoin === next, "Case F: glyph.char 拼接 === 用户新文本", `joined="${charJoin}"`);

  // 4) 新增字符（超出原选区）没有原字符 → 沿用 newChar，不得为 undefined
  const longer = original + "XYZ";
  const docL = buildDoc(original, "recruiters review a minimum number of proposals");
  const rL = applyTextOperation(docL, {
    type: "replace",
    blockId: "b1",
    lineId: "b1_L1",
    range: { start: 0, end: Array.from(original).length - 1 },
    text: longer,
  });
  const afterL = lineOf(rL.document, "b1_L1");
  const tailGlyphs = afterL.glyphs.slice(original.length);
  assert(
    tailGlyphs.length === 3 && tailGlyphs.every((g) => g.originalChar === g.char),
    "Case F: 新增字符（无原字符）originalChar 回退为 newChar",
    `tail=${tailGlyphs.map((g) => `${g.char}/${g.originalChar}`).join(",")}`
  );
  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────
// 6. Runner
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 4b. Case D — 导出 mask 命令下沿直接验证（最小化根因定位）
// ─────────────────────────────────────────────────────────────
function caseD(): void {
  console.group("④ Case D — 导出 mask 命令下沿直接验证（根因定位）");
  // 走真实 mutation 路径：applyTextOperation 触发 mutated=true → 强制走 fallback overlay
  // （不再撞「未触碰 → skipOverlay 全跳过」）
  const original = "This solution addressed impulsive hiring";
  const edited = "Hiring solution";
  const doc0 = buildDoc(original, "recruiters review a minimum number of proposals");
  const mutated = applyTextOperation(doc0, {
    type: "replace",
    blockId: "b1",
    lineId: "b1_L1",
    range: { start: 0, end: Array.from(original).length - 1 },
    text: edited,
  });
  const doc = mutated.document;
  // 模拟 markLineEdited 写入的 editedLineBoxes（含 canvas ink 扫描 bug 的 worst-case 形态）。
  // 真实 markLineEdited 在 canvas 扫描中可能把 mask 下沿推到邻近行——这里把目标行的 box 故意
  // 撑高到 y+height > NEIGHBOR_Y，看 renderBlockToExportCommands 的 clamp 是否拦住。
  const editedLineBoxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  editedLineBoxes.set("b1_L1", {
    x: LINE_X,
    y: TARGET_Y,
    width: 600,
    height: 50, // 50 = 远超下一行顶部 NEIGHBOR_Y - TARGET_Y = 20
  });
  const ctx = {
    renderScale: 1,
    cssScale: 1,
    pageHeightPt: PAGE_H, // renderBlockToExportCommands 直接依赖 ctx.pageHeightPt 做 Y 翻转
  } as unknown as Parameters<typeof renderBlockToExportCommands>[2];
  const cmds = renderBlockToExportCommands(
    doc.pages[0].blocks[0],
    doc.styles,
    ctx,
    0,
    editedLineBoxes
  );
  const maskCmds = cmds.filter((c: any) => c.purpose === "mask" && c.type === "drawLine") as Array<{
    y: number; height: number; lineIndex?: number; blockId: string;
  }>;
  console.log(`  mask 命令数 = ${maskCmds.length}`);
  for (const m of maskCmds) {
    console.log(
      `  mask lineIndex=${m.lineIndex} y_pt=${m.y?.toFixed(2)} height_pt=${m.height?.toFixed(2)} bottom_pt=${(m.y + m.height).toFixed(2)}`
    );
  }
  // 关键断言（这才是修复的正确性检验）：
  // cssToPdf: ptY = pageHeight_pt - cssY/totalScale - cssHeight/totalScale
  // 反推 css bottom = pageHeight_pt - ptY
  // 我们关心的是 css 语义的 mask 下沿 ≤ NEIGHBOR_Y
  // 即 pageHeight_pt - ptY ≤ NEIGHBOR_Y → ptY ≥ pageHeight_pt - NEIGHBOR_Y
  const pageH_pt = PAGE_H / (1 * 1); // 1000
  const ptNeighborTopBound = pageH_pt - NEIGHBOR_Y; // mask 的 pt.y 下界（≥ 此值则 css bottom ≤ 邻居）
  assert(maskCmds.length > 0, "Case D: mutation 后生成了 mask 命令", `count=${maskCmds.length}`);
  if (maskCmds.length > 0) {
    const targetMask = maskCmds.find((m) => m.lineIndex === 0) ?? maskCmds[0];
    const cssBottom = pageH_pt - targetMask.y; // 反推 css bottom
    assert(
      cssBottom <= NEIGHBOR_Y + 0.01,
      "Case D: 修复后 mask css 下沿 ≤ 邻行顶部",
      `cssBottom=${cssBottom.toFixed(2)}, NEIGHBOR_Y=${NEIGHBOR_Y}, pt.y=${targetMask.y?.toFixed(2)}, pt.height=${targetMask.height?.toFixed(2)}, bound(pt.y≥)=${ptNeighborTopBound.toFixed(2)}`
    );
  }
  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────
// 4e. Case G — editedLineBoxes 必须扩展 mask 覆盖模型 bbox 未包含的墨迹
// ─────────────────────────────────────────────────────────────
function caseG(): void {
  console.group("⑦ Case G — editedLineBoxes 扩展 mask 覆盖模型 bbox 未包含的墨迹");
  // 根因：模型 glyph bbox 只是字符 cell，常比实际渲染墨迹窄/偏移（M7.7-004C）。
  // 旧代码只用 glyph bbox 做 mask，导致 ascender/descender 残留 → 导出重影/遮一半。
  // 这里把 glyph bbox 故意削窄，再让 editedLineBoxes 提供完整墨迹盒，验证 mask 能覆盖它。
  const original = "This solution addressed impulsive hiring";
  const edited = "Hiring solution";
  const doc0 = buildDoc(original, "recruiters review a minimum number of proposals");
  const mutated = applyTextOperation(doc0, {
    type: "replace",
    blockId: "b1",
    lineId: "b1_L1",
    range: { start: 0, end: Array.from(original).length - 1 },
    text: edited,
  });
  const doc = mutated.document;
  const line = lineOf(doc, "b1_L1");

  // 模拟模型 bbox 比实际墨迹窄 6px（上下各削 6px）
  for (const g of line.glyphs) {
    g.bbox.y += 6;
    g.bbox.height -= 12;
    if (g.originalBBox) {
      g.originalBBox.y += 6;
      g.originalBBox.height -= 12;
    }
  }

  // editedLineBoxes 提供完整墨迹：上下各比削窄后的 bbox 多 4/2 px
  // 总高度 = GLYPH_H + 6，底部 218 < NEIGHBOR_Y=220，不会被 clamp
  const editedLineBoxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  editedLineBoxes.set("b1_L1", {
    x: LINE_X,
    y: TARGET_Y - 4,
    width: 600,
    height: GLYPH_H + 6,
  });

  const ctx = {
    renderScale: 1,
    cssScale: 1,
    pageHeightPt: PAGE_H,
  } as unknown as Parameters<typeof renderBlockToExportCommands>[2];
  const cmds = renderBlockToExportCommands(
    doc.pages[0].blocks[0],
    doc.styles,
    ctx,
    0,
    editedLineBoxes
  );
  const maskCmds = cmds.filter((c: any) => c.purpose === "mask" && c.type === "drawLine") as Array<{
    y: number; height: number; lineIndex?: number; blockId: string;
  }>;
  assert(maskCmds.length > 0, "Case G: 生成了 mask 命令", `count=${maskCmds.length}`);
  if (maskCmds.length > 0) {
    const targetMask = maskCmds.find((m) => m.lineIndex === 0) ?? maskCmds[0];
    const cssTop = PAGE_H - targetMask.y - targetMask.height;
    const cssBottom = PAGE_H - targetMask.y;
    const realTop = TARGET_Y - 4;
    const realBottom = realTop + GLYPH_H + 6;
    assert(
      cssTop <= realTop + 0.01 && cssBottom >= realBottom - 0.01,
      "Case G: editedLineBoxes 被纳入 mask，完整覆盖真实墨迹",
      `cssTop=${cssTop.toFixed(2)}, cssBottom=${cssBottom.toFixed(2)}, real=[${realTop}, ${realBottom}]`
    );
  }
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean; detail?: string }[] {
  results = [];
  console.log(
    "%c── M7.8-022A · Overflow Behavior Audit ──",
    "font-weight:bold;color:#22c55e;"
  );
  console.log(
    `%cfixture: page=${PAGE_W}px, lineX=${LINE_X}, maxWidth=${MAX_WIDTH}, fontSize=${FONT_SIZE}, glyphH=${GLYPH_H}`,
    "color:#64748b"
  );
  caseA();
  caseB();
  caseC();
  caseD();
  caseE();
  caseF();
  caseG();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(
    "%cPassed: %d / %d",
    failed === 0 ? "color:#22c55e" : "color:#ef4444",
    passed,
    results.length
  );
  if (failed > 0) {
    console.log("%cFAILED: %d", "color:#ef4444", failed);
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  ✗ ${r.name}${r.detail ? `  ${r.detail}` : ""}`);
    }
  }
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url
    .replace("file://", "")
    .replace(/\\/g, "/")
    .replace(/^\//, "");
  if (
    self.endsWith(main.replace(/^\.?\//, "")) ||
    self.endsWith("overflow-behavior-audit.test.ts")
  ) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
