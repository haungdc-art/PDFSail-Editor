/**
 * SegmentBuilder — Commit 5
 *
 * 把 RawGlyph[] 合并成 LineGroup[]，再按标点切割成 Segment[]。
 *
 * 合并规则（同行的 glyph）：
 *   1. y 偏差 < fontSize × 0.5（同一基线）
 *   2. x 间距 < fontSize × 1.5（连续）
 *
 * 标点切割规则：
 *   中文：。！？；：
 *   英文：.!?;:
 *   切割后每个片段包含结尾标点（不丢弃）
 *
 * 表格检测（启发式）：
 *   如果一行有 3+ 个连续等距的 glyph 块，标记为表格行，不做标点切割。
 */

import type { RawGlyph, LineGroup, Segment, FontMeta } from "./types";
import type { FontResolution } from "../editor/font-resolution";
import type { CoordinateMapper } from "./CoordinateMapper";
import type { FontAnalyzer } from "./FontAnalyzer";

/** 标点正则（中英文） */
const PUNCT_REGEX = /([。！？；：.!?;:])/;

/** PDF.js 文本项颜色 ([r,g,b,a]) 转 CSS。兼容 0-1 与 0-255 两种量程；无/非法返回 undefined。 */
function toCssColor(color?: number[]): string | undefined {
  if (!color || color.length < 3) return undefined;
  const max = Math.max(color[0], color[1], color[2]);
  const scale = max > 1 ? 255 : 1; // >1 视为 0-255 量程
  const r = Math.round((color[0] / scale) * 255);
  const g = Math.round((color[1] / scale) * 255);
  const b = Math.round((color[2] / scale) * 255);
  const a = color.length > 3 ? Math.round((color[3] / (scale === 1 ? 1 : 255)) * 255) / 255 : 1;
  if ([r, g, b].some((v) => Number.isNaN(v))) return undefined;
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
}

/**
 * 把 RawGlyph[] 合并成 LineGroup[]。
 *
 * @param glyphs 原始 glyph 数组（顺序按 PDF 读取顺序）
 */
export function groupIntoLines(glyphs: RawGlyph[]): LineGroup[] {
  if (glyphs.length === 0) return [];

  // 先按 y 排序（PDF 坐标系 y 从下往上），同 y 按 x 排序
  const sorted = [...glyphs].sort((a, b) => {
    const yDiff = b.pdfY - a.pdfY; // y 大的在前（PDF 上方）
    if (Math.abs(yDiff) > 1) return yDiff;
    return a.pdfX - b.pdfX;
  });

  const lines: LineGroup[] = [];
  let currentLine: RawGlyph[] = [sorted[0]];
  let currentY = sorted[0].pdfY;
  let currentFontSize = sorted[0].fontSize;

  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i];
    const yDiff = Math.abs(g.pdfY - currentY);
    const yThreshold = currentFontSize * 0.5;

    // 检查是否换行
    if (yDiff > yThreshold) {
      lines.push(mergeLine(currentLine));
      currentLine = [g];
      currentY = g.pdfY;
      currentFontSize = g.fontSize;
    } else {
      // 同行：检查 x 是否连续
      const prev = currentLine[currentLine.length - 1];
      const xGap = g.pdfX - (prev.pdfX + prev.width);
      const xThreshold = currentFontSize * 3; // 允许较大间距
      if (xGap > xThreshold) {
        // x 间距过大，视为新行
        lines.push(mergeLine(currentLine));
        currentLine = [g];
        currentY = g.pdfY;
        currentFontSize = g.fontSize;
      } else {
        currentLine.push(g);
      }
    }
  }
  if (currentLine.length > 0) lines.push(mergeLine(currentLine));

  return lines;
}

