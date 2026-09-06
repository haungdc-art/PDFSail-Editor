/**
 * PDF Native Adapter — pdf.js TextContent → EditableDocument
 *
 * Sprint 2 更新：
 *   - 使用 PDF Native Style Extractor 提取完整样式（含 fontStyle/transform/letterSpacing）
 *   - 使用 StyleResolver 注册样式到文档级 styles 数组
 *   - glyph.styleRef 指向 styles 数组索引（不每 glyph 复制 style）
 *
 * 数据流：
 *   pdf.js page.getTextContent()
 *     → editor-engine TextExtractor.extractGlyphs() → RawGlyph[]
 *     → editor-engine SegmentBuilder.groupIntoLines() → LineGroup[]
 *     → [本文件] pdfLinesToEditableBlock()
 *     → EditableBlock（source="pdf_native"）
 *
 * 不影响现有 editor-engine（只读取其输出，不修改）。
 */

import type {
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  GlyphMetrics,
  GlyphFontIdentity,
  BBox,
  TextSource,
  TransformMatrix,
} from "./types";
import { IDENTITY_TRANSFORM } from "./types";
import type { RawGlyph, LineGroup } from "../editor-engine/types";
import type { CoordinateMapper } from "../editor-engine/CoordinateMapper";
import type { FontAnalyzer } from "../editor-engine/FontAnalyzer";
import { StyleResolver } from "./style-resolver";
import { extractPdfNativeStyle } from "./pdf-style-extractor";
import { normalizeStyle } from "./style-normalizer";
import { measureCharWidths } from "./text-measurement";
import type { PageFontMetrics, ParsedFontMetrics } from "./pdf-font-metrics";
import { trueAdvancePt, glyphMetricsFromFont } from "./pdf-font-metrics";
import type { FontProvenanceEntry } from "./pdf-font-provenance";

/**
 * 通过「总宽 = Σ 逐字符 advance」匹配 RawGlyph item 所属的字体度量。
 * 单字体页直接命中；多字体页按最小残差选最优候选。
 *
 * @returns 匹配到的 ParsedFontMetrics；无法置信匹配则 undefined（调用方走 canvas fallback）。
 */
