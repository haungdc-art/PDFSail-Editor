/**
 * Document Layout Model — Sprint 33
 *
 * 将 EditableDocument（OCR Block → Line → Glyph）升级为 LayoutNode 树：
 *   Page → Paragraph / SignatureBlock → Line → Word → Glyph
 *
 * 核心能力：
 *   1. 段落检测：按垂直间距 + 水平对齐合并相邻 block
 *   2. 签名块重组：regionType="signature" 的 blocks 合并为 SignatureBlock（含旋转）
 *   3. 词语切分：按空格在 line 内分组 glyph 为 word
 *   4. 旋转传播：签名区域 rotation 从 geometry.transform 提取并向上传播
 *
 * 这是后续 TextEditOverlay 升级和 LineBreakingEngine 的数据基础。
 */

import type {
  EditableDocument,
  EditablePage,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  BBox,
} from "./types";
import { transformMatrixToAngle } from "./geometry-detector";
import {
  reconstructLines,
  type OCRWord,
  type ReconstructedLine,
} from "./layout/line-reconstruction";

// ────────────────────────────────────────────────────────────────
// Layout Tree Types
// ────────────────────────────────────────────────────────────────

/** 布局节点类型 */
export type LayoutNodeType = "page" | "paragraph" | "line" | "word" | "glyph" | "signature" | "signature_line";

/**
 * Convert PDF rotation angle to CSS rotation angle.
 * PDF uses counter-clockwise positive (Y-axis goes up),
 * CSS uses clockwise positive (Y-axis goes down).
 *
 * @param pdfAngle Rotation angle from PDF coordinate system (degrees)
 * @returns CSS-compatible rotation angle (degrees)
 */
export function pdfToCssRotation(pdfAngle: number): number {
  return -pdfAngle;
}

/** 节点的旋转信息 */
export interface LayoutTransform {
  /** 旋转角度（度，顺时针为正，0 = 无旋转） */
  rotation: number;
  /** 水平缩放（1 = 正常） */
  scaleX: number;
  /** 垂直缩放（1 = 正常） */
  scaleY: number;
}