/** 把一组同行 glyph 合并成一个 LineGroup */
function mergeLine(glyphs: RawGlyph[]): LineGroup {
  if (glyphs.length === 0) {
    return {
      text: "",
      pdfX: 0,
      pdfY: 0,
      width: 0,
      height: 0,
      fontName: "unknown",
      fontSize: 12,
      glyphs: [],
    };
  }

  const text = glyphs.map((g) => g.str).join("");
  const pdfX = glyphs[0].pdfX;
  const pdfY = glyphs[0].pdfY;
  const lastG = glyphs[glyphs.length - 1];
  const width = lastG.pdfX + lastG.width - pdfX;

  // 统计主字体（按字符数加权）。
  // M7.9-MAINFONT-WEIGHT-FIX：旧实现按 item 计数取主字体，会被零星小 run 干扰 ——
  // 实测 "Assunto:"(bold, 8字) + 空格(bold) + 正文(regular, 68字) 一行，item 计数
  // bold:regular = 2:1 → 主字体误判为 bold → 行级样式加粗 → 编辑态 textarea 整行
  // 加粗、行宽按 bold 度量。按字符数加权（字体覆盖的文本量）后正确取 regular。
  const fontCounts = new Map<string, number>();
  let maxFontSize = 0;
  for (const g of glyphs) {
    fontCounts.set(g.fontName, (fontCounts.get(g.fontName) || 0) + Math.max(1, g.str.length));
    if (g.fontSize > maxFontSize) maxFontSize = g.fontSize;
  }
  let mainFont = glyphs[0].fontName;
  let maxCount = 0;
  for (const [name, count] of fontCounts) {
    if (count > maxCount) {
      maxCount = count;
      mainFont = name;
    }
  }

  // 行颜色取自主字体 glyph 的颜色（PDF.js 文本项真实颜色）
  const mainGlyph = glyphs.find((g) => g.fontName === mainFont) || glyphs[0];

  return {
    text,
    pdfX,
    pdfY,
    width,
    height: maxFontSize,
    fontName: mainFont,
    fontSize: maxFontSize,
    color: mainGlyph.color,
    hz: mainGlyph.hz ?? 1,
    glyphs,
  };
}

/**
 * M7.8-039B：最小多列触发谓词（与 detectTableLine 完全独立，不改动后者）。
 *
 * 为何需要：real PDF 的表格行，列间隙由「空白 text operator」填满，导致相邻 glyph 的
 * pdfX 间隙≈0 → detectTableLine 因 `avg < fontSize*0.5` 判 false，落入标点分支被压成 1 段。
 * 因此 Plan A 需要一个独立、狭窄的触发：行内存在 ≥2 个**非空白** operator，且相邻非空白
 * operator 之间的最大间隙 > fontSize*1.5（真实列间距远大于词间距）。普通段落通常只有 1 个
 * operator（或词间距 < fontSize，不会触发）→ 不受影响（满足 P7）。
 *
 * 这不是"扩展 detectTableLine"，而是 Plan A 空间切分的最小准入条件。
 */
