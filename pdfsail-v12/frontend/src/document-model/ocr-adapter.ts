/**
 * OCR Adapter — GLM-OCR → EditableDocument
 *
 * Sprint 2 更新：
 *   - 使用 OCR Style Resolver 推断完整样式（4 级 fallback）
 *   - 使用 StyleResolver 注册样式到文档级 styles 数组
 *   - glyph.styleRef 指向 styles 数组索引（不每 glyph 复制 style）
 *
 * 数据流：
 *   GLM-OCR Response
 *     → ocr-utils.ts runPageOCR() → OcrTextBlock[]
 *     → [本文件] ocrBlocksToEditablePage()
 *     → EditablePage（source="ocr"）
 *
 * Sprint 1 要求（保持）：
 *   1. OCR 原始 text 必须完整保存，禁止任何 truncate
 *   2. 保留 bbox、source="ocr"、originalBounds
 *
 * 坐标转换：
 *   OcrTextBlock 坐标在 canvas-pixel space at scale=1.5（ocr-utils.ts 约定）。
 *   本 Adapter 接收 cssScale 参数，转换为 CSS 显示坐标（× cssScale）。
 */

import type {
  EditableDocument,
  EditablePage,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  BBox,
  TransformMatrix,
} from "./types";
import { IDENTITY_TRANSFORM } from "./types";
import { createPage } from "./dom/page-builder";
import { domPageToEditablePage } from "./dom/editable-page-compat";
import type { OcrTextBlock } from "../ocr/ocr-storage";
import { StyleResolver } from "./style-resolver";
import {
  resolveOcrBlockStyle,
  computePageStyleStats,
  type OcrStyleContext,
} from "./ocr-style-resolver";
import { RegionPolicy, LayoutPolicy } from "../application-layer/policy";
import type { Mutation } from "../application-layer/mutation";
import { mutationEngine } from "../application-layer/mutation-engine";

/**
 * 把单页的 OCR blocks 转换为 EditablePage。
 *
 * Sprint 2：接收 StyleResolver 和 OcrStyleContext，推断完整样式。
 *
 * @param ocrBlocks 同一页的 OCR 文本块（canvas px at scale=1.5）
 * @param pageIndex 页码（1-based）
 * @param pageWidth 页面宽度（CSS 显示坐标）
 * @param pageHeight 页面高度（CSS 显示坐标）
 * @param cssScale canvas.clientWidth / canvas.width
 * @param resolver 文档级样式注册器
 * @param styleContext OCR 样式上下文（PDF 原生样式、页面统计等）
 */
export function ocrBlocksToEditablePage(
  ocrBlocks: OcrTextBlock[],
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  cssScale: number,
  resolver: StyleResolver,
  styleContext?: OcrStyleContext
): EditablePage {
  // Sprint 2：如果未提供 styleContext，自动计算页面统计
  const ctx: OcrStyleContext = styleContext || {
    pageStats: computePageStyleStats(ocrBlocks, cssScale),
    resolvedOcrBlocks: [],
  };

  // 解析顺序：按 Y 坐标从上到下，让邻近匹配能利用已解析的 block
  const sortedBlocks = [...ocrBlocks].sort((a, b) => a.y - b.y);
  const resolvedList: Array<{ bbox: BBox; style: EditableStyle }> = [];

  // Sprint36.2（TD-002）：pageHeight 在 OCR canvas px at scale=1.5 坐标系，需转换。
  // regionType/layoutMode 由 Application Policy 产生 Mutation[]，
  // 再由 MutationEngine（唯一 Materializer）应用到 block 并布局。
  // OCR Adapter 不拥有业务字段，也不直接修改 Document。
  const pageHeightOcrSpace = pageHeight / cssScale;
  const regionPolicy = new RegionPolicy();
  const layoutPolicy = new LayoutPolicy();

  const blocks: EditableBlock[] = sortedBlocks.map((ocr) => {
    const rawBlock = ocrBlockToEditableBlock(
      ocr,
      cssScale,
      resolver,
      ctx,
      resolvedList,
      pageWidth,
      pageHeight
    );

    // Application Policy：RegionPolicy + LayoutPolicy 产生 Mutation[]（不改 Document）
    const [regionMutation] = regionPolicy.evaluate({ ocr, pageHeightOcrSpace });
    const [layoutMutation] = layoutPolicy.evaluate({
      ocr,
      regionType: regionMutation.regionType,
    });
    const mutations: Mutation[] = [regionMutation, layoutMutation];

    // MutationEngine（唯一 Materializer）：应用 mutation + 布局。
    // 注意：resolver.toArray() 必须在每次循环内调用（register 随循环增长，须取实时快照）。
    const block = mutationEngine.materializeBlock(rawBlock, mutations, {
      styles: resolver.toArray(),
      pageWidth,
    });

    // 记录已解析的 block 供后续 block 的邻近匹配使用
    resolvedList.push({ bbox: block.bbox, style: block.lines[0]?.style || {} });
    return block;
  });

  // Phase 2 Task-2（Builder Integration）：Builder 以 Page 为唯一生产模型，
  // EditablePage 通过 Compatibility Adapter 产出（domPageToEditablePage 是唯一兼容出口）。
  // 等价性由 Builder Equivalence Golden Test 保证（旧链 == 新链，Consumer 零改动）。
  const domPage = createPage({
    metadata: { index: pageIndex, width: pageWidth, height: pageHeight },
    blocks,
  });
  return domPageToEditablePage(domPage, blocks);
}

