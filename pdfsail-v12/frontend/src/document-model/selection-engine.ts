/**
 * Selection Engine — Adobe Selection Experience · Story-1~4（Revision）
 *
 * 纯计算引擎，不依赖 Renderer / DOM / React。
 *
 * 产品模型原则（PM Revision）：
 *   - Revision-1：Boundary 用稳定身份（page/blockId/lineId/glyphLocalIndex/edge），不用运行时 globalIndex。
 *   - Revision-2：Selection Model 只保存 { anchor, focus }，不保存任何 Derived Data。
 *   - Revision-3：TextFlow 是 Paragraph → Line → Glyph 层级，不是扁平 Glyph[]。
 *   - Revision-4：BoundaryHitTest 未命中返回 null，不帮用户猜。
 *   - Revision-5：RangeBuilder 只输出 startBoundary/endBoundary（Model），boxes 等由 derive 即时计算（View）。
 *   - Revision-6：排序由 TextOrderProvider 抽象，默认 OCR→Paragraph→Line→Glyph，可扩展 RTL/Vertical。
 *
 * 核心原则：Model 永远只保存最少状态。
 *
 * 边界语义：Selection 采用半开区间 [start, end)。
 * 为保证拖选始终包含起始与结束字符，拖选起点与终点应根据拖动方向选择对应的 before/after 边界：
 *   - 正向（起点在终点左/前）：起点点击字符 before（含起点），终点点击字符 after（含终点）。
 *   - 反向（起点在终点右/后）：起点点击字符 after（含起点），终点点击字符 before（含终点）。
 * 双击 / 三击 / Shift 扩选沿用同一语义，避免重新踩坑。
 */
import type { DrawGlyphCommand } from "./render-command";

// ═══════════════════════════════════════════════════════════════
// Revision-3 · TextFlow 层级模型
// ═══════════════════════════════════════════════════════════════

/** 文本流中的一个字符 */
export interface TextFlowGlyph {
  /** 行内局部索引（稳定身份的一部分） */
  glyphLocalIndex: number;
  page: number;
  blockId: string;
  lineId: string;
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** M7.7-012H: 基线位置（CSS 显示坐标，来自 DrawGlyphCommand.baseline）。
   *  用于计算 visual ink 边界（baseline - ascent 为视觉顶），
   *  替代 model bbox y（含 ascender 空白空间，导致 hit region 过高）。 */
  baseline?: number;
  /** 稳定 glyphId（blockId__lineId__glyphLocalIndex） */
  glyphId: string;
}

/** 文本流中的一个 Line */
export interface TextFlowLine {
  lineId: string;
  /** 首字符 y（行顺序基准，可由 TextOrderProvider 覆盖） */
  y: number;
  glyphs: TextFlowGlyph[];
}

/** 文本流中的一个 Paragraph */
export interface TextFlowParagraph {
  blockId: string;
  page: number;
  lines: TextFlowLine[];
}

/** 文本流（Paragraph → Line → Glyph） */
export interface TextFlow {
  paragraphs: TextFlowParagraph[];
  /** glyphId → 字符（用于 O(1) 定位） */
  glyphIdToGlyph: Map<string, TextFlowGlyph>;
  /** 稳定身份 → 运行时位置（每次 derive 即时计算） */
  glyphToFlowIndex: Map<string, number>;
  /** 字符总数 */
  count: number;
}

// ═══════════════════════════════════════════════════════════════
// Revision-1 · Stable Boundary
// ═══════════════════════════════════════════════════════════════

/** 稳定字符边界（文档身份，不随运行时顺序变化） */
export interface Boundary {
  page: number;
  blockId: string;
  lineId: string;
  /** 边界前的最后一个字符在行内索引（-1 = 行首前） */
  glyphLocalIndex: number;
  /** before = 该字符之前；after = 该字符之后 */
  edge: "before" | "after";
}

export interface Point {
  x: number;
  y: number;
}

// ═══════════════════════════════════════════════════════════════
// Revision-6 · TextOrderProvider
// ═══════════════════════════════════════════════════════════════

/**
 * 排序提供者：决定字符在文本流中的顺序。
 * 默认 OCR 顺序：page → block(paragraph) → line(按 y) → glyph(按 x)。
 * 未来 RTL / Vertical / Japanese / Arabic 通过不同 provider 实现，不修改引擎。
 */