function isMultiColumnLine(line: LineGroup): boolean {
  const nw = line.glyphs.filter((g) => g.str && g.str.trim().length > 0);
  if (nw.length < 2) return false;
  let maxGap = 0;
  for (let i = 1; i < nw.length; i++) {
    const gap = nw[i].pdfX - (nw[i - 1].pdfX + nw[i - 1].width);
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap > line.fontSize * 1.5;
}

/**
 * M7.8-039B：把表格/多列行的 LineGroup 切成"每非空白 text operator 一个 Segment"的列表。
 *
 * 根因（M7.8-039A 确认）：buildSegments 原先把整行 line.glyphs 合并成 1 个 Segment，
 * EditableTextNode 再以 nowrap 连续文本流渲染，导致不同 column 的真实 X anchor 丢失
 * （如 A x=36 / B x=249.62 / C x=325.65 / D x=414 / E x=594 被压成一段流式文本）。
 *
 * 修复（Spatial Text Run → Segment）：
 *  - 每个 **非空白** text operator（RawGlyph，str 非全空白）= 一个 Segment；
 *  - **空白** operator（str 全空白）只作为列间隙，**不生成 Editable Segment**（但绝不从
 *    Document Model 删除 —— Document Model 与此函数无关，本函数只决定"可编辑 Segment"）。
 *  - 与前一非空白 operator 间隙≈0 的连续 operator（同一 cell 被 PDF 拆成多 operator 的罕见情况）
 *    做 merge，避免误拆；间隙超过 fontSize*0.4 视为新列。
 *
 * 这样每个 Segment 的 cssX 由其首 glyph.pdfX 经 mapper 映射得到（buildSegmentFromGlyphs 已保证），
 * 列 anchor 100% 还原；列间隙由 Segment 间 cssX 差自然表达，不再被 nowrap 流式吞掉。
 *
 * 注意：本函数**不修改** detectTableLine（沿用既有 isTable 判定），不触及 Document Model /
 * EditableTextNode / CoordinateMapper / Export / provenance。
 */
function splitTableLineIntoSegments(
  line: LineGroup,
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  pageIndex?: number,
  blockId?: string,
  lineIdx = 0
): Segment[] {
  const segs: Segment[] = [];
  let run: RawGlyph[] = [];

  const flush = () => {
    if (run.length) {
      segs.push(buildSegmentFromGlyphs(run, line, mapper, fontAnalyzer, true, pageIndex, blockId, lineIdx));
      run = [];
    }
  };

  const isWhitespace = (g: RawGlyph) => !g.str || g.str.trim().length === 0;

  for (const g of line.glyphs) {
    if (isWhitespace(g)) {
      // 空白 operator = 列间隙，结束当前 run 且不并入内容
      flush();
      continue;
    }
    if (run.length) {
      const last = run[run.length - 1];
      const gap = g.pdfX - (last.pdfX + last.width);
      if (gap > line.fontSize * 0.4) flush(); // 间隙过大 → 新列
    }
    run.push(g);
  }
  flush();
  return segs;
}

/**
 * 把 LineGroup[] 按标点切割成 Segment[]。
 *
 * 切割策略：按 glyph 实际坐标切割（非估算宽度），确保每个 segment 的 cssX/cssW 精确对应 PDF 中的文本位置。
 *
 * @param lines 行数组
 * @param mapper 坐标映射器（PDF pt → CSS px）
 * @param fontAnalyzer 字体分析器（生成 FontMeta）
 */
export function buildSegments(
  lines: LineGroup[],
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  pageIndex?: number,
  resolutionMap?: Map<string, FontResolution>,
  /** M7.8-040：源 blockId（= pdf-native-adapter 构造的 `pdf_p${page}_block0`）。
   *  不传时由 pageIndex 推导（与 adapter 的 block 命名保持一致），
   *  用于让 Segment.source 携带真实 {blockId, lineId} 精确定位 EditableLine。 */
  blockId?: string
): Segment[] {
  const segments: Segment[] = [];
  // M7.8-040：统一解析真实 blockId（EditableLine.id = `pdf_${blockId}_l${lineIdx}`）。
  const resolvedBlockId = blockId ?? (pageIndex != null ? `pdf_p${pageIndex}_block0` : undefined);
  // M7.8-020-PROD：用全局 line 边界的最大/最小值推断页边距（避免页眉/页脚/窄栏干扰），
  // 再用宽松阈值判断每行对齐方式。
  const globalMinLeft = lines.length ? Math.min(...lines.map((l) => l.pdfX)) : 0;
  const globalMaxRight = lines.length
    ? Math.max(...lines.map((l) => l.pdfX + l.width))
    : 0;
  const pageWidth = mapper.getPageWidthPt();
  const rightMargin = globalMaxRight > 0
    ? Math.min(globalMaxRight * 0.98, pageWidth * 0.85)
    : pageWidth * 0.85;
  const leftMargin = globalMinLeft > 0
    ? Math.max(globalMinLeft * 1.1, pageWidth * 0.15)
    : pageWidth * 0.15;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // 推断行对齐方式（用于编辑态还原 PDF 布局）
    const lineEnd = line.pdfX + line.width;
    const nearRight = lineEnd >= rightMargin;
    const nearLeft = line.pdfX <= leftMargin;
    if (nearRight && !nearLeft) {
      line.textAlign = "right";
    } else if (nearRight && nearLeft) {
      line.textAlign = "justify";
    } else {
      line.textAlign = "left";
    }

    // 检测是否是表格行（启发式：3+ 个等距 glyph 块）
    const isTable = detectTableLine(line);
    // M7.8-039B：表格行 OR 多列行（列间隙被空白 operator 填满导致 detectTableLine 误判非表）都走空间切分。
    if (isTable || isMultiColumnLine(line)) {
      // M7.8-039B：表格/多列行按"每非空白 text operator 一个 Segment"切分，
      // 还原各列真实 X anchor（详见 splitTableLineIntoSegments）。
      segments.push(...splitTableLineIntoSegments(line, mapper, fontAnalyzer, pageIndex, resolvedBlockId, li));
      continue;
    }

    // 按标点切割 glyph 数组（用实际坐标，非估算宽度）
    const glyphGroups = splitGlyphsByPunctuation(line.glyphs);
    if (glyphGroups.length <= 1) {
      // 无标点：整行一个 segment
      segments.push(buildSegmentFromGlyphs(line.glyphs, line, mapper, fontAnalyzer, false, pageIndex, resolvedBlockId, li));
    } else {
      // 有标点：每个 glyph group 一个 segment，坐标从 glyph 实际位置计算
      for (const glyphs of glyphGroups) {
        if (glyphs.length === 0) continue;
        segments.push(buildSegmentFromGlyphs(glyphs, line, mapper, fontAnalyzer, false, pageIndex, resolvedBlockId, li));
      }
    }
  }

  // M7.8-020-PROD：将统一字体解析结果挂到 segment（只追加字段，几何逻辑不变）
  if (resolutionMap) {
    for (const seg of segments) {
      const fr = resolutionMap.get(seg.font.rawFontName);
      if (fr) {
        seg.fontResolution = fr;
        // 关键：把解析出的可编辑 family 落到渲染字段，替换 FontAnalyzer 对未知字体的 Arial 默认解。
        // embedded→隔离 namespace FontFace；system→真实系统字体；fallback→受控字体栈（均非 Arial 猜测）。
        if (fr.editableFontFamily) {
          // M7.8-020-PROD：三种来源的处理。
          // - embedded → bridge 隔离字体（与画布同一份字体字节）→ 直接采用
          // - system   → PDF.js 指定的真实系统字体 → 直接采用
          // - fallback → PDF.js 画布的通用族名（"sans-serif"）。
          //
          // M7.8-034：fallback 分支**不再整体替换** document 解析出的字体栈。
          // 原因（实测 FONT-DIAG 佐证）：
          //   rawFontName=g_d0_f2 / metaName="BAAAAA+ProximaNova-Regular" / source=fallback
          //   → editableFontFamily = fallbackFamilyFor("sans-serif") = "sans-serif"
          //   → 直接覆盖掉 document 里正确的 "'Proxima Nova', Arial, Helvetica, sans-serif"
          // 结果 overlay 用通用 sans-serif 排版，字形宽度与 PDF 原字体（Proxima Nova）差距很大，
          // 提交后 boxWidth=max-content 量出的宽度 ≠ cssW → 右边缘与邻行错位（用户报告）。
          // 通用族名只配在**末尾兜底**，不配顶掉具体字族。
          // M7.8-034：fallback 分支保留 document 字体栈，仅把通用族名追加到末尾兜底。
          //
          // 实测（本机）：
          //   · 用裸 "sans-serif"  → 浏览器解析出的字形比 canvas 宽，编辑态视觉上表现为
          //     「文本被拉伸」（M7.8-034 之前的行为，用户已确认过一次，回退后复现）
          //   · 用 document 字体栈（"'Proxima Nova', Arial, Helvetica, sans-serif"）→ 不拉伸
          //
          // ⚠ 这是**临时取舍**，等 M7.8-035 Font Provenance 结果再定：
          //   若该 PDF 确有 FontFile2（pdf.js 只是没暴露 font.data），则正确解法是修
          //   Font Data Bridge 让 overlay 拿到真实 ProximaNova 字节，本分支就无所谓了。
          const docFamily = (seg.font.family || "").trim();
          if (fr.source === "embedded" || fr.source === "system") {
            seg.font.family = fr.editableFontFamily;
          } else if (docFamily && !docFamily.includes(fr.editableFontFamily)) {
            seg.font.family = `${docFamily}, ${fr.editableFontFamily}`;
          } else if (!docFamily) {
            seg.font.family = fr.editableFontFamily;
          }
          if (typeof fr.weight === "number") {
            seg.font.weight = fr.weight;
          }
          seg.font.style = fr.style || seg.font.style || "normal";
        }
      }
    }
  }

  return segments;
}

