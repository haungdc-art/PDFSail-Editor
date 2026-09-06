/**
 * DocumentRenderer — Sprint 4
 *
 * 让 EditableDocument 成为 Editor 渲染的数据源。
 *
 * 架构变更：
 *   旧：EditableDocument → TextBlock Adapter → 旧 Renderer
 *   新：EditableDocument → DocumentRenderer → RenderableTextObject[] → Editor
 *
 * Task 1: RenderableTextObject 类型
 * Task 2: Preserve Renderer（保持 glyph bbox/styleRef/originalBounds）
 * Task 3: Reconstruct Renderer（使用 LayoutEngine 结果）
 *
 * 关键设计：
 *   RenderableTextObject 兼容现有 editor TextBlock 接口（x/y/w/h/text/fontSize/fontFamily/color/originalBounds），
 *   保证 PDFCanvas 零修改渲染。
 *   额外字段（layoutMode/glyphs/source）用于未来精确渲染和 AI Agent。
 *
 * 坐标系：Document Space（CSS 显示坐标，与 editor docBlocks 一致）
 */

import { signatureSuppression } from "./signature-suppression-manager";
import { resolveMaskGeometry } from "../geometry-adapter/geometry-adapter";
import type {
  EditableDocument,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  BBox,
  LayoutMode,
  TextSource,
} from "./types";
import type { Block, TextBlock, OriginalBounds } from "../editor/types";
import type {
  RenderCommand,
  DrawGlyphCommand,
  DrawLineCommand,
} from "./render-command";

// ── Task 1: RenderableTextObject ──

/**
 * RenderableTextObject — 渲染对象
 *
 * 兼容现有 editor TextBlock（x/y/w/h/text/fontSize/fontFamily/color/originalBounds），
 * PDFCanvas 可直接渲染，零修改。
 *
 * 额外字段（glyphs/layoutMode/source）用于：
 *   - 未来精确 glyph 级渲染
 *   - AI Agent 定位修改
 *   - Layout Diff 调试
 */
export interface RenderableTextObject {
  // ── 兼容 editor TextBlock 的字段（PDFCanvas 直接用） ──
  id: string;
  type: "text";
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  originalBounds?: OriginalBounds;

  // ── Document Renderer 扩展字段（未来精确渲染用） ──
  /** 布局模式 */
  layoutMode?: LayoutMode;
  /** 来源标记 */
  source?: TextSource;
  /** glyph 级数据（用于未来精确渲染 / AI Agent） */
  glyphs?: Array<{
    char: string;
    bbox: BBox;
    styleRef: number;
    modified: boolean;
  }>;
  /** 行级数据（用于未来精确渲染） */
  lines?: Array<{
    id: string;
    bbox: BBox;
    text: string;
    style: EditableStyle;
  }>;
}

// ── Task 2: Preserve Renderer ──

/**
 * Preserve 模式渲染：使用 glyph bbox / styleRef / originalBounds
 *
 * 保持：
 *   - x/y（从 block.bbox，Layout Engine 已保持原始位置）
 *   - font（从 style.styleRef 解析，不缩小）
 *   - lineHeight（从 style.lineHeight）
 *
 * 每个 block → 一个 RenderableTextObject
 * 携带 glyph 级数据供未来精确渲染
 */
function renderPreserveBlock(
  block: EditableBlock,
  styles: EditableStyle[],
  pageIndex: number
): RenderableTextObject {
  // 拼接文本（保留换行）
  const text = block.lines
    .map((line) => line.glyphs.map((g) => g.char).join(""))
    .join("\n");

  // 取第一行样式
  const firstLine = block.lines[0];
  const style = resolveStyle(firstLine, styles);

  // 收集所有 glyph（扁平化所有行）
  const allGlyphs = block.lines.flatMap((line) =>
    line.glyphs.map((g) => ({
      char: g.char,
      bbox: g.bbox,
      styleRef: g.styleRef,
      modified: g.modified,
    }))
  );

  // 行级数据
  const lines = block.lines.map((l) => ({
    id: l.id,
    bbox: l.bbox,
    text: l.glyphs.map((g) => g.char).join(""),
    style: l.style,
  }));

  return {
    id: block.id,
    type: "text",
    page: pageIndex,
    // 位置：使用 block.bbox（Preserve 模式保持原始位置）
    x: block.bbox.x,
    y: block.bbox.y,
    w: block.bbox.width,
    h: block.bbox.height,
    text,
    // 样式：从 style 固定，不缩小
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    color: style.color,
    // 原文遮盖区域
    originalBounds: block.originalBounds
      ? {
          x: block.originalBounds.x,
          y: block.originalBounds.y,
          w: block.originalBounds.width,
          h: block.originalBounds.height,
        }
      : undefined,
    // 扩展字段
    layoutMode: block.layoutMode || "preserve",
    source: block.source,
    glyphs: allGlyphs,
    lines,
  };
}

// ── Task 3: Reconstruct Renderer ──