export const IDENTITY_LAYOUT_TRANSFORM: LayoutTransform = {
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

/**
 * LayoutNode — 布局树的统一节点
 *
 * 层级结构：
 *   page (type="page")
 *     ├── paragraph (type="paragraph")
 *     │     ├── line
 *     │     │     ├── word
 *     │     │     │     └── glyph  ← type="glyph"，叶子
 *     │     │     └── word
 *     │     └── line
 *     └── signatureBlock (type="signature")
 *           ├── line
 *           │     ├── word → glyph
 *           │     └── ...
 *           └── line
 */
/** Sprint 33.3.4: 显式坐标空间标记，禁止隐式转换 */
export type CoordinateSpace = "PDF_PT" | "CANVAS_PIXEL" | "CSS_PIXEL";

export interface LayoutNode {
  /** 唯一标识 */
  id: string;
  /** 节点类型 */
  type: LayoutNodeType;
  /** 包围盒 */
  bbox: BBox;
  /** Sprint 33.3.4: bbox 所属坐标空间（默认 CSS_PIXEL） */
  coordinateSpace: CoordinateSpace;
  /** 旋转变换（向上传播，子节点继承父节点 rotation） */
  transform: LayoutTransform;
  /** 子节点数组 */
  children: LayoutNode[];
  /** 节点文本（glyph 有 char，word/line/paragraph 有拼接文本） */
  text?: string;
  /** 字号（word/line/paragraph 取其子节点首 glyph 的 fontSize） */
  fontSize?: number;
  /** 样式索引（指回 LayoutDocument.styles） */
  styleRef?: number;
  /** 源数据引用（EditableBlock ID），用于编辑链路 */
  sourceBlockId?: string;
  /** 源数据引用（EditableLine ID） */
  sourceLineId?: string;
  /** Sprint34.4.2 debug: 段落 line 来源（OCR 原始 / word-level 重建） */
  lineSource?: "OCR_ORIGINAL" | "RECONSTRUCTED";
}

/**
 * LayoutDocument — 顶层布局文档
 *
 * 与 EditableDocument 并存，不替代。所有布局感知操作优先使用 LayoutDocument。
 */
export interface LayoutDocument {
  pages: LayoutNode[];
  styles: EditableStyle[];
  metadata: {
    fileName?: string;
    pageCount: number;
    createdAt: number;
    renderScale?: number;
    cssScale?: number;
  };
}

// ────────────────────────────────────────────────────────────────
// Layout Build Parameters
// ────────────────────────────────────────────────────────────────

/** 签名区域旋转映射：blockId → rotationAngle */
export type SignatureRotationMap = Map<string, number>;

/** buildLayoutDocument 参数 */
export interface LayoutBuildParams {
  /** 源文档 */
  editableDoc: EditableDocument;
  /** 签名 block 旋转角度映射（来自 signatureRotationRef.current） */
  signatureRotations?: SignatureRotationMap;
}

// ────────────────────────────────────────────────────────────────
// Paragraph Detection Heuristics
// ────────────────────────────────────────────────────────────────

/**
 * 两个相邻 paragraph block 是否可以合并为一个逻辑段落。
 *
 * 条件：
 *   1. 垂直间隙 ≤ 2 × 平均行高（说明是同一段落的行间空行）
 *   2. 左对齐误差 ≤ 20px（同段落的行）
 *   3. 字号差异 ≤ 2px（字体一致）
 */
function canMergeAsParagraph(a: EditableBlock, b: EditableBlock): boolean {
  const aBottom = a.bbox.y + a.bbox.height;
  const gap = b.bbox.y - aBottom;

  const aFontSize = a.lines[0]?.style?.fontSize ?? 12;
  const bFontSize = b.lines[0]?.style?.fontSize ?? 12;
  const avgFontSize = (aFontSize + bFontSize) / 2;

  // 条件 1: 垂直间隙不超过 2x 行高
  if (gap > avgFontSize * 2.5) return false;
  // 条件 2: 左对齐
  if (Math.abs(a.bbox.x - b.bbox.x) > 20) return false;
  // 条件 3: 字号接近
  if (Math.abs(aFontSize - bFontSize) > 2) return false;

  // 非空文本检测
  const aText = a.lines.map((l) => l.glyphs.map((g) => g.char).join("")).join("");
  const bText = b.lines.map((l) => l.glyphs.map((g) => g.char).join("")).join("");
  if (!aText.trim() || !bText.trim()) return false;

  return true;
}

// ────────────────────────────────────────────────────────────────
// LayoutNode Builders
// ────────────────────────────────────────────────────────────────

/**
 * 从 EditableGlyph 构建 glyph 叶子节点。
 */
function buildGlyphNode(glyph: EditableGlyph, index: number, parentId: string): LayoutNode {
  const transform = glyph.transform
    ? { rotation: transformMatrixToAngle(glyph.transform), scaleX: 1, scaleY: 1 }
    : IDENTITY_LAYOUT_TRANSFORM;

  return {
    id: `${parentId}_g${index}`,
    type: "glyph",
    bbox: { ...glyph.bbox },
    coordinateSpace: "CSS_PIXEL",
    transform,
    children: [],
    text: glyph.char,
    styleRef: glyph.styleRef,
  };
}

/**
 * 从一行 glyphs 构建 word 节点列表（按空格切分）。
 */
function buildWordNodes(
  line: EditableLine,
  parentId: string,
): { words: LayoutNode[]; lineText: string } {
  const words: LayoutNode[] = [];
  const lineText = line.glyphs.map((g) => g.char).join("");
  let currentWordGlyphs: EditableGlyph[] = [];
  let wordIndex = 0;
  let glyphIndex = 0;

  const flushWord = () => {
    if (currentWordGlyphs.length === 0) return;
    const xs = currentWordGlyphs.map((g) => g.bbox.x);
    const ys = currentWordGlyphs.map((g) => g.bbox.y);
    const rights = currentWordGlyphs.map((g) => g.bbox.x + g.bbox.width);
    const bottoms = currentWordGlyphs.map((g) => g.bbox.y + g.bbox.height);

    const wordText = currentWordGlyphs.map((g) => g.char).join("");
    const wordId = `${parentId}_w${wordIndex}`;

    // 取第一个 glyph 的 transform 作为 word transform
    const firstTransform = currentWordGlyphs[0].transform
      ? { rotation: transformMatrixToAngle(currentWordGlyphs[0].transform), scaleX: 1, scaleY: 1 }
      : IDENTITY_LAYOUT_TRANSFORM;

    words.push({
      id: wordId,
      type: "word",
      bbox: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...rights) - Math.min(...xs),
        height: Math.max(...bottoms) - Math.min(...ys),
      },
      coordinateSpace: "CSS_PIXEL",
      transform: firstTransform,
      children: currentWordGlyphs.map((g, gi) => buildGlyphNode(g, gi, wordId)),
      text: wordText,
      fontSize: line.style?.fontSize,
      styleRef: currentWordGlyphs[0].styleRef,
    });

    currentWordGlyphs = [];
    wordIndex++;
  };

  for (const glyph of line.glyphs) {
    if (glyph.char === " ") {
      flushWord();
      // 空格单独作为 word 节点（方便渲染空格宽度）
      currentWordGlyphs.push(glyph);
      flushWord();
      glyphIndex++;
      continue;
    }
    currentWordGlyphs.push(glyph);
    glyphIndex++;
  }
  flushWord();

  return { words, lineText };
}