/**
 * 按标点切割 glyph 数组（保留标点在前一段）。
 *
 * 与 splitByPunctuation 不同，本函数按 glyph 粒度切割，
 * 每个 glyph group 的坐标直接从 glyph 实际 pdfX/width 计算，确保 cssX/cssW 精确。
 *
 * 切割规则：
 *   - 遍历每个 glyph，累积到 currentGroup
 *   - 检查 glyph.str 的最后一个字符是否是标点（。！？；：.!?;:）
 *   - 如果是标点，把 currentGroup 作为一个 group 输出，开始新的 group
 *   - 遍历结束后，剩余的 currentGroup 作为最后一个 group
 */
function splitGlyphsByPunctuation(glyphs: RawGlyph[]): RawGlyph[][] {
  if (glyphs.length === 0) return [];
  const groups: RawGlyph[][] = [];
  let currentGroup: RawGlyph[] = [];

  for (const g of glyphs) {
    currentGroup.push(g);
    // 检查 glyph.str 末尾是否是标点
    const lastChar = g.str[g.str.length - 1];
    if (PUNCT_REGEX.test(lastChar)) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);
  return groups;
}

/** 检测表格行（启发式：glyph x 间距等距且数量多） */
function detectTableLine(line: LineGroup): boolean {
  if (line.glyphs.length < 4) return false;
  // 检查 x 间距是否等距（标准差 < 平均值的 20%）
  const gaps: number[] = [];
  for (let i = 1; i < line.glyphs.length; i++) {
    const prev = line.glyphs[i - 1];
    const curr = line.glyphs[i];
    gaps.push(curr.pdfX - (prev.pdfX + prev.width));
  }
  if (gaps.length < 2) return false;
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (avg < line.fontSize * 0.5) return false; // 间距太小不算表格
  const variance = gaps.reduce((sum, g) => sum + (g - avg) ** 2, 0) / gaps.length;
  const stdDev = Math.sqrt(variance);
  return stdDev < avg * 0.3; // 间距稳定才算表格
}

