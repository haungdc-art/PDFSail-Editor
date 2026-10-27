/**
 * F3B-6.12 — Binding Sidecar Snapshot Builder（两个入口，同一类型）
 *
 * ── 6.12A 冻结的两个 capture entry point ──────────────────────────
 *   1. `buildBindingSidecarFromPdfNative`
 *      在 `pdf-importer` 的 return 点（L219，`assignOperatorProvenance` 之后）执行。
 *      此时 sourceBBox / originalChar / operatorId / metrics / transform / baseline
 *      / originalLineBBox / blockOriginalBounds / renderSource **全部就位**。
 *
 *   2. `buildBindingSidecarFromOcr`
 *      必须在 **OCR 文档构建完成且 Layout Engine 填充之后**执行 ——
 *      OCR 在 adapter 阶段的 glyph/line bbox 仍是 `{0,0,0,0}` 占位。
 *      OCR 无 PDF 算子 ⇒ 无 operator provenance；renderSource 为**推导值**。
 *
 * 两个入口返回**同一个 `BindingSidecar` 类型**，不建立 PdfNativeSidecar / OcrSidecar
 * 之类的第二套模型。
 *
 * 硬约束：
 *   · 只做**深拷贝快照**，不持有 `EditableDocument` 引用
 *   · 不新增 glyph ID（identity = (blockId, lineId) + 行内 index）
 *   · 不伪造 metrics / fontIdentity / operatorId
 */

import type {
  BBox,
  EditableDocument,
  GlyphFontIdentity,
  TransformMatrix,
} from "../../document-model/types";
import {
  freezeSidecar,
  sidecarLineKey,
  type BindingSidecar,
  type BlockBinding,
  type LineBinding,
  type OriginalGlyph,
  type SidecarRenderSource,
} from "./binding-sidecar";
import type { GlyphProvenance } from "./operator-provenance";

// ─────────────────────────────────────────────────────────────────────
//  深拷贝（★ pdf-native 的 block.bbox 与 block.originalBounds 是同一引用，
//          pdf-native-adapter L166/L168 —— 不深拷贝会被后续 mutation 污染）
// ─────────────────────────────────────────────────────────────────────