/**
 * 从 EditableLine 构建 line 节点。
 */
function buildLineNode(
  line: EditableLine,
  lineIndex: number,
  parentId: string,
  parentTransform: LayoutTransform,
): LayoutNode {
  const lineId = `${parentId}_l${lineIndex}`;
  const { words, lineText } = buildWordNodes(line, lineId);

  return {
    id: lineId,
    type: "line",
    bbox: { ...line.bbox },
    coordinateSpace: "CSS_PIXEL",
    transform: parentTransform,
    children: words,
    text: lineText,
    fontSize: line.style?.fontSize,
    styleRef: line.glyphs[0]?.styleRef,
    sourceLineId: line.id,
  };
}

/**
 * 从 EditableBlock 构建 paragraph/signature 节点。
 *
 * @param block 源 block
 * @param blockIndex 在段落中的序号
 * @param parentId 段落 ID
 * @param nodeType "paragraph" 或 "signature"
 * @param rotation 旋转角度（度，仅签名区域有值）
 */
function buildBlockNode(
  block: EditableBlock,
  blockIndex: number,
  parentId: string,
  nodeType: "paragraph" | "signature",
  rotation: number,
): LayoutNode {
  const blockId = `${parentId}_b${blockIndex}`;
  const transform: LayoutTransform = rotation !== 0
    ? { rotation, scaleX: 1, scaleY: 1 }
    : IDENTITY_LAYOUT_TRANSFORM;

  const lineNodes: LayoutNode[] = block.lines.map((line, li) =>
    buildLineNode(line, li, blockId, transform),
  );

  // 合并所有行文本
  const blockText = lineNodes.map((l) => l.text).join("\n");

  return {
    id: blockId,
    type: nodeType,
    bbox: { ...block.bbox },
    coordinateSpace: "CSS_PIXEL",
    transform,
    children: lineNodes,
    text: blockText,
    sourceBlockId: block.id,
  };
}

/**
 * Sprint34.4.2: 从 blocks 组的 OCR 原始 lines 构建 paragraph 的 line 节点。
 *
 * 展平所有 block.lines（OCR 原始 line boundary），直接构建为 paragraph 的子 line 节点，
 * 不做任何 word-level 重排。仅当 OCR 提供了有效的 line 结构时调用。
 */
function buildParagraphLinesFromOCR(
  blocks: EditableBlock[],
  paraId: string,
): LayoutNode[] {
  const lineNodes: LayoutNode[] = [];
  let li = 0;
  for (const block of blocks) {
    for (const line of block.lines) {
      // 跳过空行（无 glyph 的行不参与编辑内容）
      if (!line.glyphs || line.glyphs.length === 0) continue;
      // 跳过纯空白行（OCR 常把空行作为占位 line）
      const lineText = line.glyphs.map((g) => g.char).join("");
      if (lineText.trim() === "") continue;
      lineNodes.push(buildLineNode(line, li++, paraId, IDENTITY_LAYOUT_TRANSFORM));
    }
  }
  return lineNodes;
}

/**
 * Sprint 33.3: 从段落 blocks 组构建 LayoutNode，使用 word-level line reconstruction。
 *
 * Sprint34.4.2: 改为「优先保留 OCR 原始 line boundary」。
 * 若 blocks 的 OCR lines 有效，直接用 buildParagraphLinesFromOCR 构建（lineSource=OCR_ORIGINAL）；
 * 仅当 OCR 无 line 信息（如 blocks 无 lines）时才走 reconstruction（lineSource=RECONSTRUCTED）。
 * Locked: 签名区域不使用此函数，保持原来的 block→line 结构。
 */