/**
 * M7.8-040：由「当前 glyph run」直接计算 Segment 在 EditableLine.glyphs 中的 glyph 区间。
 *
 * 关键不变量（与 pdf-native-adapter.pdfLineToEditableLine 对齐）：
 *   EditableLine.glyphs 用 `Array.from(op.str)` 逐字符展开（per-char），
 *   因此某 run 的 startGlyphIndex = 该行内「run 之前所有 operator 的逐字符长度之和」，
 *   endGlyphIndex = startGlyphIndex + run 的逐字符长度 - 1（含）。
 *
 * 完全不依赖文本匹配 / indexOf(originalText)，由 LineGroup 的原始 glyph 顺序直接得出。
 * 用 `Array.from(g.str).length`（而非 `g.str.length`）以正确处理代理对（surrogate pair）。
 */
function computeSourceGlyphRange(
  line: LineGroup,
  run: RawGlyph[]
): { startGlyphIndex: number; endGlyphIndex: number } {
  if (run.length === 0) {
    return { startGlyphIndex: 0, endGlyphIndex: -1 };
  }
  const firstRef = run[0];
  let start = 0;
  for (const g of line.glyphs) {
    if (g === firstRef) break; // run 首 glyph 引用命中 → 停止累计（不含 run 自身）
    start += Array.from(g.str).length;
  }
  let count = 0;
  for (const g of run) count += Array.from(g.str).length;
  return { startGlyphIndex: start, endGlyphIndex: start + count - 1 };
}