function resolveGlyphFont(
  pageMetrics: PageFontMetrics | undefined,
  str: string,
  fontSize: number,
  widthPt: number,
): ParsedFontMetrics | undefined {
  if (!pageMetrics) return undefined;
  const chars = Array.from(str);
  if (chars.length === 0) return undefined;

  const candidates = [...pageMetrics.metrics.values()].filter(
    (fm) => fm.hasWidthData && chars.every((ch) => fm.unicodeToAdvance.has(ch)),
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // 多字体：选总宽残差最小者
  let best: ParsedFontMetrics | undefined;
  let bestErr = Infinity;
  for (const fm of candidates) {
    const expected = chars.reduce((sum, ch) => sum + (trueAdvancePt(fm, ch, fontSize) ?? 0), 0);
    const err = Math.abs(expected - widthPt);
    if (err < bestErr) { bestErr = err; best = fm; }
  }
  return best;
}

/**
 * 把 PDF transform matrix [a, b, c, d, e, f] 转换为 CSS 归一化 transform。
 *
 * PDF transform 包含 fontSize 缩放 + 位置 + 旋转/倾斜。
 * CSS 归一化 transform 仅保留旋转/倾斜：
 *   - 缩放归一化为 1（fontSize 由 EditableStyle.fontSize 控制）
 *   - 平移归零（位置由 bbox.x / bbox.y 控制）
 *   - 旋转/倾斜保留（PDF Y-up 与 CSS Y-down 旋转方向一致，不取反 b/c）
 *
 * 无旋转时返回 [1, 0, 0, 1, 0, 0]。
 *
 * @param pdfTransform PDF transform [a, b, c, d, e, f]
 * @returns CSS 归一化 transform [a', b', c', d', 0, 0]
 */
function pdfTransformToCssNormalized(pdfTransform: [number, number, number, number, number, number]): TransformMatrix {
  const [a, b, c, d] = pdfTransform;
  // fontSize = sqrt(a² + b²)（从缩放分量提取）
  const fontSize = Math.sqrt(a * a + b * b);
  if (fontSize === 0 || fontSize === 1) {
    // 已归一化或退化，检查是否有旋转
    if (a === 1 && b === 0 && c === 0 && d === 1) {
      return IDENTITY_TRANSFORM;
    }
    // fontSize=1 但有旋转/倾斜，直接用
    return [a, b, c, d, 0, 0];
  }
  // 归一化：除以 fontSize
  return [a / fontSize, b / fontSize, c / fontSize, d / fontSize, 0, 0];
}

/**
 * 把 LineGroup[] 转换为 EditableBlock（单个文本块）。
 *
 * Sprint 2：接收 StyleResolver，将样式注册到文档级数组。
 *
 * @param lines pdf.js 提取的行组
 * @param mapper 坐标映射器（PDF pt → CSS px）
 * @param fontAnalyzer 字体分析器（用于行级 FontMeta，保持与 segments 一致）
 * @param blockId block 唯一 ID
 * @param resolver 文档级样式注册器
 */
export function pdfLinesToEditableBlock(
  lines: LineGroup[],
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  blockId: string,
  resolver: StyleResolver,
  /** M7.5-002：本页 PDF 原生字体度量（可选；缺失时 multi-char 回退 canvas 估算） */
  pageMetrics?: PageFontMetrics,
  /** M7.8-035-B：pdf.js loadedName → PDF resource 的可靠溯源（Type3 等无字节字体用） */
  provenance?: Map<string, FontProvenanceEntry>,
): EditableBlock {
  // M7.7-009B-2a: 诊断——检查 pdfLinesToEditableBlock 是否被调用
  console.log(`[009B-2a] pdfLinesToEditableBlock called: blockId="${blockId}" lines=${lines.length} fontAnalyzer=${typeof fontAnalyzer.analyze}`);
  const editableLines: EditableLine[] = [];
  let blockBBox: BBox = { x: Infinity, y: Infinity, width: 0, height: 0 };
  let firstStyleRef = 0;

  lines.forEach((line, lineIdx) => {
    const { line: editableLine, bbox, styleRef } = pdfLineToEditableLine(
      line,
      mapper,
      fontAnalyzer,
      blockId,
      lineIdx,
      resolver,
      pageMetrics,
      provenance,
    );

    // 合并 block bbox
    if (bbox.x < blockBBox.x) blockBBox.x = bbox.x;
    if (bbox.y < blockBBox.y) blockBBox.y = bbox.y;
    const right = bbox.x + bbox.width;
    const bottom = bbox.y + bbox.height;
    const blockRight = blockBBox.x + blockBBox.width;
    const blockBottom = blockBBox.y + blockBBox.height;
    if (right > blockRight) blockBBox.width = right - blockBBox.x;
    if (bottom > blockBottom) blockBBox.height = bottom - blockBBox.y;

    if (lineIdx === 0) firstStyleRef = styleRef;
    editableLines.push(editableLine);
  });

  if (editableLines.length === 0) {
    blockBBox = { x: 0, y: 0, width: 0, height: 0 };
  }

  return {
    id: blockId,
    type: "text",
    bbox: blockBBox,
    source: "pdf_native" as TextSource,
    originalBounds: blockBBox,
    lines: editableLines,
  };
}

/**
 * 单个 LineGroup → EditableLine（含 glyph）
 *
 * Sprint 2：
 *   - 每个 glyph 用 PDF Native Style Extractor 提取完整样式
 *   - 样式注册到 resolver，glyph.styleRef 指向索引
 */
function pdfLineToEditableLine(
  line: LineGroup,
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  blockId: string,
  lineIdx: number,
  resolver: StyleResolver,
  pageMetrics?: PageFontMetrics,
  provenance?: Map<string, FontProvenanceEntry>,
): { line: EditableLine; bbox: BBox; styleRef: number } {
  // M7.7-009B-2a: 诊断——检查 pdfLineToEditableLine 是否被调用
  console.log(`[009B-2a] pdfLineToEditableLine called: blockId="${blockId}" lineIdx=${lineIdx} line.fontName="${line.fontName}" glyphs=${line.glyphs?.length ?? 0} fontAnalyzer=${typeof fontAnalyzer.analyze}`);
  const glyphs: EditableGlyph[] = [];

  // 行级 bbox（CSS px）
  const lineCss = mapper.pdfToCss(line.pdfX, line.pdfY, line.width, line.height);
  const lineBBox: BBox = {
    x: lineCss.x,
    y: lineCss.y,
    width: lineCss.w,
    height: lineCss.h,
  };

  // Milestone-1 Phase-2: 真实 CSS baseline（Original Fact，无 Reconstruction）。
  // line.pdfY = RawGlyph.pdfY = transform[5] = 真实 PDF baseline（bottom-left origin）。
  // mapper.pdfYToCssY() = 纯坐标转换（Y 翻转 + 缩放，语义无关，ADR-008），
  //   不做 box-top 坍缩（无 ASCENT_RATIO），不重建 baseline。
  const lineBaseline = mapper.pdfYToCssY(line.pdfY);

  // 行级样式：用 FontAnalyzer（保持与 segments 一致）+ 行高修正
  const fontMeta = fontAnalyzer.analyze(line.fontName, line.fontSize);
  fontMeta.size = mapper.scaleFontSize(line.fontSize);
  fontMeta.lineHeight = fontMeta.size > 0 ? lineCss.h / fontMeta.size : 1.0;

  const lineStyle: EditableStyle = {
    fontFamily: fontMeta.family,
    fontSize: fontMeta.size,
    fontWeight: String(fontMeta.weight),
    fontStyle: fontMeta.family.includes("italic") ? "italic" : "normal",
    color: fontMeta.color,
    lineHeight: fontMeta.lineHeight,
    letterSpacing: 0,
  };
  // M7.7-006H: normalize lineHeight (ratio→px), fontWeight (string→number), fontSize (>0)
  const normalizedLineStyle = normalizeStyle(lineStyle);
  const lineStyleRef = resolver.register(normalizedLineStyle);

  // 每个 RawGlyph → EditableGlyph
  // Sprint 2：用 PDF Native Style Extractor 提取 glyph 级精确样式
  line.glyphs.forEach((g) => {
    const gCss = mapper.pdfToCss(g.pdfX, g.pdfY, g.width, g.height);

    // M7.8-035-B：用 provenance 表（FontBBox 匹配，非编号猜测）为 glyph 补齐字体溯源。
    // 即使 resolveGlyphFont 因 Form-XObject 字体未被 pageMetrics 收录而失败，
    // 这里仍能用 pdf.js loadedName 可靠定位到 PDF resource（Type3 等无字节字体）。
    const provEntry = provenance?.get(g.fontName);
    // M7.8-035-FIX：直接复用 provenance 里已构建好的 GlyphFontIdentity —— 它携带
    //   · fontRef（/F5…/F12，来自原 PDF object graph，非 fontIdentity===undefined 猜测）
    //   · unicodeToCharCode（原 /ToUnicode 反查表，导出时用于「新字符 → 原始 charCode」）
    //   · objectNumber（原字体字典对象号，便于诊断）
    // 此前这里手工重建了一个**不含 unicodeToCharCode** 的残缺 identity，
    // 导致 Export 无法把编辑后的 Unicode 还原成原始 charCode → 整行回落 Helvetica。
    const provenanceIdentity: { fontIdentity: GlyphFontIdentity } | undefined = provEntry
      ? { fontIdentity: provEntry.fontIdentity }
      : undefined;

    // Type3 字体：用 /ToUnicode 反查，把 unicode 还原为原内容流 charCode。
    // 注意：g.str 可能是多字符串，逐字符查表在下方进行；此处只查整串（单字符场景）。
    const provCharCode: number | undefined =
      provEntry?.unicodeToCharCode ? provEntry.unicodeToCharCode.get(g.str) : undefined;
    const provenanceCharCode: { pdfCharCode: number } | undefined =
      provCharCode !== undefined ? { pdfCharCode: provCharCode } : undefined;

    // 从原始 glyph 提取样式（含 transform/fontName）
    // RawGlyph 保留了 transform，重建 PdfTextItem 用于 extractor
    const glyphStyle = extractPdfNativeStyle(
      {
        str: g.str,
        transform: g.transform,
        width: g.width,
        height: g.height,
        fontName: g.fontName,
        fontSize: g.fontSize,
      },
      mapper["ctx" as keyof CoordinateMapper] ? 1 : 1, // cssScale 已在 mapper 内处理
      1 // viewportScale 已在 mapper 内处理
    );

    // 修正 fontSize/lineHeight：用 mapper 的精确值
    glyphStyle.fontSize = fontMeta.size;
    glyphStyle.lineHeight = fontMeta.lineHeight;
    glyphStyle.color = fontMeta.color;

    // M7.7-006H: normalize glyph style (lineHeight ratio→px, fontWeight→number)
    const normalizedGlyphStyle = normalizeStyle(glyphStyle);
    // M7.7-009B-2a: 诊断——检查 pdfjsFontFamily 是否透传
    if (normalizedGlyphStyle.pdfjsFontFamily) {
      console.log(`[009B-2a] normalizeStyle preserved pdfjsFontFamily="${normalizedGlyphStyle.pdfjsFontFamily}" for char="${g.str.substring(0, 20)}"`);
    } else {
      console.log(`[009B-2a] normalizeStyle LOST pdfjsFontFamily! glyphStyle had ${JSON.stringify(glyphStyle.pdfjsFontFamily)}`);
    }
    const glyphStyleRef = resolver.register(normalizedGlyphStyle);

    // Milestone-1 Sprint B: glyph 级真实 CSS baseline（Original Fact，纯坐标转换，无 Reconstruction）。
    // g.pdfY = RawGlyph.transform[5] = 真实 PDF baseline；pdfYToCssY 只做 Y 翻转+缩放（ADR-008）。
    const baseline = mapper.pdfYToCssY(g.pdfY);
    // PDF native glyph：从原始 transform 转换为 CSS 归一化 transform（保留旋转/倾斜）
    const transform = pdfTransformToCssNormalized(g.transform);

    // ── M5-RUNTIME-002B: Character-level glyph extraction ──
    // 把 pdf.js text item（整段 str，如 "HELLO WORLD"）拆成逐字符 EditableGlyph。
    // 每字符宽度用 measureCharWidths（canvas 逐字符测量，现有能力，非 textItem.width/len 平均值捷径），
    // 并归一化使总宽 = 整段真实 CSS 宽（gCss.w），锚定到整段起点 → bbox 按文本顺序递增。
    const chars = Array.from(g.str);
    if (chars.length <= 1) {
      // 单字符（含空串/单字）
      // M7.5-002：优先用 PDF native advance（真实 Font Dict / AFM），
      //   按 fontMeta/g.fontSize 将 pt 换算为 CSS px（不锚定 pdf.js item.width，
      //   因 Standard 14 单字符 item.width 可能用替换字体度量而偏离 Adobe AFM）。
      //   解析不出真实宽度 → 回退 item.width（gCss.w）。
      let advanceWidth = gCss.w;
      let glyphMetricsExtra: Omit<GlyphMetrics, "advanceWidth"> | undefined;
      const fm = pageMetrics ? resolveGlyphFont(pageMetrics, g.str, g.fontSize, g.width) : undefined;
      if (fm && fontMeta.size > 0) {
        const advPt = trueAdvancePt(fm, g.str, g.fontSize);
        if (advPt !== undefined) {
          const toCss = fontMeta.size / g.fontSize; // pt → CSS px（= viewportScale*cssScale）
          advanceWidth = advPt * toCss;
          glyphMetricsExtra = glyphMetricsFromFont(fm, g.str, g.fontSize);
        }
      }
      glyphs.push({
        char: g.str,
        originalChar: g.str,
        bbox: { x: gCss.x, y: gCss.y, width: gCss.w, height: gCss.h },
        baseline,
        styleRef: glyphStyleRef,
        modified: false,
        transform,
        fontIdentity: provenanceIdentity?.fontIdentity,
        // M7.8-035-FIX：此前写成 provenanceCharCode?.pdfCharCode?.get(g.str) —— pdfCharCode 是
        // number 而非 Map，`.get` 不存在 → 每个带 provenance 的 glyph 都抛 TypeError。
        pdfCharCode: provenanceCharCode?.pdfCharCode,
        metrics: { ...(glyphMetricsExtra ?? {}), ...(provenanceIdentity ?? {}), ...(provenanceCharCode ?? {}), advanceWidth, pdfTransform: g.transform as TransformMatrix } satisfies GlyphMetrics,
      });
    } else {
      // ── M7.5-002: PDF Native 逐字符 advance（多字符 item） ──
      // 优先使用 PDF Font Dictionary 真实 Widths（resolveGlyphFont 按「总宽残差」匹配字体），
      // 分布由真实 advance 决定，整段总宽仍锚定到 pdf.js 真实宽 gCss.w（保持整体不漂移）。
      // 解析不出真实宽度 → 回退 canvas measureCharWidths（现有能力）。
      const fm = resolveGlyphFont(pageMetrics, g.str, g.fontSize, g.width);
      let widthsPt: number[] | null = null;
      if (fm) {
        const arr = chars.map((ch) => trueAdvancePt(fm, ch, g.fontSize) ?? NaN);
        if (arr.every((v) => Number.isFinite(v))) widthsPt = arr;
      }

      if (widthsPt) {
        // 真实 advance：总宽锚定 gCss.w（CSS px），分布按 PDF native 宽度等比
        const totalPt = widthsPt.reduce((a, b) => a + b, 0);
        const scale = totalPt > 0 ? gCss.w / totalPt : 1;
        let cursorX = gCss.x;
        chars.forEach((ch, i) => {
          const w = widthsPt![i] * scale; // tip: scale 抵消 pt→CSS px 的 viewportScale*cssScale
          const glyphMetrics = glyphMetricsFromFont(fm!, ch, g.fontSize);
          glyphs.push({
            char: ch,
            originalChar: ch,
            bbox: { x: cursorX, y: gCss.y, width: w, height: gCss.h },
            baseline,
            styleRef: glyphStyleRef,
            modified: false,
            transform,
            fontIdentity: provenanceIdentity?.fontIdentity,
            // 逐字符查 unicode→charCode（CID ≠ Unicode，已用真实 PDF 验证）
            pdfCharCode: provEntry?.unicodeToCharCode?.get(ch),
            metrics: { ...glyphMetrics, ...(provenanceIdentity ?? {}), pdfCharCode: provEntry?.unicodeToCharCode?.get(ch), advanceWidth: w, pdfTransform: g.transform as TransformMatrix } satisfies GlyphMetrics,
          });
          cursorX += w;
        });
      } else {
        // 回退：canvas 逐字符测量 + 归一化到整段真实宽
        const widths = measureCharWidths(g.str, lineStyle);
        const totalMeasured = widths.reduce((a, b) => a + b, 0);
        const scale = totalMeasured > 0 ? gCss.w / totalMeasured : 1;
        let cursorX = gCss.x;
        chars.forEach((ch, i) => {
          const w = widths[i] * scale;
          glyphs.push({
            char: ch,
            originalChar: ch,
            bbox: { x: cursorX, y: gCss.y, width: w, height: gCss.h },
            baseline,
            styleRef: glyphStyleRef,
            modified: false,
            transform,
            fontIdentity: provenanceIdentity?.fontIdentity,
            pdfCharCode: provEntry?.unicodeToCharCode?.get(ch),
            metrics: { ...(provenanceIdentity ?? {}), pdfCharCode: provEntry?.unicodeToCharCode?.get(ch), advanceWidth: w, pdfTransform: g.transform as TransformMatrix } satisfies GlyphMetrics,
          });
          cursorX += w;
        });
      }
    }
  });

  return {
    line: {
      id: `pdf_${blockId}_l${lineIdx}`,
      source: "vector", // 缺省；pipeline 上游（pdf-importer）会调用 render-source-detector 修正为 "image"
      bbox: lineBBox,
      // Milestone-1 Phase-2: 真实 CSS baseline（Original Fact，非 box-top）
      baseline: lineBaseline,
      glyphs,
      style: lineStyle,
    },
    bbox: lineBBox,
    styleRef: lineStyleRef,
  };
}