function buildParagraphWithReconstructedLines(
  blocks: EditableBlock[],
  paraId: string,
  pageId: string,
): LayoutNode {
  // 合并 bbox 作为段落区域
  const allBbox = computeUnionBBox(blocks.map((b) => b.bbox));

  // ── Sprint34.4.2: 优先保留 OCR 原始 line boundary ──
  const ocrLineNodes = buildParagraphLinesFromOCR(blocks, paraId);
  if (ocrLineNodes.length > 0) {
    return {
      id: paraId,
      type: "paragraph",
      bbox: allBbox,
      coordinateSpace: "CSS_PIXEL",
      transform: IDENTITY_LAYOUT_TRANSFORM,
      children: ocrLineNodes,
      text: ocrLineNodes.map((l) => l.text ?? "").join("\n"),
      lineSource: "OCR_ORIGINAL",
    };
  }

  // ── OCR 无 line 信息 → 才使用 word-level reconstruction ──
  // 1) 收集所有 glyphs（保持 reading order：Y↑ X←）
  const allGlyphs: EditableGlyph[] = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      for (const glyph of line.glyphs) {
        allGlyphs.push(glyph);
      }
    }
  }

  if (allGlyphs.length === 0) {
    return {
      id: paraId,
      type: "paragraph",
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      coordinateSpace: "CSS_PIXEL",
      transform: IDENTITY_LAYOUT_TRANSFORM,
      children: [],
      lineSource: "RECONSTRUCTED",
    };
  }

  // Sprint 33.3.1: reconstructLines 内部使用 calculateVisualRightBoundary，
  // 不再依赖 paragraphRight（paragraph bbox 过宽会导致换行识别不准）
  const reconstructed = reconstructLines(allGlyphs, 0, {
    yClusterTolerance: 0.5,
  });

  if (reconstructed.length === 0) {
    // fallback：重建失败时保留 OCR 原始行
    const childNodes = blocks.map((block, bi) =>
      buildBlockNode(block, bi, paraId, "paragraph", 0),
    );
    const paraText = childNodes.map((c) => c.text).join("\n");
    return {
      id: paraId,
      type: "paragraph",
      bbox: allBbox,
      coordinateSpace: "CSS_PIXEL",
      transform: IDENTITY_LAYOUT_TRANSFORM,
      children: childNodes,
      text: paraText,
      lineSource: "RECONSTRUCTED",
    };
  }

  // 4) 将 reconstructed lines 转为 LayoutNode line 节点
  const lineNodes: LayoutNode[] = [];
  let glyphGlobalIdx = 0;

  for (let li = 0; li < reconstructed.length; li++) {
    const rLine = reconstructed[li];
    const lineId = `${paraId}_l${li}`;

    // 获取该行第一个 glyph 的 style，用于字体大小
    const firstGlyph = allGlyphs[rLine.glyphStartIndex];
    const fontSize =
      // 从 block.lines[].style.fontSize 查找
      blocks[0]?.lines[0]?.style?.fontSize
      ?? 12;

    // 为每个 word 构建 word → glyph 节点
    const wordNodes: LayoutNode[] = [];
    for (let wi = 0; wi < rLine.words.length; wi++) {
      const word = rLine.words[wi];
      if (word.glyphs.length === 0) continue;

      const wordId = `${lineId}_w${wi}`;
      const wordXs = word.glyphs.map((g) => g.bbox.x);
      const wordYs = word.glyphs.map((g) => g.bbox.y);
      const wordRights = word.glyphs.map((g) => g.bbox.x + g.bbox.width);
      const wordBottoms = word.glyphs.map((g) => g.bbox.y + g.bbox.height);

      const glyphNodes = word.glyphs.map((g, gi) => ({
        id: `${wordId}_g${gi}`,
        type: "glyph" as const,
        bbox: { ...g.bbox },
        coordinateSpace: "CSS_PIXEL" as const,
        transform: g.transform
          ? { rotation: transformMatrixToAngle(g.transform), scaleX: 1, scaleY: 1 }
          : IDENTITY_LAYOUT_TRANSFORM,
        children: [] as LayoutNode[],
        text: g.char,
        styleRef: g.styleRef,
      }));

      wordNodes.push({
        id: wordId,
        type: "word",
        bbox: {
          x: Math.min(...wordXs),
          y: Math.min(...wordYs),
          width: Math.max(...wordRights) - Math.min(...wordXs),
          height: Math.max(...wordBottoms) - Math.min(...wordYs),
        },
        coordinateSpace: "CSS_PIXEL",
        transform: IDENTITY_LAYOUT_TRANSFORM,
        children: glyphNodes,
        text: word.text,
        fontSize,
        styleRef: word.glyphs[0]?.styleRef,
      });
    }

    lineNodes.push({
      id: lineId,
      type: "line",
      bbox: { ...rLine.bbox },
      coordinateSpace: "CSS_PIXEL",
      transform: IDENTITY_LAYOUT_TRANSFORM,
      children: wordNodes,
      text: rLine.text,
      fontSize,
      styleRef: firstGlyph?.styleRef,
      // 使用第一个 block 的 ID 作为 sourceBlockId（编辑链路兼容）
      sourceBlockId: blocks[0]?.id,
      sourceLineId: `${pageId}_b0_l${li}`, // 虚拟 line ID
    });

    glyphGlobalIdx = rLine.glyphEndIndex;
  }

  // 5) 构建段落节点
  const paraText = lineNodes.map((l) => l.text).join("\n");

  return {
    id: paraId,
    type: "paragraph",
    bbox: allBbox,
    coordinateSpace: "CSS_PIXEL",
    transform: IDENTITY_LAYOUT_TRANSFORM,
    children: lineNodes,
    text: paraText,
    lineSource: "RECONSTRUCTED",
  };
}