/**
 * 从一组 glyph 构建 segment（坐标从 glyph 实际位置计算）。
 *
 * @param glyphs 同一 segment 的 glyph 数组（已是行内子集）
 * @param line 所属行（用于 fontName/fontSize/lineId 及 M7.8-040 的 source 区间计算）
 * @param mapper 坐标映射器
 * @param fontAnalyzer 字体分析器
 * @param isTableCell 是否表格 cell
 * @param pageIndex 页码（1-based）。M7.7-006G：lineId 加 pageIndex 前缀使跨页唯一，
 *                  避免不同页相同 Y 坐标行 lineId 冲突 → editedLineBoxes 跨页污染。
 *                  未传时保持旧格式（向后兼容，单页场景）。
 * @param blockId 源 blockId（M7.8-040：用于 source.lineId 精确定位 EditableLine）。
 * @param lineIdx 行在 lines 数组中的下标（M7.8-040：EditableLine.id = `pdf_${blockId}_l${lineIdx}`）。
 */
function buildSegmentFromGlyphs(
  glyphs: RawGlyph[],
  line: LineGroup,
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  isTableCell: boolean,
  pageIndex?: number,
  blockId?: string,
  lineIdx = 0
): Segment {
  const text = glyphs.map((g) => g.str).join("");
  // pdfX = 第一个 glyph 的 pdfX；pdfW = 最后一个 glyph 右边缘 - 第一个 glyph 左边缘
  const firstG = glyphs[0];
  const lastG = glyphs[glyphs.length - 1];
  const pdfX = firstG.pdfX;
  const pdfW = lastG.pdfX + lastG.width - firstG.pdfX;
  const pdfY = line.pdfY;
  const pdfH = line.height;

  const css = mapper.pdfToCss(pdfX, pdfY, pdfW, pdfH);
  const font = fontAnalyzer.analyze(line.fontName, line.fontSize);
  // 应用 viewportScale × cssScale，与原 textItems fontSize 一致
  font.size = mapper.scaleFontSize(line.fontSize);
  // 行高动态计算：让文字行高 = 编辑框高度，避免文字溢出
  font.lineHeight = font.size > 0 ? css.h / font.size : 1.0;
  // M7.8-020-PROD：用 PDF.js 文本项真实颜色覆盖默认黑（原文可能非纯黑）
  const realColor = toCssColor(line.color);
  if (realColor) font.color = realColor;

  // M7.7-006G: lineId 跨页唯一。pageIndex 前缀避免 page1 与 page2 相同 Y 行冲突。
  const lineId = pageIndex != null
    ? `line_${pageIndex}_${pdfY.toFixed(0)}`
    : `line_${pdfY.toFixed(0)}`;

  // M7.8-040：由当前 glyph run 直接产生的精确 source binding（不依赖 indexOf(originalText)）。
  // blockId 存在时，EditableLine.id = `pdf_${blockId}_l${lineIdx}`，可精确定位。
  const source = blockId
    ? (() => {
        const r = computeSourceGlyphRange(line, glyphs);
        return {
          blockId,
          lineId: `pdf_${blockId}_l${lineIdx}`,
          lineIdx,
          startGlyphIndex: r.startGlyphIndex,
          endGlyphIndex: r.endGlyphIndex,
        };
      })()
    : undefined;

  return {
    id: `seg_${pdfX.toFixed(0)}_${pdfY.toFixed(0)}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    originalText: text,
    pdfX,
    pdfY,
    pdfW,
    pdfH,
    cssX: css.x,
    cssY: css.y,
    cssW: css.w,
    cssH: css.h,
    // M7.8-014F: CSS 基线（pdfY 是 PDF 基线，纯坐标翻转，不加升部）
    cssBaseline: mapper.pdfYToCssY(pdfY),
    font,
    textAlign: line.textAlign || "left",
    hz: line.hz ?? 1,
    lineId,
    isTableCell,
    source,
  };
}