export interface TextOrderProvider {
  /** 行间排序：返回 a 行是否应在 b 行之前 */
  compareLines(a: { page: number; y: number; x: number }, b: { page: number; y: number; x: number }): number;
  /** 行内排序：返回 a 字符是否应在 b 字符之前 */
  compareGlyphs(a: { x: number; y: number }, b: { x: number; y: number }): number;
}

/** 默认 OCR 文本顺序 */
export const OCR_TEXT_ORDER: TextOrderProvider = {
  compareLines(a, b) {
    if (a.page !== b.page) return a.page - b.page;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  },
  compareGlyphs(a, b) {
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  },
};

// ═══════════════════════════════════════════════════════════════
// Task-001.1 · buildTextFlow（Revision-3 + Revision-6）
// ═══════════════════════════════════════════════════════════════

export function buildTextFlow(
  commands: DrawGlyphCommand[],
  opts?: { page?: number; order?: TextOrderProvider },
): TextFlow {
  const order = opts?.order ?? OCR_TEXT_ORDER;
  const defaultPage = opts?.page ?? 1;
  const glyphs = commands.filter((c) => c.type === "drawGlyph") as DrawGlyphCommand[];
  // 命令可能未带 page；用 defaultPage 回退，保证 page 是稳定身份的一部分（非 undefined）
  const pageOf = (c: DrawGlyphCommand) => (typeof c.page === "number" ? c.page : defaultPage);

  // 1. 按 line 分组（稳定身份：page::blockId::lineId）
  const lines = new Map<string, DrawGlyphCommand[]>();
  const lineMeta = new Map<string, { page: number; y: number; x: number }>();
  for (const c of glyphs) {
    const pg = pageOf(c);
    const k = `${pg}::${c.blockId}::${c.lineId}`;
    if (!lines.has(k)) {
      lines.set(k, []);
      lineMeta.set(k, { page: pg, y: c.y, x: c.x });
    }
    lines.get(k)!.push(c);
  }

  // 2. 行内排序（按 provider.compareGlyphs）
  for (const arr of lines.values()) {
    arr.sort(order.compareGlyphs);
  }

  // 3. 行间排序（按 provider.compareLines）
  const lineKeys = [...lines.keys()].sort((a, b) => {
    const ma = lineMeta.get(a)!;
    const mb = lineMeta.get(b)!;
    return order.compareLines(ma, mb);
  });

  // 4. 构建 Paragraph → Line → Glyph
  const paragraphMap = new Map<string, TextFlowParagraph>();
  const paragraphOrder: string[] = [];
  const glyphIdToGlyph = new Map<string, TextFlowGlyph>();
  const glyphToFlowIndex = new Map<string, number>();
  let flowIndex = 0;

  for (const lk of lineKeys) {
    const cmds = lines.get(lk)!;
    const meta = lineMeta.get(lk)!;
    const glyphsInLine: TextFlowGlyph[] = cmds.map((c, i) => {
      const tf: TextFlowGlyph = {
        glyphLocalIndex: i,
        page: pageOf(c),
        blockId: c.blockId,
        lineId: c.lineId,
        char: c.char,
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        // M7.7-012H: 携带 baseline 用于 visual ink 边界计算
        baseline: c.baseline,
        glyphId: `${c.blockId}__${c.lineId}__${i}`,
      };
      return tf;
    });
    glyphsInLine.forEach((tf) => {
      glyphIdToGlyph.set(tf.glyphId, tf);
      glyphToFlowIndex.set(tf.glyphId, flowIndex++);
    });

    const line: TextFlowLine = {
      lineId: cmds[0].lineId,
      y: meta.y,
      glyphs: glyphsInLine,
    };

    const pk = `${meta.page}::${cmds[0].blockId}`;
    let para = paragraphMap.get(pk);
    if (!para) {
      para = { blockId: cmds[0].blockId, page: meta.page, lines: [] };
      paragraphMap.set(pk, para);
      paragraphOrder.push(pk);
    }
    para.lines.push(line);
  }

  const paragraphs = paragraphOrder.map((k) => paragraphMap.get(k)!);
  return { paragraphs, glyphIdToGlyph, glyphToFlowIndex, count: flowIndex };
}

// ═══════════════════════════════════════════════════════════════
// 辅助：稳定身份 → 运行时定位
// ═══════════════════════════════════════════════════════════════

/** 按稳定身份定位 line */
function findLine(flow: TextFlow, page: number, blockId: string, lineId: string): TextFlowLine | null {
  for (const p of flow.paragraphs) {
    if (p.page !== page || p.blockId !== blockId) continue;
    for (const l of p.lines) {
      if (l.lineId === lineId) return l;
    }
  }
  return null;
}