// ────────────────────────────────────────────────────────────────
// Page Builder
// ────────────────────────────────────────────────────────────────

/**
 * 构建页面 LayoutNode 树。
 *
 * 流程：
 *   1. 按 Y 坐标排序 blocks
 *   2. 分离 paragraph blocks 和 signature blocks
 *   3. 对 paragraph blocks 做垂直间隙合并 → 逻辑段落
 *   4. 对 signature blocks 组合并 → SignatureBlock（带旋转）
 */
function buildPageNode(
  page: EditablePage,
  pageIndex: number,
  signatureRotations?: SignatureRotationMap,
): LayoutNode {
  const pageId = `page_${pageIndex}`;

  // 按 Y 坐标排序
  const sorted = [...page.blocks].sort((a, b) => a.bbox.y - b.bbox.y);

  // Step 1: 分类
  const paragraphBlocks: EditableBlock[] = [];
  const signatureBlocks: EditableBlock[] = [];
  const otherBlocks: EditableBlock[] = [];

  for (const b of sorted) {
    if (b.regionType === "signature") {
      signatureBlocks.push(b);
    } else if (b.regionType === "paragraph" || b.type === "text") {
      paragraphBlocks.push(b);
    } else {
      otherBlocks.push(b);
    }
  }

  const topLevelNodes: LayoutNode[] = [];
  let paraIndex = 0;

  // Step 2: 段落合并（相邻 paragraph blocks）
  if (paragraphBlocks.length > 0) {
    const groups: EditableBlock[][] = [];
    let currentGroup: EditableBlock[] = [paragraphBlocks[0]];

    for (let i = 1; i < paragraphBlocks.length; i++) {
      const prev = currentGroup[currentGroup.length - 1];
      const next = paragraphBlocks[i];
      if (canMergeAsParagraph(prev, next)) {
        currentGroup.push(next);
      } else {
        groups.push(currentGroup);
        currentGroup = [next];
      }
    }
    groups.push(currentGroup);

    // Sprint 33.3: 对每个段落组使用 word-level line reconstruction
    for (const group of groups) {
      const paraId = `${pageId}_p${paraIndex}`;
      const paraNode = buildParagraphWithReconstructedLines(group, paraId, pageId);
      topLevelNodes.push(paraNode);
      paraIndex++;
    }
  }

  // Step 3: 签名区域（合并所有签名 block 为一个 SignatureBlock）
  if (signatureBlocks.length > 0) {
    const sigId = `${pageId}_sig0`;

    // 合并所有签名 block 的旋转角度（取有旋转值的第一个）
    let sigRotation = 0;
    for (const sb of signatureBlocks) {
      const rotAngle = signatureRotations?.get(sb.id);
      if (rotAngle !== undefined && rotAngle !== 0) {
        sigRotation = rotAngle;
        break;
      }
    }
    // 如果没有 rotation map，从 glyph transform 提取
    if (sigRotation === 0) {
      for (const sb of signatureBlocks) {
        for (const line of sb.lines) {
          for (const g of line.glyphs) {
            if (g.transform && g.transform[0] !== 1) {
              sigRotation = transformMatrixToAngle(g.transform);
              break;
            }
          }
          if (sigRotation !== 0) break;
        }
        if (sigRotation !== 0) break;
      }
    }

    const sigNodes = signatureBlocks.map((block, bi) => {
      const node = buildBlockNode(block, bi, sigId, "signature", 0);
      // Sprint 33.3.5 Task 3: Synthesize signature line at block bottom
      const lineNode: LayoutNode = {
        id: `${node.id}_sigline`,
        type: "signature_line",
        bbox: {
          x: block.bbox.x,
          y: block.bbox.y + block.bbox.height - 2,
          width: block.bbox.width,
          height: 1,
        },
        coordinateSpace: "CSS_PIXEL",
        transform: IDENTITY_LAYOUT_TRANSFORM,
        children: [],
        sourceBlockId: block.id,
      };
      node.children = [lineNode, ...node.children];
      return node;
    });

    const sigBbox = computeUnionBBox(signatureBlocks.map((b) => b.bbox));
    const sigText = sigNodes.map((c) => c.text).join("\n");

    const sigTransform: LayoutTransform = sigRotation !== 0
      ? { rotation: sigRotation, scaleX: 1, scaleY: 1 }
      : IDENTITY_LAYOUT_TRANSFORM;

    topLevelNodes.push({
      id: sigId,
      type: "signature",
      bbox: sigBbox,
      coordinateSpace: "CSS_PIXEL",
      transform: sigTransform,
      children: sigNodes,
      text: sigText,
    });
  }

  // Step 4: 其他 block（table/stamp/footer，按 preserve 处理）
  for (const block of otherBlocks) {
    const node = buildBlockNode(block, 0, `${pageId}_other${topLevelNodes.length}`, "paragraph", 0);
    topLevelNodes.push(node);
  }

  return {
    id: pageId,
    type: "page",
    bbox: { x: 0, y: 0, width: page.width, height: page.height },
    coordinateSpace: "CSS_PIXEL",
    transform: IDENTITY_LAYOUT_TRANSFORM,
    children: topLevelNodes,
  };
}

