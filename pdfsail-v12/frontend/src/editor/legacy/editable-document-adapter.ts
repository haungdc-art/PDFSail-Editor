/**
 * editor/legacy/editable-document-adapter.ts — EDITOR-CORE-005
 *
 *   document-model EditableDocument  →  EditorDocument
 *
 * 这是覆盖两条既有生产管线的主 adapter：
 *   · document-model/pdf-importer.ts        parsePdfToEditableDocument()
 *   · document-model/ocr-adapter.ts         ocrBlocksToEditableDocument()
 * 二者都产出 EditableDocument，因此共用本 adapter。
 *
 * ── 映射策略 ────────────────────────────────────────────────────────
 *     EditablePage  → EditorPage
 *     EditableBlock → TextBoxObject（bbox → 约束矩形；transform.rotation → rotation）
 *     EditableLine  → Paragraph
 *     EditableGlyph → （不持久化）逐字符 glyph 折叠成 run 文本 + glyph 区间 provenance
 *     EditableBlock.children（签名复合块）→ 递归展开为同级 TextBox
 *
 * ── 坐标系（§19）──────────────────────────────────────────────────
 * EditableBlock.bbox / EditableLine.bbox 已是 CSS 显示坐标，直接作为 Page Canvas Space。
 *
 * ── glyph 索引归属（架构地图 V7 / 规范 §9–§10）───────────────────
 * EditableLine.glyphs 的逐字符索引**只**写入 run.source：
 *   { blockId: block.id, lineId: line.id, lineIdx, startGlyphIndex: 0, endGlyphIndex: glyphs.length-1 }
 * 绝不构造 TextPosition / TextRange。
 */

import type {
  EditableBlock,
  EditableDocument,
  EditableGlyph,
  EditableLine,
  EditableStyle,
} from "../../document-model/types";
import type { ImageAsset, ParagraphAlignment, TextSourceBinding } from "../core/document/types";
// F3B-6.18-C.1：旋转/倾斜的唯一原始事实 = PDF text matrix（归一化 [a,b,c,d]）
import {
  resolveBlockRotation,
  resolveBlockTransformMatrix,
  transform4ToAngle,
} from "../../document-model/geometry-detector";
import {
  ingestImageDataUrl,
  materializeImport,
  toSourceKind,
  toTextStyle,
  type ImportBoxDraft,
  type ImportImageDraft,
  type ImportOptions,
  type ImportParagraphDraft,
  type ImportResult,
  type LayoutGranularity,
} from "./common";

/**
 * visual-line 粒度下给 TextBox 宽度留的余量（px）。
 *
 * 为什么不是「严格 = `line.bbox.width`」：
 *   Core 会按 `TextBox.width` 折行，若 `Σadvance` 因取整比 `bbox.width` 大一点点，
 *   就会折出**第二条视觉行**，违反 ①②③ 的核心不变量
 *   （1 视觉行 = 1 TextBox = 1 Paragraph = **1 Layout Line**）。
 *   `reflow.ts:139-147` 证明：alignment = left 时 width **只**参与折行判定，
 *   不参与 `lineX` 计算，因此加余量**不会移动任何字符**。
 */
export const VISUAL_LINE_WIDTH_SLACK = 2;

/** 折叠一行 glyph 的文本（glyph.char 已是逐字符） */
function lineText(line: EditableLine): string {
  return line.glyphs.map((g: EditableGlyph) => g.char ?? "").join("");
}

/**
 * F3B-6.18-C.2 · A：`lineHeight` 的**单位语义**判定（在适配器层确定）。
 *
 * 证据（真实 fixture）：同一字段有**两种生产者**且单位不同 ——
 *   · Layout Engine 写入内联 `line.style.lineHeight = 1`（**无单位比例**）
 *   · 文档级 `doc.styles[ref].lineHeight = 16.87`（**CSS px**）
 * 而合成 fixture 又可能把 px 写进内联 style（如 `lineHeight: 16`）
 * ⇒ **来源不可靠**，不能按来源判定。
 *
 * 因此复用仓库**既有量纲界线**（`document-model/style-normalizer.ts:63`：
 * `(0, 5]` = 无单位比例 → `× fontSize`；`> 5` = 已是 px），在适配器层设定
 * `lineHeightIsRatio`，由 `toTextStyle` 决定是否换算。**不猜测、不改 Core Layout。**
 *
 * 旧实现的缺陷：直接透传 `raw.lineHeight` 且**未标** `lineHeightIsRatio`
 * ⇒ 比例 `1` 被当 px ⇒ Core `TextStyle.lineHeight = 1` ⇒ `GlyphLayout.box.height = 1`
 * ⇒ 渲染器（无 baseline 回退）`line-height: 1px`（1px 盒塌缩）。
 */