function cloneBBox(box: BBox | undefined): BBox | undefined {
  if (!box) return undefined;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function cloneTransform(m: TransformMatrix | undefined): TransformMatrix | undefined {
  if (!m) return undefined;
  return [m[0], m[1], m[2], m[3], m[4], m[5]];
}

function cloneFontIdentity(f: GlyphFontIdentity | undefined): GlyphFontIdentity | undefined {
  if (!f) return undefined;
  return { ...f };
}

function normalizeRenderSource(value: string | undefined): SidecarRenderSource {
  return value === "image" || value === "image-ocr" ? value : "vector";
}

// ─────────────────────────────────────────────────────────────────────
//  内部：共用骨架
// ─────────────────────────────────────────────────────────────────────

interface BuildOptions {
  generation: number;
  origin: BindingSidecar["origin"];
  /**
   * 逐行产出 LineBinding。
   * `blockSource` 用于 OCR 的 renderSource 推导（6.12A）。
   * `pageIndex` / `pageFlatGlyphIndex` 供 pdf-native builder 从预计算的 provenance map
   * 定位本行 glyph 的全局下标（F3B-6.17-3C-6B1.1-P1-C）。
   */
  buildLine(input: {
    blockId: string;
    blockSource: string | undefined;
    lineId: string;
    lineIdx: number;
    lineSource: string | undefined;
    lineBBox: BBox | undefined;
    glyphs: EditableDocument["pages"][number]["blocks"][number]["lines"][number]["glyphs"];
    pageIndex: number;
    pageFlatGlyphIndex: number;
  }): LineBinding;
}

function buildInternal(document: EditableDocument, options: BuildOptions): BindingSidecar {
  const lines: Record<string, LineBinding> = {};
  const blocks: Record<string, BlockBinding> = {};
  // F3B-6.17 3B'-A：page-level originYPt（import 捕获，只读）
  const pages: Record<number, { originYPt?: number }> = {};

  for (const page of document.pages ?? []) {
    pages[page.index] =
      page.originYPt === undefined ? {} : { originYPt: page.originYPt };
    // 本页 glyph 的扁平行运行下标（block→line→glyph 文档顺序，与 compute 同序）。
    let flatGlyphIndex = 0;
    for (const block of page.blocks ?? []) {
      // blockOriginalBounds：pdf-native 与 OCR 同口径（与 layout engine L126/L57 一致）
      // F3B-6.17 3B'-B：同时记录「是否真实检测」，供 export 侧 fail-closed 判定。
      // ⚠️ sidecar 记录原始事实（含 bbox 回退值），**判定策略在 provider**，不在 builder。
      const detectedBounds = block.originalBounds !== undefined;
      blocks[block.id] = {
        blockId: block.id,
        blockOriginalBounds: cloneBBox(detectedBounds ? block.originalBounds! : block.bbox),
        blockOriginalBoundsDetected: detectedBounds,
      };

      const blockLines = block.lines ?? [];
      for (let lineIdx = 0; lineIdx < blockLines.length; lineIdx++) {
        const line = blockLines[lineIdx];
        const binding = options.buildLine({
          blockId: block.id,
          blockSource: block.source,
          lineId: line.id,
          lineIdx,
          lineSource: line.source,
          lineBBox: line.bbox,
          glyphs: line.glyphs ?? [],
          pageIndex: page.index,
          pageFlatGlyphIndex: flatGlyphIndex,
        });
        flatGlyphIndex += line.glyphs?.length ?? 0;
        lines[sidecarLineKey(block.id, line.id)] = binding;
      }
    }
  }

  return freezeSidecar({
    generation: options.generation,
    origin: options.origin,
    pages,
    lines,
    blocks,
    frozen: false,
  });
}

// ─────────────────────────────────────────────────────────────────────
//  入口 1：PDF native
// ─────────────────────────────────────────────────────────────────────

/**
 * PDF-native capture point：`pdf-importer` L219（operator provenance 已 pin、
 * RenderSource 已由 `classifyLineRenderSources` 检测、且尚未被任何 Layout Engine 重置）。
 *
 * F3B-6.17-3C-6B1.1-P1-C：builder 只 **consume** provenance，不 compute。
 * `operatorProvenance` 由 Browser caller 预计算并传入（键 = pageIndex，值 = 该页扁平行
 * `GlyphProvenance[] | null`）。未传入时退回从 `glyph.operatorId` 读取（向后兼容 / OCR 等）。
 */
export function buildBindingSidecarFromPdfNative(
  document: EditableDocument,
  generation: number,
  operatorProvenance?: ReadonlyMap<number, GlyphProvenance[] | null>,
): BindingSidecar {
  return buildInternal(document, {
    generation,
    origin: "pdf-native",
    buildLine: ({ blockId, lineId, lineIdx, lineSource, lineBBox, glyphs, pageIndex, pageFlatGlyphIndex }) => {
      // 预计算 map 优先（P1-C 的「计算与写回分离」契约）；缺失则退回 glyph.operatorId。
      const pageProv = operatorProvenance?.get(pageIndex) ?? null;
      const fromMap = operatorProvenance ? (pageProv ?? []) : null;
      const originalGlyphs: OriginalGlyph[] = glyphs.map((glyph, index) => {
        const pv = fromMap ? fromMap[pageFlatGlyphIndex + index] : undefined;
        return {
          index,
          sourceBBox: cloneBBox(glyph.bbox) ?? { x: 0, y: 0, width: 0, height: 0 },
          originalChar: glyph.originalChar,
          operatorId: pv ? pv.operatorId : glyph.operatorId,
          operatorCharIndex: pv ? pv.operatorCharIndex : glyph.operatorCharIndex,
          provenanceUnknown: pv ? pv.operatorId === undefined : glyph.operatorId === undefined,
          metrics: glyph.metrics ? { ...glyph.metrics } : undefined,
          pdfCharCode: glyph.pdfCharCode,
          fontIdentity: cloneFontIdentity(glyph.fontIdentity),
          transform: cloneTransform(glyph.transform),
          baseline: glyph.baseline,
        };
      });

      return {
        blockId,
        lineId,
        lineIdx,
        renderSource: normalizeRenderSource(lineSource),
        originalLineBBox: cloneBBox(lineBBox),
        originalGlyphs,
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
//  入口 2：OCR（必须在 Layout Engine 填充之后）
// ─────────────────────────────────────────────────────────────────────

/**
 * OCR capture point：OCR 文档构建完成 + Layout Engine 填充之后。
 *
 * 与 pdf-native 的差异（全部来自 6.12A 裁决）：
 *   · `geometryEstimated = true`  —— OCR glyph 几何是布局估算，非检测真值
 *   · `renderSource`：block.source === "ocr" ⇒ "image-ocr" 且 `renderSourceDerived = true`
 *     （**推导/保守 fallback**，非 detector 结果；detector 在纯扫描件上会给 "image"）
 *   · **无** operatorId / operatorCharIndex ⇒ `provenanceUnknown = true`
 *   · **不**填 metrics / pdfCharCode / fontIdentity（禁止伪造）
 */
export function buildBindingSidecarFromOcr(
  document: EditableDocument,
  generation: number
): BindingSidecar {
  return buildInternal(document, {
    generation,
    origin: "ocr",
    buildLine: ({ blockId, blockSource, lineId, lineIdx, lineSource, lineBBox, glyphs }) => {
      const isOcr = blockSource === "ocr";

      const originalGlyphs: OriginalGlyph[] = glyphs.map((glyph, index) => ({
        index,
        sourceBBox: cloneBBox(glyph.bbox) ?? { x: 0, y: 0, width: 0, height: 0 },
        geometryEstimated: true,
        originalChar: glyph.originalChar,
        // OCR 文本不是 PDF 算子 ⇒ 无 provenance，且不得伪造
        operatorId: undefined,
        operatorCharIndex: undefined,
        provenanceUnknown: true,
        transform: cloneTransform(glyph.transform),
        baseline: glyph.baseline,
      }));

      return {
        blockId,
        lineId,
        lineIdx,
        renderSource: isOcr ? "image-ocr" : normalizeRenderSource(lineSource),
        renderSourceDerived: isOcr ? true : undefined,
        originalLineBBox: cloneBBox(lineBBox),
        originalGlyphs,
      };
    },
  });
}