// ────────────────────────────────────────────────────────────────
// Top-Level Builder
// ────────────────────────────────────────────────────────────────

/**
 * 从 EditableDocument 构建 LayoutDocument。
 *
 * @param params.editableDoc 源文档
 * @param params.signatureRotations 签名 block 旋转角度映射
 * @returns 布局文档（LayoutNode 树）
 */
export function buildLayoutDocument(params: LayoutBuildParams): LayoutDocument {
  const { editableDoc, signatureRotations } = params;

  const pages: LayoutNode[] = editableDoc.pages.map((page, i) =>
    buildPageNode(page, i + 1, signatureRotations),
  );

  return {
    pages,
    styles: [...editableDoc.styles],
    metadata: { ...editableDoc.metadata },
  };
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** 计算多个 BBox 的并集 */
function computeUnionBBox(bboxes: BBox[]): BBox {
  if (bboxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = bboxes.map((b) => b.x);
  const ys = bboxes.map((b) => b.y);
  const rights = bboxes.map((b) => b.x + b.width);
  const bottoms = bboxes.map((b) => b.y + b.height);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...rights) - x, height: Math.max(...bottoms) - y };
}

// ────────────────────────────────────────────────────────────────
// Debug Helpers
// ────────────────────────────────────────────────────────────────

export interface LayoutDebugResult {
  pages: Array<{
    id: string;
    topLevel: Array<{
      id: string;
      type: string;
      lineCount: number;
      wordCount: number;
      glyphCount: number;
      textPreview: string;
      rotation: number;
      // Sprint34.4.2: line 来源（OCR_ORIGINAL / RECONSTRUCTED）
      lineSource?: "OCR_ORIGINAL" | "RECONSTRUCTED";
    }>;
  }>;
}

export function layoutDebugSummary(doc: LayoutDocument): LayoutDebugResult {
  return {
    pages: doc.pages.map((page) => ({
      id: page.id,
      topLevel: page.children.map((child) => {
        const lines: LayoutNode[] = [];
        const words: LayoutNode[] = [];
        const glyphs: LayoutNode[] = [];
        collectLeafNodes(child, "line", lines);
        collectLeafNodes(child, "word", words);
        collectLeafNodes(child, "glyph", glyphs);

        return {
          id: child.id,
          type: child.type,
          lineCount: lines.length,
          wordCount: words.length,
          glyphCount: glyphs.length,
          textPreview: (child.text ?? "").substring(0, 60),
          rotation: child.transform.rotation,
          lineSource: child.lineSource,
        };
      }),
    })),
  };
}

function collectLeafNodes(node: LayoutNode, type: string, out: LayoutNode[]): void {
  if (node.type === type) {
    out.push(node);
  }
  for (const child of node.children) {
    collectLeafNodes(child, type, out);
  }
}

// ────────────────────────────────────────────────────────────────
// Sprint 33.1: Layout Tree Inspector — __layoutDump()
// ────────────────────────────────────────────────────────────────