const LINE_HEIGHT_RATIO_UPPER_BOUND = 5;

function lineHeightIsRatio(lineHeight: number | undefined): boolean {
  return (
    typeof lineHeight === "number" &&
    Number.isFinite(lineHeight) &&
    lineHeight > 0 &&
    lineHeight <= LINE_HEIGHT_RATIO_UPPER_BOUND
  );
}

/**
 * 取行的样式：优先 line.style（已被 Layout Engine 解析），
 * 缺失时回退到首个 glyph 的 styleRef 指向的文档级样式表。
 */
function lineStyle(
  line: EditableLine,
  doc: EditableDocument,
  blockType: EditableBlock["type"]
): EditableStyle {
  const own = (line as { style?: EditableStyle }).style;
  if (own && Object.keys(own).length > 0) return own;
  const ref = line.glyphs[0]?.styleRef;
  if (typeof ref === "number" && doc.styles[ref]) return doc.styles[ref];
  return {};
}

function toAlignment(value: EditableStyle["alignment"]): ParagraphAlignment | undefined {
  return value === "left" || value === "center" || value === "right" || value === "justify"
    ? value
    : undefined;
}

export function editableDocumentToEditorDocument(
  doc: EditableDocument,
  options: ImportOptions = {}
): ImportResult {
  const warnings: string[] = [];
  let skippedNonText = 0;
  let expandedChildren = 0;
  let linesWithGlyphs = 0;
  /** visual-line 粒度下被强制改为 left 的非 left 对齐行数（原对齐已由 line.bbox.x 承载） */
  let shiftedAlignments = 0;
  /** B3-C-5-E-A：本次适配解码出的图片资产（与 ImportPageDraft.images 的 assetRef 成对） */
  const collectedAssets: ImageAsset[] = [];

  const granularity: LayoutGranularity = options.layoutGranularity ?? "block";

  /**
   * 一行的 paragraph draft（两种粒度**共用**，保证文本/样式/provenance 完全一致）。
   *
   * visual-line 粒度下的两处偏离（都是为了让 1 行 = 1 Layout Line 成立）：
   *   1. `letterSpacing` 归零 —— 推进量已由 PDF advance 提供（见 binding 的 L2 度量），
   *      否则 Core 会算成 `advance + letterSpacing` 双重计入 → 横向漂移。
   *   2. `alignment` 强制 left —— TextBox 就是这一行，行内对齐已由 `line.bbox.x` 承载；
   *      若传 center/right，Core 会按 `slack = width - contentWidth` 再次位移（`reflow.ts:139-147`）。
   */
  function lineParagraphDraft(
    line: EditableLine,
    block: EditableBlock,
    lineIdx: number
  ): ImportParagraphDraft {
    const text = lineText(line);
    const source: TextSourceBinding = {
      kind: toSourceKind(block.source),
      blockId: block.id,
      lineId: line.id,
    };
    if (lineIdx >= 0) source.lineIdx = lineIdx;
    if (line.glyphs.length > 0) {
      linesWithGlyphs += 1;
      source.startGlyphIndex = 0;
      source.endGlyphIndex = line.glyphs.length - 1;
    }
    const raw = lineStyle(line, doc, block.type);
    // Step 4 / A'：**行样式是排版属性来源，但通常不含 PDF 字体身份**。
    // 实测 gd-swim-2026.pdf 第 3 行：line.style 只有 7 个键，doc.styles[styleRef] 有 9 个，
    // 多出的正是 pdfjsFontFamily / pdfFontName。而 lineStyle() 因 line.style 非空而
    // **永不回退**到 glyph 样式 ⇒ sourceFontName 恒为 undefined ⇒ Core run 无字体 provenance。
    // 这里只**补缺失的 provenance**，不做全量覆盖，也不改变 line-level 排版语义。
    const glyphStyleRefForFont = line.glyphs[0]?.styleRef;
    const glyphStyleForFont =
      typeof glyphStyleRefForFont === "number" ? doc.styles[glyphStyleRefForFont] : undefined;
    const isVisualLine = granularity === "visual-line";
    if (isVisualLine && raw.alignment !== undefined && raw.alignment !== "left") {
      shiftedAlignments += 1;
    }
    return {
      runs: [
        {
          text,
          style: toTextStyle(
            {
              fontFamily: raw.fontFamily,
              fontSize: raw.fontSize,
              fontWeight: raw.fontWeight,
              fontStyle: raw.fontStyle,
              color: raw.color,
              lineHeight: raw.lineHeight,
              // F3B-6.18-C.2 A：按既有量纲界线确定单位语义（(0,5]=比例，>5=px）
              lineHeightIsRatio: lineHeightIsRatio(raw.lineHeight),
              letterSpacing: isVisualLine ? 0 : raw.letterSpacing,
              sourceFontName:
                raw.pdfFontName ??
                raw.fontId ??
                glyphStyleForFont?.pdfFontName ??
                glyphStyleForFont?.fontId,
            },
            options
          ),
          source,
        },
      ],
      alignment: isVisualLine ? "left" : toAlignment(raw.alignment),
    };
  }

  /**
   * 让 Core **必然不折行**的宽度下界。
   *
   * Core 的折行依据是 `Σadvance`（`reflow.ts:316-374` 逐 glyph 累加 `x`），
   * 而 Core 实际累加的量来自 `FontMetricsProvider` 的 §18 L2 路径，即
   * `glyph.metrics.pdfAdvance ?? advanceWidth`（**PDF 内容流有效推进量**）。
   * 因此本函数必须累加**同一语义**的 effective advance，否则当 effective
   * 大于 nominal 时会折出第二条视觉行，违反 `visual-line` 核心不变量。
   *
   * 必须同时考虑三个量：
   *   · `line.bbox.width`  原始行盒宽（可能比墨迹窄）
   *   · 墨迹横向跨度        `max(glyph.bbox.right) - line.bbox.x`
   *   · `ΣpdfAdvance`      **PDF 有效推进量之和**（缺省回退 advanceWidth）
   *
   * 再加 `VISUAL_LINE_WIDTH_SLACK` 吸收取整误差。
   */
  function lineMinNoWrapWidth(line: EditableLine): number {
    let inkRight = Number.NEGATIVE_INFINITY;
    let advanceSum = 0;
    for (const g of line.glyphs) {
      const right = g.bbox.x + g.bbox.width;
      if (right > inkRight) inkRight = right;
      const advance = g.metrics?.pdfAdvance ?? g.metrics?.advanceWidth;
      if (typeof advance === "number" && Number.isFinite(advance) && advance >= 0) {
        advanceSum += advance;
      }
    }
    const inkWidth = Number.isFinite(inkRight) ? Math.max(0, inkRight - line.bbox.x) : 0;
    return Math.max(line.bbox.width, inkWidth, advanceSum);
  }

  /**
   * 把一个 EditableBlock（含 children）展开成 box draft。
   *
   * B3-C-5-E-A：`type === "image"` 分支 —— EditableBlock.image（src=dataURL）
   * → `ingestImageDataUrl`（**唯一解码源**，与 blocksToEditorDocument 同函数，
   *   绝不在 Binding/bridge 二次 decode）→ `ImageAsset` + `ImportImageDraft`。
   *   - 几何直接使用 `block.bbox`（CSS 显示坐标），**不做**新的坐标换算；
   *   - `rotation` 缺省 0、不伪造 `transform`（UI 创建的 image block 未建模旋转）；
   *   - 页归属由**所在 EditablePage** 的 draft 承载（ImageObject 无 page 字段）；
   *   - src 缺失 / 无法解码 ⇒ fail-closed：计入 skipped + 显式 warning，
   *     **绝不生成悬空 ImageObject**。
   *   - asset id 沿用 `ingestImageDataUrl` 的 nextId 机制（用户裁决：E-A 不引入
   *     稳定 id / 去重 / GC；重复适配允许产生新 assetRef，资源累积可接受）。
   */
  function toBoxes(block: EditableBlock, images: ImportImageDraft[]): ImportBoxDraft[] {
    if (block.type === "image") {
      if (!block.src) {
        skippedNonText += 1;
        warnings.push(`跳过 image 块 ${block.id}（无 src → 不生成悬空 ImageObject）`);
        return [];
      }
      const asset = ingestImageDataUrl(block.src);
      if (!asset) {
        skippedNonText += 1;
        warnings.push(`跳过 image 块 ${block.id}（src 无法解码为 dataURL → fail-closed）`);
        return [];
      }
      collectedAssets.push(asset);
      images.push({
        x: block.bbox.x,
        y: block.bbox.y,
        width: block.bbox.width,
        height: block.bbox.height,
        rotation: 0,
        assetRef: asset.id,
      });
      return [];
    }
    if (block.type !== "text") {
      skippedNonText += 1;
      return [];
    }
    const out: ImportBoxDraft[] = [];

    const boxSource: TextSourceBinding = {
      kind: toSourceKind(block.source),
      blockId: block.id,
    };
    // F3B-6.18-C.1：旧实现只读 `block.transform?.rotation`（**PDF-native 块恒空**）⇒ 旋转丢失。
    // 现改用 PDF text matrix 的归一化 `[a,b,c,d]` 作为 authoritative；`rotation` 由矩阵派生。
    //
    // ⚠️ `visual-line` 粒度下 transform **必须逐行取**：一个 block 可含 0°/45°/90° 多行
    //   （m77-003），块级「首个非单位矩阵」会把首行非单位矩阵**污染整块**（实测 l0 被错误旋转）。
    //   block 粒度才用块级矩阵。
    const blockTransform = resolveBlockTransformMatrix(block);
    const blockRotation = blockTransform
      ? transform4ToAngle(blockTransform)
      : resolveBlockRotation(block);

    if (granularity === "visual-line") {
      // 1 视觉行 = 1 TextBox = 1 Paragraph = 1 Layout Line
      for (let lineIdx = 0; lineIdx < block.lines.length; lineIdx += 1) {
        const line = block.lines[lineIdx];
        const lineScope = { lines: [line] };
        const lineTransform = resolveBlockTransformMatrix(lineScope);
        const lineRotation = lineTransform
          ? transform4ToAngle(lineTransform)
          : resolveBlockRotation(lineScope);
        out.push({
          x: line.bbox.x,
          y: line.bbox.y,
          width: lineMinNoWrapWidth(line) + VISUAL_LINE_WIDTH_SLACK,
          height: line.bbox.height,
          rotation: lineRotation,
          transform: lineTransform ?? undefined,
          source: boxSource,
          paragraphs: [lineParagraphDraft(line, block, lineIdx)],
        });
      }
    } else {
      const paragraphs = block.lines.map((line, lineIdx) =>
        lineParagraphDraft(line, block, lineIdx)
      );
      out.push({
        x: block.bbox.x,
        y: block.bbox.y,
        width: block.bbox.width,
        height: block.bbox.height,
        rotation: blockRotation,
        transform: blockTransform ?? undefined,
        source: boxSource,
        paragraphs,
      });
    }

    if (block.children && block.children.length > 0) {
      expandedChildren += block.children.length;
      for (const child of block.children) out.push(...toBoxes(child, images));
    }
    return out;
  }

  const pages = doc.pages.map((page) => {
    const boxes: ImportBoxDraft[] = [];
    const images: ImportImageDraft[] = [];
    for (const block of page.blocks) boxes.push(...toBoxes(block, images));
    return {
      index: page.index,
      width: options.pageWidth ?? page.width,
      height: options.pageHeight ?? page.height,
      boxes,
      images,
    };
  });

  warnings.push(
    `每个 EditableLine → 一个 Paragraph；glyph 逐字符索引写入 run.source（${linesWithGlyphs} 行带 glyph 区间），不作位置模型`
  );
  if (granularity === "visual-line") {
    warnings.push(
      `粒度 = visual-line：1 视觉行 = 1 TextBox（宽 = max(line.bbox.width, 墨迹宽) + ${VISUAL_LINE_WIDTH_SLACK}px 防折行余量）；` +
        `letterSpacing 归零（推进量由 PDF advance 提供）；alignment 强制 left（原对齐由 line.bbox.x 承载${shiftedAlignments > 0 ? `，本次影响 ${shiftedAlignments} 行` : ""}）`
    );
  }
  if (skippedNonText > 0) {
    warnings.push(
      `跳过 ${skippedNonText} 个非文本块（table/未建模；src 缺失或无法解码的 image 亦计入），Editor Core 暂未建模`
    );
  }
  if (expandedChildren > 0) {
    warnings.push(
      `${expandedChildren} 个嵌套子块（签名复合块）已展开为同级 TextBox：父块 children 层级未被保留`
    );
  }
  warnings.push(
    "未建模字段（显式丢弃）：originYPt、layoutMode、regionType、render source(image/image-ocr)、styles 文档级表"
  );

  return materializeImport(pages, options, warnings, skippedNonText, collectedAssets);
}