/**
 * Reconstruct 模式渲染：使用 LayoutEngine 结果
 *
 * 支持：
 *   - 换行（LayoutEngine 已处理）
 *   - 重新布局（block.bbox 已由 LayoutEngine 重建）
 *
 * 与 Preserve Renderer 的区别：
 *   - block.bbox 可能因换行而高度变化
 *   - glyph 位置由 measureText 重新计算
 */
function renderReconstructBlock(
  block: EditableBlock,
  styles: EditableStyle[],
  pageIndex: number
): RenderableTextObject {
  // Reconstruct 模式的渲染逻辑与 Preserve 相同（LayoutEngine 已处理布局）
  // 区别仅在于 layoutMode 标记
  const result = renderPreserveBlock(block, styles, pageIndex);
  return { ...result, layoutMode: "reconstruct" };
}

// ── 主入口 ──

/**
 * 渲染单个 block → RenderableTextObject
 *
 * 根据 block.layoutMode 选择 Preserve 或 Reconstruct Renderer。
 */
export function renderBlock(
  block: EditableBlock,
  styles: EditableStyle[],
  pageIndex: number
): RenderableTextObject {
  const mode = block.layoutMode || "preserve";
  if (mode === "reconstruct") {
    return renderReconstructBlock(block, styles, pageIndex);
  }
  return renderPreserveBlock(block, styles, pageIndex);
}

/**
 * 渲染某一页的所有 block → RenderableTextObject[]
 *
 * Sprint 20.6: 使用 SignatureSuppressionManager 过滤被抑制的签名 block。
 */
export function renderPage(
  doc: EditableDocument,
  pageIndex: number
): RenderableTextObject[] {
  const page = doc.pages.find((p) => p.index === pageIndex);
  if (!page) return [];

  const suppressedIds = signatureSuppression.getSuppressedBlockIds(pageIndex);

  return page.blocks
    .filter((b) => b.type === "text" && !suppressedIds.has(b.id))
    .map((b) => renderBlock(b, doc.styles, page.index));
}

/**
 * 渲染整个文档 → RenderableTextObject[]
 *
 * Sprint 20.6: 使用 SignatureSuppressionManager 过滤被抑制的签名 block。
 */
export function renderDocument(doc: EditableDocument): RenderableTextObject[] {
  const results: RenderableTextObject[] = [];
  for (const page of doc.pages) {
    const suppressedIds = signatureSuppression.getSuppressedBlockIds(page.index);
    for (const block of page.blocks) {
      if (block.type !== "text") continue;
      if (suppressedIds.has(block.id)) continue;
      results.push(renderBlock(block, doc.styles, page.index));
    }
  }
  return results;
}

// ── 兼容层：RenderableTextObject → editor Block[] ──

/**
 * 把 RenderableTextObject[] 转换为 editor Block[]
 *
 * 兼容现有 PDFCanvas 渲染（期望 Block[] 类型）。
 * RenderableTextObject 的字段与 TextBlock 完全兼容，直接类型转换即可。
 *
 * 保留 fallback：如果 doc 为空或渲染失败，返回空数组。
 */
export function renderToBlocks(doc: EditableDocument): Block[] {
  try {
    const objects = renderDocument(doc);
    // RenderableTextObject 的字段是 TextBlock 的超集，安全转换
    return objects as unknown as Block[];
  } catch (e) {
    console.warn("[DocumentRenderer] renderToBlocks failed, returning empty:", e);
    return [];
  }
}

/**
 * 渲染单页 → editor Block[]（兼容层）
 */
export function renderPageToBlocks(
  doc: EditableDocument,
  pageIndex: number
): Block[] {
  try {
    const objects = renderPage(doc, pageIndex);
    return objects as unknown as Block[];
  } catch (e) {
    console.warn("[DocumentRenderer] renderPageToBlocks failed:", e);
    return [];
  }
}

// ── Sprint 5 Task 2: Block → RenderCommand[] ──

/**
 * 把单个 block 转换为 RenderCommand[]
 *
 * PRESERVE 模式：
 *   - 每个 glyph 使用 originalBBox（保持原始字符位置）
 *   - 使用 styleRef（保持字体）
 *   - 生成 mask DrawLine（原文白色遮盖）
 *
 * RECONSTRUCT 模式：
 *   - 使用 LayoutEngine 结果（glyph.bbox 已由 measureText 计算）
 *   - 生成 mask DrawLine（原文遮盖）
 *
 * @param block 待渲染的 block
 * @param styles 文档级样式表
 * @param pageIndex 页码
 * @returns RenderCommand[]（DrawGlyph + DrawLine mask）
 */