/** 树状 dump 单节点的格式化文本 */
function formatNodeTree(
  node: LayoutNode,
  depth: number,
  isLast: boolean,
  ancestorLastFlags: boolean[],
  maxDepth: number,
  maxTextLen: number,
): string[] {
  if (depth > maxDepth) return [];

  const lines: string[] = [];
  const indent = buildTreeIndent(ancestorLastFlags, depth);

  // ── 节点头部 ──
  const prefix = depth === 0 ? "" : isLast ? "└── " : "├── ";
  const typeLabel = nodeTypeLabel(node.type);
  const headerParts: string[] = [prefix + typeLabel];

  // 旋转（仅非零输出）
  if (node.transform.rotation !== 0) {
    headerParts.push(`rotation:${node.transform.rotation.toFixed(1)}°`);
  }

  lines.push(indent + headerParts.join(" "));

  // 子缩进前缀（用于 bbox / text / children 等属性行）
  const attrIndent = buildTreeAttrIndent(ancestorLastFlags, depth);

  // ── bbox ──
  const b = node.bbox;
  lines.push(
    `${attrIndent}bbox: x:${round1(b.x)} y:${round1(b.y)} ` +
    `w:${round1(b.width)} h:${round1(b.height)}`,
  );

  // ── text ──
  if (node.text && node.text.trim()) {
    const preview = node.text.length <= maxTextLen
      ? node.text
      : node.text.substring(0, maxTextLen) + "...";
    lines.push(`${attrIndent}text: "${preview}"`);
  }

  // ── fontSize ──
  if (node.fontSize !== undefined && node.type !== "glyph") {
    lines.push(`${attrIndent}fontSize: ${node.fontSize}`);
  }

  // ── glyph 细节 ──
  if (node.type === "glyph" && node.fontSize !== undefined) {
    lines.push(`${attrIndent}char: "${node.text}"  fontSize: ${node.fontSize}`);
  }

  // ── children ──
  if (node.children.length > 0) {
    const childTypes = aggregateChildTypes(node);
    lines.push(`${attrIndent}children (${node.children.length}): ${childTypes}`);
  }

  // ── 递归 children ──
  const childMaxDepth = node.type === "page" ? maxDepth : maxDepth - 1;
  if (childMaxDepth > 0 && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childIsLast = i === node.children.length - 1;
      const childLines = formatNodeTree(
        child,
        depth + 1,
        childIsLast,
        [...ancestorLastFlags, isLast],
        childMaxDepth,
        maxTextLen,
      );
      for (const l of childLines) lines.push(l);
    }
  }

  return lines;
}

function nodeTypeLabel(type: string): string {
  switch (type) {
    case "page":      return "PAGE";
    case "paragraph": return "PARAGRAPH";
    case "signature": return "SIGNATURE_BLOCK";
    case "line":      return "LINE";
    case "word":      return "WORD";
    case "glyph":     return "GLYPH";
    default:          return type.toUpperCase();
  }
}

function aggregateChildTypes(node: LayoutNode): string {
  const counts = new Map<string, number>();
  for (const c of node.children) {
    counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([t, n]) => `${nodeTypeLabel(t)}×${n}`)
    .join(" ");
}

function buildTreeIndent(ancestorLastFlags: boolean[], depth: number): string {
  if (depth === 0) return "";
  let s = "";
  // depth-1 个祖先
  for (let i = 0; i < depth - 1; i++) {
    s += ancestorLastFlags[i] ? "    " : "│   ";
  }
  return s;
}