/**
 * 把稳定 boundary 解析为全局 flow 位置（0..count，无则 -1）。
 *
 * 语义：
 *   - edge=before + glyphLocalIndex=n → 字符 n 之前 = 字符 n 的 flow 位置
 *   - edge=after  + glyphLocalIndex=n → 字符 n 之后 = 字符 n 的 flow 位置 + 1
 *   - 行首前（before, n<=0）→ 行首字符的 flow 位置
 *   - 行尾后（after, n>=len）→ 行尾字符的 flow 位置 + 1
 */
export function boundaryToFlowIndex(b: Boundary, flow: TextFlow): number {
  const line = findLine(flow, b.page, b.blockId, b.lineId);
  if (!line || line.glyphs.length === 0) return -1;

  // 行首前
  if (b.edge === "before" && b.glyphLocalIndex <= 0) {
    return flow.glyphToFlowIndex.get(line.glyphs[0].glyphId) ?? -1;
  }
  // 行尾后
  if (b.edge === "after" && b.glyphLocalIndex >= line.glyphs.length) {
    const lastFi = flow.glyphToFlowIndex.get(line.glyphs[line.glyphs.length - 1].glyphId) ?? -1;
    return lastFi >= 0 ? lastFi + 1 : -1;
  }
  // 普通：glyphLocalIndex 指向一个字符
  const g = line.glyphs[b.glyphLocalIndex];
  if (!g) return -1;
  const fi = flow.glyphToFlowIndex.get(g.glyphId) ?? -1;
  return b.edge === "before" ? fi : fi + 1;
}

/** 比较两个 boundary 在文本流中的先后（用于 anchor/focus 排序） */
export function compareBoundaries(a: Boundary, b: Boundary, flow: TextFlow): number {
  const ia = boundaryToFlowIndex(a, flow);
  const ib = boundaryToFlowIndex(b, flow);
  if (ia === -1 && ib === -1) return 0;
  if (ia === -1) return -1;
  if (ib === -1) return 1;
  return ia - ib;
}

// ═══════════════════════════════════════════════════════════════
// Task-001.2 · BoundaryHitTest（Revision-4）
// ═══════════════════════════════════════════════════════════════

/**
 * point → Boundary。
 * 命中字符：按 x 与字符中心返回 before / after。
 * 未命中（行间空白、远离文字）：返回 null（不帮用户猜，Adobe 行为）。
 */