/**
 * 单个 OCR block → EditableBlock
 *
 * Sprint 2：用 OCR Style Resolver 推断样式，注册到 resolver。
 * Sprint 3.5+：使用 RECONSTRUCT 模式，根据 availableLineWidth 重新换行（英文按 word）。
 * Sprint 4：根据 regionType 选择不同重建策略：
 *   - paragraph → reconstruct（availableLineWidth + word wrapping + measureText）
 *   - signature → preserve（禁止 reflow，保持 bbox / transform / rotation）
 *   - table → preserve（禁止 reflow，保持单元格结构）
 *   - stamp → preserve（禁止 reflow，保持位置）
 *   - footer → preserve（禁止 reflow，保持位置）
 */
function ocrBlockToEditableBlock(
  ocr: OcrTextBlock,
  cssScale: number,
  resolver: StyleResolver,
  styleContext: OcrStyleContext,
  resolvedOcrBlocks: Array<{ bbox: BBox; style: EditableStyle }>,
  pageWidth?: number,
  pageHeight?: number
): EditableBlock {
  const bbox: BBox = {
    x: ocr.x * cssScale,
    y: ocr.y * cssScale,
    width: ocr.w * cssScale,
    height: ocr.h * cssScale,
  };
  const originalBounds: BBox = { ...bbox };

  // Sprint 2：用 OCR Style Resolver 推断样式（4 级 fallback）
  const ctxWithResolved: OcrStyleContext = {
    ...styleContext,
    resolvedOcrBlocks,
  };
  const { style: resolvedStyle, estimatedLineCount } = resolveOcrBlockStyle(
    ocr,
    cssScale,
    ctxWithResolved
  );

  // 注册样式到 resolver，获取 styleRef
  const styleRef = resolver.register(resolvedStyle);

  // Sprint 3：先构建初始 block（含占位 lines），再用 Layout Engine 重建
  // 初始 lines 只保留文本内容（从 raw text 拆行），bbox 和 glyph 位置由 Layout Engine 精确计算
  // Sprint 5：preserve 区域的 glyph 使用 geometry.transform（恢复旋转角度）
  const geometryTransform = ocr.geometry?.transform;
  const initialLines = buildInitialLines(ocr.text, styleRef, geometryTransform);

  const initialBlock: EditableBlock = {
    id: ocr.id,
    type: "text",
    bbox,
    source: "ocr",
    originalBounds,
    lines: initialLines,
  };

  // Sprint36.1（TD-001）：OCR Adapter 不再拥有业务字段（regionType / layoutMode），
  // 也不再在此执行布局。返回 Raw block（仅 Geometry/Appearance/Content/Metadata 四类字段）。
  // 区域分类（regionType）与布局策略（layoutMode）由 Application Layer 决策，
  // 布局（layoutBlock）在聚合层（ocrBlocksToEditablePage）消费 Application 决策后执行。
  return initialBlock;
}

/**
 * 从原始文本构建初始 lines（仅文本内容，bbox/glyph 位置由 Layout Engine 填充）
 *
 * Sprint 3：不再在此处均分 bbox 生成 glyph，
 * 而是只保留文本结构，交给 Layout Engine 用 measureText 精确重建。
 * Sprint 5：preserve 区域（signature/stamp）的 glyph 使用 geometry.transform 恢复旋转。
 *
 * @param text 原始文本
 * @param styleRef 样式索引
 * @param geometryTransform 几何变换 matrix（preserve 区域的旋转，可选）
 */
function buildInitialLines(
  text: string,
  styleRef: number,
  geometryTransform?: TransformMatrix
): EditableLine[] {
  // 如果有 geometry transform，用它；否则用单位矩阵
  const glyphTransform = geometryTransform ?? IDENTITY_TRANSFORM;
  const rawLines = text.split("\n");
  return rawLines.map((lineText, lineIdx) => ({
    id: `ocr_init_l${lineIdx}`,
    bbox: { x: 0, y: 0, width: 0, height: 0 }, // 占位，Layout Engine 会填充
    glyphs: Array.from(lineText).map((char) => ({
      char,
      originalChar: char,
      bbox: { x: 0, y: 0, width: 0, height: 0 }, // 占位
      styleRef,
      modified: false,
      // Sprint 5：preserve 区域使用 geometry.transform（恢复旋转），
      // 其余区域使用单位矩阵
      transform: glyphTransform,
    })),
    source: "vector",
    style: {}, // 占位，Layout Engine 会从 styleRef 解析
  }));
}

/**
 * 批量转换：多页 OCR blocks → EditableDocument
 *
 * Sprint 2：创建文档级 StyleResolver，所有页共用同一个 styles 数组。
 */
export function ocrBlocksToEditableDocument(
  pagesByIndex: OcrTextBlock[][],
  pageWidth: number,
  pageHeight: number,
  cssScale: number,
  fileName?: string
): EditableDocument {
  const resolver = new StyleResolver();

  const pages: EditablePage[] = pagesByIndex.map((blocks, i) =>
    ocrBlocksToEditablePage(
      blocks,
      i + 1,
      pageWidth,
      pageHeight,
      cssScale,
      resolver
    )
  );

  return {
    pages,
    styles: resolver.toArray(),
    metadata: {
      fileName,
      pageCount: pages.length,
      createdAt: Date.now(),
      renderScale: 1.5,
      cssScale,
    },
  };
}

// ---------------------------------------------------------------------------
// OCR 类型唯一入口（Single Consumer Entry，Story-7）
//
// Document Model 内新代码获得 OCR 类型，必须从本文件 / document-model index 导出，
// 禁止直接 `import { OcrTextBlock } from "../ocr/ocr-storage"`。
// 历史模块（region-classifier / ocr-style-resolver 等）暂不迁移，留给后续 Story。
// ---------------------------------------------------------------------------
export type { OcrTextBlock } from "../ocr/ocr-storage";