function buildTreeAttrIndent(ancestorLastFlags: boolean[], depth: number): string {
  if (depth === 0) return "";
  let s = "";
  for (let i = 0; i < depth - 1; i++) {
    s += ancestorLastFlags[i] ? "    " : "│   ";
  }
  s += ancestorLastFlags[depth - 1] ? "    " : "│   ";
  return s;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface LayoutDumpOptions {
  /** 最大递归深度（0 = 只打印 page，1 = page → paragraph/signature，...默认 3） */
  maxDepth?: number;
  /** 每行 text 截断长度（默认 72） */
  maxTextLen?: number;
}

export function layoutDump(
  doc: LayoutDocument,
  options: LayoutDumpOptions = {},
): string {
  const maxDepth = options.maxDepth ?? 3;
  const maxTextLen = options.maxTextLen ?? 72;
  const allLines: string[] = [];

  for (const page of doc.pages) {
    const pageB = page.bbox;
    allLines.push(
      `PAGE ${page.id}  (${round1(pageB.width)} × ${round1(pageB.height)})`,
    );
    if (page.children.length === 0) {
      allLines.push("  (no children)");
      continue;
    }
    for (let i = 0; i < page.children.length; i++) {
      const child = page.children[i];
      const childIsLast = i === page.children.length - 1;
      const childLines = formatNodeTree(
        child,
        1,
        childIsLast,
        [true], // page 的 children 在 page 结束后无兄弟线
        maxDepth - 1,
        maxTextLen,
      );
      for (const l of childLines) allLines.push(l);
    }
    allLines.push(""); // 页间空行
  }

  return allLines.join("\n");
}

// ────────────────────────────────────────────────────────────────
// Navigation Helpers (Sprint 33.3 — TextEditOverlay 数据源)
// ────────────────────────────────────────────────────────────────

export interface LineLookupResult {
  /** target line or paragraph node */
  node: LayoutNode;
  /** user-friendly text to edit */
  text: string;
  /** CSS display bbox for overlay */
  bbox: BBox;
  /** parent paragraph or signature node (for rotation) */
  parentNode: LayoutNode;
  /** rotation in degrees */
  rotation: number;
  /** font size in CSS px (from block style, for overlay rendering) */
  fontSize: number;
}

/**
 * 从布局树中查找包含指定 sourceBlockId 的最佳编辑目标。
 *
 * 策略：
 *   (1) 精确匹配 line（sourceBlockId + sourceLineId 均匹配）→ 编辑该行
 *   (2) 匹配 paragraph block（sourceBlockId 匹配）→ 编辑该 block 所有行
 *   (3) fallback → 编辑整个 paragraph
 *
 * @param doc 布局文档
 * @param blockId EditableBlock ID
 * @param lineId 可选 EditableLine ID
 * @returns 编辑目标信息，未找到返回 null
 */
export function findEditTarget(
  doc: LayoutDocument,
  blockId: string,
  lineId?: string,
): LineLookupResult | null {
  for (const page of doc.pages) {
    for (const topNode of page.children) {
      const result = searchInNode(topNode, blockId, lineId, topNode);
      if (result) return result;
    }
  }
  return null;
}

function searchInNode(
  node: LayoutNode,
  blockId: string,
  lineId: string | undefined,
  parentNode: LayoutNode,
): LineLookupResult | null {
  // 精确匹配 line
  if (node.type === "line" && node.sourceLineId === lineId) {
    const fs = node.fontSize || parentNode.fontSize || 14;
    // Sprint34.2: 若该 line 属于 paragraph，编辑内容用完整段落文本，bbox 用段落整体
    const isParagraph = parentNode.type === "paragraph";
    return {
      node,
      text: isParagraph ? (parentNode.text ?? "") : (node.text ?? ""),
      bbox: isParagraph ? { ...parentNode.bbox } : { ...node.bbox },
      parentNode,
      rotation: parentNode.transform.rotation,
      fontSize: fs,
    };
  }

  // 匹配 paragraph/signature 的直接子节点
  //   New (Spr33.3): paragraph → line → word → glyph
  //   Old:            paragraph → block → line → word → glyph  (signature 保留)
  if (
    (node.type === "paragraph" || node.type === "signature") &&
    node.children.length > 0
  ) {
    for (const child of node.children) {
      // Sprint34.2: 编辑目标若是 paragraph，编辑内容用完整段落文本（lines.join("\n")），
      // bbox 用段落整体范围，而不是命中单行。
      const isParagraph = node.type === "paragraph";

      // Case A: child 是 line 节点（Spr33.3 重建的 paragraph）
      if (child.type === "line") {
        if (child.sourceLineId === lineId || child.sourceBlockId === blockId) {
          const fs = child.fontSize || node.fontSize || 14;
          return {
            node: child,
            text: isParagraph ? (node.text ?? "") : (child.text ?? ""),
            bbox: isParagraph ? { ...node.bbox } : { ...child.bbox },
            parentNode: node,
            rotation: node.transform.rotation,
            fontSize: fs,
          };
        }
        continue;
      }

      // Case B: child 是 block 节点（旧 hierarchy，签名区域保留）
      if (child.sourceBlockId === blockId) {
        const fs = child.fontSize || node.fontSize || 14;
        return {
          node: child,
          text: isParagraph ? (node.text ?? "") : (child.text ?? ""),
          bbox: isParagraph ? { ...node.bbox } : { ...child.bbox },
          parentNode: node,
          rotation: node.transform.rotation,
          fontSize: fs,
        };
      }
      if (child.children.length > 0) {
        for (const lineNode of child.children) {
          if (lineNode.sourceLineId === lineId || child.sourceBlockId === blockId) {
            const fs = lineNode.fontSize || child.fontSize || node.fontSize || 14;
            return {
              node: lineNode,
              text: isParagraph ? (node.text ?? "") : (lineNode.text ?? ""),
              bbox: isParagraph ? { ...node.bbox } : { ...lineNode.bbox },
              parentNode: node,
              rotation: node.transform.rotation,
              fontSize: fs,
            };
          }
        }
      }
    }
  }

  // 递归搜索子节点
  for (const child of node.children) {
    const result = searchInNode(child, blockId, lineId, parentNode);
    if (result) return result;
  }

  return null;
}