export function boundaryFromPoint(
  point: Point,
  flow: TextFlow,
  opts?: { yTolerance?: number },
): Boundary | null {
  // M7.7-011: LineHitRegion 模型 — 使用相邻行中点作为 Y 边界，不重叠。
  // 替代旧 lineTol = tolerance + maxH 方案（容差约 20px 导致相邻行重叠 35px，
  // 点击行间文字被错误分配到相邻行，引发连锁错误：错误 lineId → 错误 bbox →
  // 错误编辑框/错误 mask/错误 commit 渲染）。

  // Pass 1: 收集所有行的 Y 范围（使用 visual ink 边界替代 model bbox）。
  // model bbox y 包含 ascender 空白空间（PDF font ascent 大于 CSS actualBoundingBoxAscent），
  // 导致 hit region 高于实际文字可见区域。使用 baseline - 0.72*height 估算 visual ink 顶，
  // baseline + 0.28*height 估算 visual ink 底（标准 CSS font metrics 比率）。
  interface LineRegion {
    line: TextFlowLine; minY: number; maxY: number;
  }
  const allLines: LineRegion[] = [];
  for (const para of flow.paragraphs) {
    for (const line of para.lines) {
      if (line.glyphs.length === 0) continue;
      let minY = Infinity, maxY = -Infinity;
      for (const g of line.glyphs) {
        // M7.7-012H: 使用 baseline 计算 visual ink 边界。
        // g.y 是 model bbox top（含 ascender 空白），
        // visualTop = baseline - ascent ≈ baseline - 0.72 * height（CSS 标准 ascent 比率）。
        // 有 baseline 时用 visual 边界，否则回退到 model bbox y。
        if (g.baseline !== undefined) {
          const ascent = 0.72 * g.height; // CSS 标准 ascent 比率（≈ actualBoundingBoxAscent）
          const descent = g.height - ascent; // 剩余为 descent
          const visualTop = g.baseline - ascent;
          const visualBottom = g.baseline + descent;
          if (visualTop < minY) minY = visualTop;
          if (visualBottom > maxY) maxY = visualBottom;
        } else {
          if (g.y < minY) minY = g.y;
          if (g.y + g.height > maxY) maxY = g.y + g.height;
        }
      }
      allLines.push({ line, minY, maxY });
    }
  }
  // M7.7-012H: 使用相邻行中点作为 Y 边界，零重叠零间隙。
  // 规则：上下边界均为当前行与相邻行的中点，确保：
  //   - 相邻行 hitBottom_n === hitTop_{n+1}（半开区间 [hitTop, hitBottom) 无重叠）
  //   - 每行 hit region 严格位于相邻行之间
  //   - 点击行间空白按中点归属，行为可预测
  // 修正前：hitBottom = Math.max(cur.maxY, next.minY + 6) 创建了 ~9px 重叠区，
  // 第一匹配行优先导致点击 l20 底部时错误选中 l20（而非 l21），
  // 引发编辑框/mask/commit 全部错位连锁问题。
  interface HitRegion {
    line: TextFlowLine; hitTop: number; hitBottom: number;
  }
  const regions: HitRegion[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const cur = allLines[i];
    let hitTop = cur.minY;
    let hitBottom = cur.maxY;
    if (i > 0) hitTop = (allLines[i - 1].maxY + cur.minY) / 2; // 与上一行的中点（无重叠）
    if (i < allLines.length - 1) hitBottom = (cur.maxY + allLines[i + 1].minY) / 2; // 与下一行的中点（无重叠）
    regions.push({ line: cur.line, hitTop, hitBottom });
  }
  // Pass 3: 找到点击 Y 所在的 region（首个匹配 = 上面行优先）
  let matchedLine: TextFlowLine | null = null;
  for (const r of regions) {
    if (point.y >= r.hitTop && point.y < r.hitBottom) {
      matchedLine = r.line;
      break;
    }
  }
  // M7.7-012: Hit Decision Trace — 打印完整决策链
  if (typeof console !== "undefined") {
    const trace: any = {
      clickY: Math.round(point.y * 100) / 100,
      nLines: allLines.length,
      nRegions: regions.length,
      candidates: regions.map((r, i) => ({
        lineId: r.line.lineId,
        minY: Math.round(r.hitTop * 100) / 100,
        maxY: Math.round(r.hitBottom * 100) / 100,
        // M7.7-012H: visual 边界（baseline - 0.72*height），替代 model bbox
        visualY: Math.round((allLines[i]?.minY ?? 0) * 100) / 100,
        visualH: Math.round(((allLines[i]?.maxY ?? 0) - (allLines[i]?.minY ?? 0)) * 100) / 100,
        // M7.7-012H: 首 glyph baseline（用于调试 ascender 空间）
        baseline: r.line.glyphs[0]?.baseline !== undefined
          ? Math.round(r.line.glyphs[0].baseline * 100) / 100
          : undefined,
        inside: point.y >= r.hitTop && point.y < r.hitBottom,
        dist: Math.round(Math.abs(point.y - (r.hitTop + r.hitBottom) / 2) * 100) / 100,
      })),
      matched: matchedLine?.lineId ?? null,
      reason: "",
    };
    // 填写选择理由
    const inRegion = trace.candidates.filter((c: any) => c.inside);
    if (inRegion.length > 0) {
      trace.reason = `FIRST_MATCH: ${inRegion[0].lineId} (${inRegion.length} candidate(s) inside, first=above)`;
    } else {
      trace.reason = "NO_MATCH (return null)";
    }
    // console.log("[M7.7-012][HIT_DECISION]", trace);
    // M7.7-013 Audit-1: 点击命中行审计
    // [M7.7-013][CLICK_TARGET] - 已禁用
  }
  // Fallback: 未命中 → 返回 null（不帮用户猜，符合 Revision-4 R4 原则）。
  // 在 Edit Text 模式下，点击行间空白应不触发任何操作，而非猜测一行。
  if (!matchedLine) return null;
  const line = matchedLine;

  // 行内按 x 精确命中
  for (const g of line.glyphs) {
    if (point.x >= g.x && point.x <= g.x + g.width) {
      const mid = g.x + g.width / 2;
      if (point.x <= mid) {
        return { page: g.page, blockId: g.blockId, lineId: g.lineId, glyphLocalIndex: g.glyphLocalIndex, edge: "before" };
      }
      return { page: g.page, blockId: g.blockId, lineId: g.lineId, glyphLocalIndex: g.glyphLocalIndex, edge: "after" };
    }
  }
  // x 在行内但落在字符之间/空隙：返回该行最近字符的边界（仍在行内）
  let best: TextFlowGlyph | null = null;
  let bestD = Infinity;
  for (const g of line.glyphs) {
    const d = Math.abs(point.x - (g.x + g.width / 2));
    if (d < bestD) { bestD = d; best = g; }
  }
  if (best) {
    if (point.x <= best.x + best.width / 2) {
      return { page: best.page, blockId: best.blockId, lineId: best.lineId, glyphLocalIndex: best.glyphLocalIndex, edge: "before" };
    }
    return { page: best.page, blockId: best.blockId, lineId: best.lineId, glyphLocalIndex: best.glyphLocalIndex, edge: "after" };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Task-001.3 · Range Builder（Revision-2 + Revision-5）
// ═══════════════════════════════════════════════════════════════

/** Selection Model：只保存最少状态（anchor + focus），无任何 Derived Data。 */
export interface SelectionModel {
  anchor: Boundary;
  focus: Boundary;
}

/**
 * 由 Selection Model 即时派生渲染数据（不保存，每次调用即时计算）。
 * Model 只存 { anchor, focus }；glyph list / boxes / points 全由这里 derive。
 */
export interface DerivedSelection {
  /** 全局起始边界（含） */
  startBoundary: Boundary;
  /** 全局结束边界（不含） */
  endBoundary: Boundary;
  /** 起始/结束的全局 flow 位置 */
  startIndex: number;
  endIndex: number;
  /** true = 反选（focus 在 anchor 之前） */
  isBackward: boolean;
  /** 命中的 glyph（文本流有序） */
  glyphs: TextFlowGlyph[];
  /** 命中 glyphId 集合（供 Overlay） */
  glyphIds: Set<string>;
  /** 命中 blockId 集合 */
  blockIds: Set<string>;
  /** 每个命中 glyph 的 bbox（Document Space，View 数据，derived） */
  boxes: { x: number; y: number; width: number; height: number }[];
  /** 选区首尾像素位置（View 数据，derived） */
  startPoint: Point;
  endPoint: Point;
}

/** 从 flow 位置取字符（运行时辅助） */
function glyphAtFlowIndex(flow: TextFlow, idx: number): TextFlowGlyph | null {
  for (const para of flow.paragraphs) {
    for (const line of para.lines) {
      for (const g of line.glyphs) {
        if (flow.glyphToFlowIndex.get(g.glyphId) === idx) return g;
      }
    }
  }
  return null;
}

/**
 * Selection Model → Derived Selection。
 * Model 只存 { anchor, focus }；本函数即时计算 glyph list / boxes / points。
 */
export function deriveSelection(model: SelectionModel, flow: TextFlow): DerivedSelection {
  const ia = boundaryToFlowIndex(model.anchor, flow);
  const ib = boundaryToFlowIndex(model.focus, flow);
  const isBackward = ib < ia;
  const startIndex = Math.min(ia, ib);
  const endIndex = Math.max(ia, ib);

  // 归一化 start/end boundary
  const [startB, endB] = isBackward ? [model.focus, model.anchor] : [model.anchor, model.focus];

  const glyphs: TextFlowGlyph[] = [];
  const glyphIds = new Set<string>();
  const blockIds = new Set<string>();
  const boxes: { x: number; y: number; width: number; height: number }[] = [];

  // 遍历全部字符，按 flow 位置收集 [startIndex, endIndex)
  for (const para of flow.paragraphs) {
    for (const line of para.lines) {
      for (const g of line.glyphs) {
        const fi = flow.glyphToFlowIndex.get(g.glyphId)!;
        if (fi >= startIndex && fi < endIndex) {
          glyphs.push(g);
          glyphIds.add(g.glyphId);
          blockIds.add(g.blockId);
          boxes.push({ x: g.x, y: g.y, width: g.width, height: g.height });
        }
      }
    }
  }

  const startGlyph = glyphAtFlowIndex(flow, startIndex);
  const endGlyph = glyphAtFlowIndex(flow, Math.max(startIndex, endIndex - 1));
  const startPoint: Point = startGlyph ? { x: startGlyph.x, y: startGlyph.y } : { x: 0, y: 0 };
  const endPoint: Point = endGlyph ? { x: endGlyph.x + endGlyph.width, y: endGlyph.y } : { x: 0, y: 0 };

  return {
    startBoundary: startB,
    endBoundary: endB,
    startIndex,
    endIndex,
    isBackward,
    glyphs,
    glyphIds,
    blockIds,
    boxes,
    startPoint,
    endPoint,
  };
}