export function renderBlockToCommands(
  block: EditableBlock,
  styles: EditableStyle[],
  pageIndex: number,
  suppressedGlyphBlockIds?: Set<string>,
  rotationMap?: Map<string, number>,
): RenderCommand[] {
  if (block.type !== "text") return [];

  const isSuppressed = suppressedGlyphBlockIds?.has(block.id) ?? false;
  const commands: RenderCommand[] = [];
  const mode = block.layoutMode || "preserve";

  // 1. 原文遮盖矩形（mask）— 白色背景覆盖原文。
  // Sprint-67 Task-002：Geometry Ownership Migration。
  // 几何计算迁入 GeometryAdapter（resolveMaskGeometry），DocumentRenderer 只消费。
  // rotation 优先级：rotationMap（signatureRotationRef）> block.transform.rotation。
  // 对被抑制（suppressed）的签名 handwritten block 同样生成 mask，与 Export 一致。
  const rot = rotationMap?.get(block.id) ?? block.transform?.rotation ?? 0;
  // Task-W2-3B Trace：记录 Renderer 最终 rotation（rotationMap vs transform.rotation）
  const rotationRefVal = rotationMap?.get(block.id) ?? 0;
  const transformRotVal = block.transform?.rotation ?? 0;
  console.log(
    `[SignatureRotationTrace] Stage:Renderer Block:${block.id} ` +
      `rotationRef:${rotationRefVal} transformRotation:${transformRotVal} finalRotation:${rot}`,
  );
  // GeometryAdapter 负责：resolveVisualCoverageBounds（Coverage）+ calculateReplacementMaskBounds（Rotation）。
  const maskGeo = resolveMaskGeometry(block, rot);
  if (maskGeo) {
    commands.push({
      type: "drawLine",
      x: maskGeo.x,
      y: maskGeo.y,
      width: maskGeo.width,
      height: maskGeo.height,
      purpose: "mask",
      blockId: maskGeo.blockId,
    } as DrawLineCommand);
    // Sprint34.13 Debug: 输出 Editor mask geometry（original → expanded）
    // maskGeo 非空 ⇒ originalBounds 非空（resolveMaskGeometry 内部已断言）
    if (typeof console !== "undefined" && block.originalBounds) {
      const ob = block.originalBounds;
      console.log(
        `%c[Sprint34.13][EditorMaskGeometry] id=${block.id} rotation=${rot} suppressed=${isSuppressed} ` +
        `original=(x=${ob.x.toFixed(1)},y=${ob.y.toFixed(1)},w=${ob.width.toFixed(1)},h=${ob.height.toFixed(1)}) ` +
        `expanded=(x=${maskGeo.x.toFixed(1)},y=${maskGeo.y.toFixed(1)},w=${maskGeo.width.toFixed(1)},h=${maskGeo.height.toFixed(1)})`,
        isSuppressed ? "color:#f59e0b;" : "color:#0ea5e9;",
      );
    }
  }

  // 2. 每个 glyph → DrawGlyphCommand
  //    suppressed handwritten block 跳过 glyph 生成，仅保留上方 mask 覆盖原文。
  if (isSuppressed) return commands;

  for (const line of block.lines) {
    for (const glyph of line.glyphs) {
      // PRESERVE 模式优先用 originalBBox（保持原始位置）
      // RECONSTRUCT 模式用 bbox（LayoutEngine 重新计算的位置）
      const bbox =
        mode === "preserve" && glyph.originalBBox
          ? glyph.originalBBox
          : glyph.bbox;

      commands.push({
        type: "drawGlyph",
        char: glyph.char,
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
        styleRef: glyph.styleRef,
        blockId: block.id,
        lineId: line.id,
        modified: glyph.modified,
        transform: glyph.transform,
        // Milestone-1 Sprint C: 携带真实 CSS baseline（Original Fact，ADR-007）
        baseline: glyph.baseline,
      } as DrawGlyphCommand);
    }
  }

  return commands;
}

/**
 * 渲染某一页的所有 block → RenderCommand[]
 */
export function renderPageToCommands(
  doc: EditableDocument,
  pageIndex: number,
  suppressedGlyphBlockIds?: Set<string>,
  rotationMap?: Map<string, number>,
): RenderCommand[] {
  const page = doc.pages.find((p) => p.index === pageIndex);
  if (!page) return [];

  const commands: RenderCommand[] = [];
  for (const block of page.blocks) {
    if (block.type !== "text") continue;
    commands.push(
      ...renderBlockToCommands(block, doc.styles, page.index, suppressedGlyphBlockIds, rotationMap),
    );
  }

  return commands;
}

/**
 * 渲染整个文档 → RenderCommand[]
 */
export function renderDocumentToCommands(doc: EditableDocument): RenderCommand[] {
  const commands: RenderCommand[] = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.type !== "text") continue;
      commands.push(...renderBlockToCommands(block, doc.styles, page.index));
    }
  }
  return commands;
}

// ── 辅助函数 ──

/**
 * 解析行级样式
 *
 * 优先用 line.style（已内联），否则从 styles 数组按 styleRef 查找。
 */
function resolveStyle(
  line: EditableLine | undefined,
  styles: EditableStyle[]
): EditableStyle {
  if (!line) return {};
  if (line.style && Object.keys(line.style).length > 0) {
    return line.style;
  }
  const ref = line.glyphs[0]?.styleRef;
  if (ref !== undefined && styles[ref]) {
    return styles[ref];
  }
  return {};
}
