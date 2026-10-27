/**
 * editor/binding/pdf-export-bridge.ts — EDITOR-CORE-011-B
 *
 * EditorDocument  →  EditableDocument（导出侧 DTO）
 *
 * ── 目标 ────────────────────────────────────────────────────────────
 * 为将来替代这段 **Segment 回写** 做准备：
 *
 *     useExport.ts:119-121
 *     applySegmentEditsToDocument(doc, allEditSegs)   ← 要拆掉的 bridge
 *
 * 011-B 只建立 **契约**，明确「什么能映射、什么映射不了」：
 *   不接 `useExport.ts`、不改 `export-renderer.ts`、不删 Segment。
 *
 * ── 关键结构性映射：Paragraph → 多条 EditableLine ──────────────────
 * 两侧的"行"不是同一概念：
 *   · Core `Paragraph`      = 段落（可能折行成多条视觉行）
 *   · legacy `EditableLine` = **视觉行**（有 bbox / baseline / glyphs）
 * 因此正确映射是 `Paragraph` → `Layout.paragraphs[].lines[]` → **每条视觉行一个 EditableLine**。
 * 这也正是必须注入 `layoutOf` 的原因：Core 文档里没有折行信息（布局是派生数据，§15）。
 *
 * ── 不静默丢失 ─────────────────────────────────────────────────────
 * 本桥接返回 `warnings`（稳定码），把「映射不了的东西」全部显式喊出来。
 * 最重要的三条：
 *   · `missing-original-bounds` —— 被编辑过但没有 originalBounds ⇒ **导出不会盖住旧文字**
 *   · `core-only-block-id`      —— block 没有 PDF 对应物（Core id 当 blockId）⇒ 导出会当新内容
 *   · `missing-layout`          —— 无布局 ⇒ 行/字形几何退化，导出坐标不可信
 *
 * ── 依赖边界 ───────────────────────────────────────────────────────
 * 允许 import：Editor Core `../core/*`、旧 DTO `../../document-model/types`。
 * 禁止 import：React / DOM / `export-renderer` / `useExport` / `applySegmentEditsToDocument` /
 *              `editor-engine` / 旧 renderer 实现。
 */

import { allTextBoxes, createTextStyle } from "../core/document";
import type {
  EditorDocument,
  ImageAsset,
  ImageAssetRef,
  ImageObject,
  TextBoxObject,
  TextRun,
  TextSourceBinding,
  TextStyle,
  TextSourceKind,
} from "../core/document";
import type { TextLayout } from "../core/layout";
import type {
  BBox,
  EditableBlock,
  EditableDocument,
  EditableGlyph,
  EditableLine,
  EditablePage,
  EditableStyle,
  EditableTransform,
  GlyphFontIdentity,
  GlyphMetrics,
  LineRedrawGeometry,
  RenderSource,
  TextSource,
} from "../../document-model/types";
import { toEditableStyle, type FontIdentityProvider } from "./render-command-bridge";
import { isModifiedRun, provenanceOfBinding, textBoxProvenance, type PdfProvenance } from "./provenance";
// B3-C-5-C：图片资产解析（Binding-side；Core 仅持 assetRef，绝不反向依赖本模块）
import { imageAssetRegistry } from "./image-asset-registry";
import type { LegacyLineIdResolver } from "./render-identity";
// F3B-6.17-3C-6A.1-CB2：仅 **type-only** 引入 provider 回调签名。
//   bridge 只认识 `operatorId? / operatorCharIndex?`，不认识 Sidecar（无 runtime 依赖）。
// ★ Step 5B：同理 type-only 引入行级原字体 provider 签名（bridge 不认识 Sidecar）。
import type {
  ExportGlyphProvenanceProvider,
  ExportLineFontIdentityProvider,
} from "./export-glyph-provenance";

// ─────────────────────────────────────────────────────────────────────
//  警告码
// ─────────────────────────────────────────────────────────────────────

export const EXPORT_WARNING_MISSING_LAYOUT = "missing-layout";
export const EXPORT_WARNING_MISSING_ORIGINAL_BOUNDS = "missing-original-bounds";
export const EXPORT_WARNING_CORE_ONLY_BLOCK_ID = "core-only-block-id";
export const EXPORT_WARNING_ASSUMED_RUNTIME = "assumed-runtime";
export const EXPORT_WARNING_PAGE_METRICS_UNIT = "page-metrics-unit-assumption";
export const EXPORT_WARNING_TEXT_SOURCE_FALLBACK = "text-source-fallback";
export const EXPORT_WARNING_PROVENANCE_LESS_RUN = "run-without-pdf-provenance";
export const EXPORT_WARNING_UNKNOWN_RUN = "layout-references-unknown-run";
export const EXPORT_WARNING_GLYPH_TEXT_MISMATCH = "glyph-text-mismatch";
export const EXPORT_WARNING_EMPTY_LINE_DEFAULT_STYLE = "empty-line-default-style";
export const EXPORT_WARNING_DUPLICATE_LEGACY_LINE_ID = "duplicate-legacy-line-id";
// B3-C-5-C：图片导出诊断码
export const EXPORT_WARNING_MISSING_IMAGE_ASSET_REF = "missing-image-asset-ref";
export const EXPORT_WARNING_MISSING_IMAGE_ASSET = "missing-image-asset";
export const EXPORT_WARNING_UNSUPPORTED_IMAGE_MIME = "unsupported-image-mime";
// REENTER-SPLIT-01：visual line slices 在段落 offset 轴上重叠（可证明的重复声明 ⇒ 裁剪并计数）
export const EXPORT_WARNING_SLICE_OVERLAP = "slice-overlap-trimmed";
// 2026-10-25：软折行点省略的行尾空白（布局合法省略；无墨迹，不参与重绘 ⇒ 仅告警观测）
export const EXPORT_WARNING_SLICE_WHITESPACE_OMITTED = "slice-whitespace-omitted";

import { enforceExclusiveSlices, type RunInfo } from "./bridge-slice-integrity";

// ─────────────────────────────────────────────────────────────────────
//  选项
// ─────────────────────────────────────────────────────────────────────

/**
 * F3B-6.17-3C-6B1.1：单行 export drop 投影。
 *
 * 结构上兼容 `ExportDropOperatorProjection["lines"][number]`（不耦合、不 import）。
 */
export interface LineDropProjection {
  droppedOperatorIds?: readonly string[];
  editedOriginalBounds?: readonly BBox[];
}

/** 桥接选项 —— 凡 Core 无法提供的，一律**注入**，不猜 */
export interface EditableDocumentBridgeOptions {
  /** 原始 PDF 文件名 */
  fileName?: string;
  /** 创建时间戳（缺省 0，保证纯函数可复现；012 传 Date.now()） */
  createdAt?: number;
  /** Editor Runtime（Core 没有 renderScale / cssScale，必须由调用方给） */
  runtime?: { renderScale: number; cssScale: number };
  /** 按 TextBox 提供布局（**强烈建议注入**；缺省则行/字形几何退化） */
  layoutOf?: (textBoxId: string) => TextLayout | null;
  /** legacy lineId 解析器（与 `render-command-bridge` 同一决策，二选一，不混用） */
  legacyLineId?: LegacyLineIdResolver;
  /** legacy `RenderSource`（Core 无此概念；缺省 "vector"，即 legacy 文档声明的缺省） */
  renderSourceOf?: (blockId: string, lineId: string) => RenderSource;
  /** `EditableBlock.originalBounds`（**PDF 检测框，Binding 独占**；导出 mask 依赖它） */
  originalBoundsOf?: (blockId: string) => BBox | undefined;
  /** 块级几何变换（旋转/倾斜，PDF 侧身份） */
  blockTransformOf?: (blockId: string) => EditableTransform | undefined;
  /** 块级区域语义（signature / table / stamp / footer） */
  regionTypeOf?: (blockId: string) => EditableBlock["regionType"];
  /** 字符级 PDF 原始度量（PDF 侧身份） */
  /**
   * Step 5A：字符级 PDF 度量（含 **fontIdentity**）provider。
   *
   * 与 `glyphProvenanceOf` 对称：同一 query 形态，由 Binding 层从 Sidecar 解读。
   * 缺省不注入 ⇒ 行为逐字段不变（glyph 不带 metrics）。
   */
  glyphMetricsOf?: ExportGlyphMetricsProvider;
  /**
   * F3B-6.17-3C-6A.1-CB2：**PDF operator provenance provider**（PDF 侧身份）。
   *
   * bridge 只知道 `operatorId? / operatorCharIndex?` 两个字段，**不认识** Sidecar /
   * line key / `OriginalGlyph` / `provenanceUnknown` —— Sidecar 的解读由注入方
   * （Binding 层 `createSidecarGlyphProvenanceProvider`）负责。
   *
   * · **缺省（不注入）⇒ 既有行为逐字段完全不变**（glyph 不带 operator provenance）。
   * · 未命中 / 不能确定性回溯 ⇒ provider 不返回这两个字段 ⇒ glyph 保持 UNKNOWN
   *   （导出侧 `!g.operatorId` 会跳过，绝不误删原算子）。
   */
  glyphProvenanceOf?: ExportGlyphProvenanceProvider;
  /**
   * ★★ P0-1 · glyph 级 **raw-CID provenance** provider（与 `glyphMetricsOf` 刻意分开）。
   *
   * 背景（FONT-1/forensic 定案）：编辑行 `glyph.metrics` 必须 fail-closed 空
   *   （Step 5A/5B 契约、isMeasuredOnly），但 raw-CID 直发（emitRawCidGlyphs）
   *   需要 `pdfCharCode + pdfTransform` **成对**的第一手事实。
   * ⇒ 独立通道：对「LCS 可靠匹配的未变更原字符」回灌两个顶层字段
   *   （`EditableGlyph.pdfCharCode / pdfTransform`），**绝不写 glyph.metrics**，
   *   绝不伪造（无 cid / transform 残缺 ⇒ 返回 undefined ⇒ 该字符保持 fallback）。
   *
   * query 的 `lineId / lineTextSoFar` 由 bridge 提供（行内顺序上下文），
   * Sidecar 的解读由注入方（Binding 层 provider）负责 —— 与 glyphProvenanceOf 同构。
   * 缺省不注入 ⇒ 行为逐字段不变。
   */
  glyphRawProvenanceOf?: (query: {
    source: TextSourceBinding;
    runOffset: number;
    char: string;
    lineId: string | null;
    /** 该 glyph 之前、本行已产出的全部字符（供 provider 做行内顺序对齐） */
    lineTextSoFar: string;
  }) => { pdfCharCode: number; pdfTransform: readonly number[] } | undefined;
  /**
   * F3B-6.17-3C-6B1.1：**export drop 投影 provider**（Binding 侧 overlay 注入点）。
   *
   * 承载两个「Legacy 兼容」导出字段（语义见 `document-model/types.ts`）：
   *   · `droppedOperatorIds`   —— 该行会被**整行重绘** ⇒ 其原算子必须剥离（否则旧文字残留）
   *   · `editedOriginalBounds` —— 该行原始 source 几何（导出侧额外 mask 用）
   *
   * ⚠️ 数据来源**必须**是 BindingSidecar 派生（由 `affected-source-projection` 投影提供）。
   * bridge 本身不认识 Sidecar / 不认识 Core 编辑历史；**缺省不注入 ⇒ 行为逐字段不变**。
   */
  lineDropOf?: (query: {
    textBoxId: string;
    paragraphId: string;
    blockId: string;
    /**
     * **结构位置**（跨 id 空间稳定的匹配键）。
     *
     * ⚠️ 必需：生产里 Core session 可能由 legacy 引导的**第二次 adapter 调用**创建，
     * 其 textBoxId/paragraphId 与 import-time 快照**不同** ⇒ 仅靠 id 匹配会漏。
     * 位置键（page 下标 / textBox 下标 / paragraph 下标，均为**文档顺序**）两侧一致。
     */
    pageIndex: number;
    textBoxIndex: number;
    paragraphIndex: number;
  }) => LineDropProjection | undefined;
  /**
   * F3B-6.28 · D-3B-1/3B-2：**重绘几何 provider**（Binding 侧 overlay 注入点）。
   *
   * 返回**该 legacy 行需要重绘的全部目标行**（按 flow 行序；位移行各自一条）。
   *
   * ⚠️ 红线（3B-1 起延续到 3B-2）：本 provider 的返回值**不得**影响任何既有写入
   *   资格判定（不写 `droppedOperatorIds`、不改 `glyph.modified`、不改 raw-CID 条件）。
   *   缺省不注入 / 返回空 ⇒ 行为与既有实现逐字段一致（不挂任何字段）。
   */
  lineRedrawOf?: (query: {
    textBoxId: string;
    paragraphId: string;
    blockId: string;
    pageIndex: number;
    textBoxIndex: number;
    paragraphIndex: number;
  }) => readonly LineRedrawGeometry[] | null | undefined;
  /**
   * F3B-6.28 · D-3B-2：该 Core 段落是否**已被重绘覆盖**（几何被同段落另一条视觉行认领）。
   *
   * 命中 ⇒ 挂 `EditableLine.redrawCovered`，渲染器跳过既有 overlay（避免重复绘制）。
   * 缺省不注入 ⇒ 行为与既有实现逐字段一致。
   */
  lineRedrawCoveredOf?: (query: {
    textBoxId: string;
    paragraphId: string;
    blockId: string;
    pageIndex: number;
    textBoxIndex: number;
    paragraphIndex: number;
  }) => boolean;
  /**
   * ★ Step 5B：**行级**原字体身份 provider（Binding 侧注入点）。
   *
   * 回答「这条被编辑的 PDF 原始文本行原本用哪个内嵌字体」，写入
   * `EditableLine.originalFontIdentity`，**只**供 export 的 CID/非 WinAnsi 重绘路径消费。
   *
   * ⚠️ 为什么不用既有 `glyphMetricsOf`（glyph 级）：
   *   Core `stripGlyphRange`（§25）会在 run 被编辑后清掉 glyph 索引 ⇒ glyph 级必然
   *   fail-closed ⇒ 编辑行 `glyph.metrics` 恒空。但 `blockId/lineId` 保留，行级可答。
   *
   * ⚠️ 数据来源必须是 BindingSidecar 派生。bridge 本身不认识 Sidecar。
   * 缺省不注入 ⇒ 行为逐字段不变。
   */
  lineFontIdentityOf?: ExportLineFontIdentityProvider;
  /**
   * ★ Step 5B：**行来源回溯表**（行身份在 Core 侧丢失时的确定性兜底）。
   *
   * 何时需要：整行 replace 会把该段**所有** run 变成 `{kind:"generated"}`（`source` 可能是
   * `undefined`），`TextBoxObject.source` 又只有 `blockId` 没有 `lineId`
   * ⇒ 「这一行原本是哪个 PDF 行」在**当前** Core 文档里已不可知。
   * 但 `paragraph.id` 在 replace 前后**稳定**，且 Composition Root 持有 import-time 快照
   * （`beforeDocument`）⇒ 可按 `paragraphId`（及结构位置）**确定性**回溯，不是猜测。
   *
   * ⚠️ 命中不了就返回 `undefined` ⇒ 不写 `originalFontIdentity` ⇒ exporter 如实落既有兜底。
   * 缺省不注入 ⇒ 行为逐字段不变。
   */
  lineSourceFallbackOf?: (query: {
    textBoxId: string;
    paragraphId: string;
    pageIndex: number;
    textBoxIndex: number;
    paragraphIndex: number;
  }) => TextSourceBinding | undefined;
  /** 字体身份（Binding 独占；与 render bridge 共用同一 provider） */
  fontIdentity?: FontIdentityProvider;
  /**
   * B3-C-5-C：图片资产解析器（assetRef → ImageAsset）。
   * 缺省走运行时单例 `imageAssetRegistry`；测试/隔离可注入局部 registry，
   * 避免依赖全局单例。Core 永不持有此 resolver——它只属于 Binding 导出侧。
   */
  imageAssetResolver?: (ref: ImageAssetRef) => ImageAsset | null;
  /**
   * 每页 Y 翻转基准（PDF MediaBox.y0，pt）。
   * 缺省由桥接按 y0=0 计算（`page.height / (renderScale * cssScale)`）；
   * F2 从 legacy `EditablePage.originYPt` 注入，确保 y0≠0 的 PDF 导出 mask 不偏移。
   */
  pageTopPt?: (pageIndex: number) => number | undefined;
}

/** 桥接结果 */
export interface EditableDocumentBridgeResult {
  document: EditableDocument;
  /** 诊断（已去重）：哪些信息映射不了，或用了什么假设 */
  warnings: readonly string[];
  /** 映射统计（验收"信息没有静默丢失"用） */
  stats: {
    textBoxes: number;
    blocks: number;
    lines: number;
    glyphs: number;
    styles: number;
    /** 被判定为"已修改"的 run 数 */
    modifiedRuns: number;
    /** 没有 PDF provenance 的 run 数（用户新增内容） */
    provenanceLessRuns: number;
  };
}

// ─────────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────────

/**
 * `EditorDocument` → `EditableDocument`。
 *
 * 纯函数：不改 `document`；同一输入 + 同一 options → 逐字段相同输出
 * （`createdAt` 未注入时取 0，刻意避免 `Date.now()` 破坏可复现性）。
 */
export function buildEditableDocument(
  document: EditorDocument,
  options: EditableDocumentBridgeOptions = {}
): EditableDocumentBridgeResult {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    warnings.push(message);
  };

  const styles = new ContentStyleRegistry(options.fontIdentity);
  const counters = { lines: 0, glyphs: 0, modifiedRuns: 0, provenanceLessRuns: 0 };

  const pages: EditablePage[] = document.pages.map((page, arrayIndex) => {
    const blocks: EditableBlock[] = [];
    const resolveAsset = options.imageAssetResolver ?? ((ref: ImageAssetRef) => imageAssetRegistry.resolve(ref));

    // ★ 2026-10-22（用户缺陷「cell 修改提交后没有填写到表格里」）：0-based PDF 页号 =
    //   **page.index - 1**（契约：exporter 的 pdf.getPage / strip / mask / 重绘全部按
    //   0-based PDF 页索引定位）。**绝不能用数组下标**——editableDocument 是懒加载的
    //   （实测跳页访问后 pages=[第1页, 第11页]，下标 1 = 第 11 页）⇒ 下标当页索引会把
    //   strip/mask/重绘全部落到 PDF 第 2 页 ⇒ 导出 PDF 原样（修改静默丢失），而清除
    //   完整性核验同样查错页 ⇒ 误报通过。全量文档（index = 下标+1）二者等价 ⇒ 行为不变。
    //   兜底：index 缺失 / < 1（0-based 旧 mock）⇒ 退回数组下标（旧行为）。
    const pageIndex =
      typeof page.index === "number" && Number.isFinite(page.index) && page.index >= 1
        ? page.index - 1
        : arrayIndex;

    for (let objIndex = 0; objIndex < page.objects.length; objIndex++) {
      const obj = page.objects[objIndex];
      if (obj.type === "text") {
        blocks.push(
          buildBlock({
            textBox: obj,
            pageIndex,
            textBoxIndex: objIndex,
            layout: options.layoutOf?.(obj.id) ?? null,
            options,
            styles,
            warn,
            counters,
          })
        );
      } else if (obj.type === "image") {
        // B3-C-5-C：图片对象 → image EditableBlock（assetRef 经 resolver 解析为字节）
        const imgBlock = buildImageBlock({ image: obj, pageIndex, resolveAsset, warn });
        if (imgBlock) blocks.push(imgBlock);
      }
      // 其它类型（将来）暂忽略
    }

    return {
      index: page.index,
      width: page.width,
      height: page.height,
      blocks,
      originYPt: options.pageTopPt?.(page.index),
    };
  });

  if (!options.runtime) {
    warn(
      `${EXPORT_WARNING_ASSUMED_RUNTIME}: 未注入 renderScale/cssScale → 假设 1/1（导出前必须由 Import 侧补齐）`
    );
  }
  warn(
    `${EXPORT_WARNING_PAGE_METRICS_UNIT}: pageMetrics 直接取 Core 页尺寸（Page Canvas Space px）；legacy runtime 声明为 pt —— 012 必须确认单位一致`
  );
  if (counters.provenanceLessRuns > 0) {
    warn(
      `${EXPORT_WARNING_PROVENANCE_LESS_RUN}: ${counters.provenanceLessRuns} 个 run 无 PDF provenance（用户新增内容属正常，但导出不会替换任何原文）`
    );
  }

  const editable: EditableDocument = {
    pages,
    styles: styles.list,
    metadata: { pageCount: pages.length, createdAt: options.createdAt ?? 0 },
    runtime: {
      renderScale: options.runtime?.renderScale ?? 1,
      cssScale: options.runtime?.cssScale ?? 1,
      pageMetrics: document.pages.map((p) => ({ width: p.width, height: p.height })),
    },
  };
  if (options.fileName !== undefined) editable.metadata.fileName = options.fileName;

  return {
    document: editable,
    warnings,
    stats: {
      textBoxes: allTextBoxes(document).length,
      blocks: pages.reduce((n, p) => n + p.blocks.length, 0),
      lines: counters.lines,
      glyphs: counters.glyphs,
      styles: styles.list.length,
      modifiedRuns: counters.modifiedRuns,
      provenanceLessRuns: counters.provenanceLessRuns,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Block
// ─────────────────────────────────────────────────────────────────────

interface BridgeCounters {
  lines: number;
  glyphs: number;
  modifiedRuns: number;
  provenanceLessRuns: number;
}

function buildBlock(input: {
  textBox: TextBoxObject;
  /** 结构位置（文档顺序；供 export drop overlay 跨 id 空间匹配） */
  pageIndex: number;
  textBoxIndex: number;
  layout: TextLayout | null;
  options: EditableDocumentBridgeOptions;
  styles: ContentStyleRegistry;
  warn: (message: string) => void;
  counters: BridgeCounters;
}): EditableBlock {
  const { textBox, layout, options, styles, warn, counters } = input;
  const { pageIndex, textBoxIndex } = input;
  const blockProvenance = textBoxProvenance(textBox);

  if (!layout) {
    warn(
      `${EXPORT_WARNING_MISSING_LAYOUT}: ${textBox.id}（行/字形几何退化为 TextBox 盒，导出坐标不可信）`
    );
  }

  // 决策：blockId 优先沿用 PDF block 身份；没有则用 Core id（**渲染/导出身份**，不是伪造的 PDF id）
  const blockId = blockProvenance?.blockId ?? textBox.id;
  if (!blockProvenance?.blockId) {
    warn(
      `${EXPORT_WARNING_CORE_ONLY_BLOCK_ID}: ${textBox.id}（无 PDF block 身份 → 导出会当作新内容，不会替换原文）`
    );
  }

  const lines: EditableLine[] = [];
  let blockHasModifiedRun = false;
  /** 同一 block 内已用过的 legacy line id（检测"一条 PDF 行被拆成多条视觉行"的 id 碰撞） */
  const usedLegacyLineIds = new Set<string>();
  /** TextBox 内视觉行序号（跨段落连续） */
  let lineIndexInTextBox = 0;

  for (let paragraphIndex = 0; paragraphIndex < textBox.paragraphs.length; paragraphIndex++) {
    const paragraph = textBox.paragraphs[paragraphIndex];
    const paragraphLayout = layout?.paragraphs.find((p) => p.paragraphId === paragraph.id);
    const visualLines = paragraphLayout?.lines ?? [];

    if (visualLines.length === 0) {
      // 无布局（或空段落）：整段退化为一条行，几何取 TextBox 盒
      if (paragraph.runs.length > 0) {
        warn(
          `${EXPORT_WARNING_MISSING_LAYOUT}: ${textBox.id}/${paragraph.id}（整段退化为单行）`
        );
      }
      const degraded = buildLine({
        textBox,
        pageIndex,
        textBoxIndex,
        paragraphIndex,
        blockId,
        blockProvenance,
        paragraph,
        coreLineId: `${paragraph.id}#L0`,
        lineBox: { x: textBox.x, y: textBox.y, width: textBox.width, height: textBox.height },
        lineBaseline: textBox.y,
        slices: null,
        options,
        styles,
        warn,
        counters,
        usedLegacyLineIds,
        visualLineIndex: 0,
        lineIndexInTextBox,
      });
      lines.push(degraded);
      counters.lines += 1;
      lineIndexInTextBox += 1;
      if (degraded.edited) blockHasModifiedRun = true;
      continue;
    }

    // ── REENTER-SPLIT-01：段落级 glyph 唯一归属（互斥账本）──────────────────
    // 拆段 + 新增字符场景中，layoutTextBox（空 provider）产出的相邻行 slices 可能在
    // 段落 offset 轴上重叠（实测 112 glyph > 段落 72 字符 ⇒ 同一字符被两行各携带一份
    // ⇒ 导出重复绘制）。此处强制互斥：可证明的重复声明被裁剪并计数（warn）；
    // 覆盖缺失 / 身份校验失败 ⇒ 抛错（bridge-error ⇒ 上层回退 legacy，绝不产出缺字 PDF）。
    let exclusiveLineSlices: ReturnType<typeof enforceExclusiveSlices> | null = null;
    if (paragraph.runs.length > 0) {
      const runsMap = new Map<string, RunInfo>();
      for (const r of paragraph.runs) {
        runsMap.set(r.id, {
          start: runStartOffset(paragraph.runs, r.id),
          length: r.text.length,
          text: r.text,
        });
      }
      const integrity = enforceExclusiveSlices({
        paragraphText: paragraph.runs.map((r) => r.text).join(""),
        runs: runsMap,
        visualLines: visualLines.map((vl) => vl.runs),
      });
      if (!integrity.ok) {
        throw new Error(
          `[BRIDGE-SLICE-INTEGRITY] ${integrity.reason}: ${textBox.id}/${paragraph.id} ${integrity.details}`,
        );
      }
      if (integrity.duplicateUnits > 0 || integrity.duplicateItems > 0) {
        warn(
          `${EXPORT_WARNING_SLICE_OVERLAP}: ${textBox.id}/${paragraph.id} duplicateUnits=${integrity.duplicateUnits} duplicateItems=${integrity.duplicateItems}（可证明的重复声明已裁剪）`,
        );
      }
      if (integrity.omittedWhitespaceUnits > 0) {
        warn(
          `${EXPORT_WARNING_SLICE_WHITESPACE_OMITTED}: ${textBox.id}/${paragraph.id} omitted=${integrity.omittedWhitespaceUnits}（软折行点省略的行尾空白；无墨迹，不参与重绘）`,
        );
      }
      exclusiveLineSlices = integrity;
    }

    for (let visualLineIndex = 0; visualLineIndex < visualLines.length; visualLineIndex += 1) {
      const lineLayout = visualLines[visualLineIndex];
      const line = buildLine({
        textBox,
        pageIndex,
        textBoxIndex,
        paragraphIndex,
        blockId,
        blockProvenance,
        paragraph,
        coreLineId: lineLayout.lineId,
        lineBox: lineLayout.box,
        lineBaseline: lineLayout.baseline,
        // REENTER-SPLIT-01：互斥后的 slices（每源 glyph 唯一归属；无重复时与原 runs 等价）
        slices: exclusiveLineSlices?.ok ? (exclusiveLineSlices.lines[visualLineIndex] ?? []) : lineLayout.runs,
        options,
        styles,
        warn,
        counters,
        usedLegacyLineIds,
        visualLineIndex,
        lineIndexInTextBox,
      });
      lines.push(line);
      counters.lines += 1;
      lineIndexInTextBox += 1;
      if (line.edited) blockHasModifiedRun = true;
    }
  }

  const originalBounds = options.originalBoundsOf?.(blockId);
  if (!originalBounds && blockHasModifiedRun) {
    warn(
      `${EXPORT_WARNING_MISSING_ORIGINAL_BOUNDS}: ${blockId}（有已修改 run 但无 originalBounds → 导出不会遮盖旧文字，会出现重影）`
    );
  }

  const block: EditableBlock = {
    id: blockId,
    type: "text",
    bbox: { x: textBox.x, y: textBox.y, width: textBox.width, height: textBox.height },
    source: toTextSource(blockProvenance, warn),
    lines,
  };
  if (originalBounds) block.originalBounds = originalBounds;
  const regionType = options.regionTypeOf?.(blockId);
  if (regionType) block.regionType = regionType;
  const blockTransform = options.blockTransformOf?.(blockId);
  if (blockTransform) block.transform = blockTransform;

  return block;
}

// ─────────────────────────────────────────────────────────────────────
//  Image Block（B3-C-5-C）
// ─────────────────────────────────────────────────────────────────────

/**
 * `ImageObject` → image `EditableBlock`。
 *
 * 核心边界（与 C5-A/B 一致）：本桥接**只**经 `resolveAsset(assetRef)` 取字节，
 * **绝不**读取 Core `ImageObject` 的 src/dataURL/bytes/mime（Core 根本没有这些字段），
 * 也**绝不**产生 legacy `Block.src`。字节只在本 Binding 导出 DTO（`EditableBlock.image`）中流转。
 *
 * 解析失败（缺 assetRef / 资产缺失 / MIME 不支持）一律 **warn + 跳过**（不抛、不静默丢失），
 * 由 `warnings` 显式暴露，符合本桥接"不静默丢失"的一贯约定。
 */
function buildImageBlock(input: {
  image: ImageObject;
  pageIndex: number;
  resolveAsset: (ref: ImageAssetRef) => ImageAsset | null;
  warn: (message: string) => void;
}): EditableBlock | null {
  const { image, resolveAsset, warn } = input;

  if (!image.assetRef) {
    warn(`${EXPORT_WARNING_MISSING_IMAGE_ASSET_REF}: ${image.id}（无 assetRef → 跳过图片导出）`);
    return null;
  }
  const asset = resolveAsset(image.assetRef);
  if (!asset) {
    warn(
      `${EXPORT_WARNING_MISSING_IMAGE_ASSET}: ${image.id}（assetRef="${image.assetRef}" 无法解析 → 跳过）`
    );
    return null;
  }
  const mime = asset.mime.toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg") {
    warn(`${EXPORT_WARNING_UNSUPPORTED_IMAGE_MIME}: ${image.id}（mime="${asset.mime}" 不支持 → 跳过）`);
    return null;
  }

  return {
    id: image.id,
    type: "image",
    bbox: { x: image.x, y: image.y, width: image.width, height: image.height },
    source: "pdf_native",
    lines: [],
    image: { bytes: asset.bytes, mime: asset.mime },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Line
// ─────────────────────────────────────────────────────────────────────

interface LineInput {
  textBox: TextBoxObject;
  /** 结构位置（文档顺序；export drop overlay 的稳定匹配键） */
  pageIndex: number;
  textBoxIndex: number;
  paragraphIndex: number;
  blockId: string;
  blockProvenance: PdfProvenance | null;
  paragraph: { id: string; runs: TextRun[] };
  coreLineId: string;
  lineBox: BBox;
  lineBaseline: number;
  /** `null` = 无布局（退化模式：按 run 顺序逐 code point 展开） */
  slices: readonly { runId: string; glyphs: readonly { textIndex: number; length: number; box: BBox }[] }[] | null;
  options: EditableDocumentBridgeOptions;
  styles: ContentStyleRegistry;
  warn: (message: string) => void;
  counters: BridgeCounters;
  /** 同一 block 内已用过的 legacy line id（跨行查重） */
  usedLegacyLineIds: Set<string>;
  /** 段落内视觉行序号（折行必需） */
  visualLineIndex: number;
  /** TextBox 内视觉行序号（跨段落连续） */
  lineIndexInTextBox: number;
}

function buildLine(input: LineInput): EditableLine {
  const { paragraph, options, styles, counters, warn } = input;
  const glyphs: EditableGlyph[] = [];

  let lineModified = false;
  let lineStyleRef: number | null = null;
  /**
   * 行的 PDF 身份：取本行**第一个有 provenance 的 run**。
   *
   * ⚠️ 不能用 TextBox 级的 source 当行 id —— 那是对象级（整块来自哪个 PDF block），
   * 一个 block 有多行，用它会让所有行拿到同一个 id（重复行 id → 编辑行匹配失效）。
   * 也不能用 `RunLayout.textStart` 猜行归属（007 已确定它是行内可见切片）。
   */
  let lineProvenance: PdfProvenance | null = null;

  const emitRunGlyphs = (
    run: TextRun,
    runStartInParagraph: number,
    items: readonly { textIndex: number; length: number; box: BBox }[]
  ): void => {
    const provenance = provenanceOfBinding(run.source);
    if (!lineProvenance && provenance) lineProvenance = provenance;
    const modified = isModifiedRun(provenance);
    if (modified) lineModified = true;
    counters.modifiedRuns += modified ? 1 : 0;
    if (!provenance) counters.provenanceLessRuns += 1;

    const styleRef = styles.getOrCreate(run.id, run.style);
    if (lineStyleRef === null) lineStyleRef = styleRef;

    for (const item of items) {
      const runOffset = item.textIndex - runStartInParagraph;
      const char =
        item.length > 0 && runOffset >= 0 ? run.text.slice(runOffset, runOffset + item.length) : "";
      if (char.length !== item.length) {
        warn(
          `${EXPORT_WARNING_GLYPH_TEXT_MISMATCH}: run=${run.id} paragraphOffset=${item.textIndex} length=${item.length}`
        );
        continue;
      }
      const glyph: EditableGlyph = { char, bbox: item.box, styleRef, modified };
      const metrics = options.glyphMetricsOf?.({ source: run.source, runOffset, char });
      if (metrics) glyph.metrics = metrics;
      // F3B-6.17-3C-6A.1-CB2：恢复 PDF operator provenance（仅显式注入 provider 时）。
      //   provider 只回 `operatorId? / operatorCharIndex?`；缺失 ⇒ 保持 UNKNOWN（不伪造）。
      const provenance = options.glyphProvenanceOf?.({
        source: run.source,
        runOffset,
        char,
      });
      if (provenance?.operatorId) glyph.operatorId = provenance.operatorId;
      if (provenance?.operatorCharIndex !== undefined) {
        glyph.operatorCharIndex = provenance.operatorCharIndex;
      }
      // ★★ P0-1：raw-CID provenance（独立通道，不碰 glyph.metrics —— Step 5A/5B 契约）。
      //   provider fail-closed：无 cid / transform 残缺 ⇒ undefined ⇒ 保持 fallback（绝不猜 CID）。
      const rawProv = options.glyphRawProvenanceOf?.({
        source: run.source,
        runOffset,
        char,
        // ★ run 级 provenance 缺失（generated run）时回退**行级** provenance：
        //   整行 replace 后 run.source 可能全是 generated，但行级 blockId/lineId 仍可靠
        //   （与 lineFontIdentityOf 的行级回溯同一理由）。
        blockId: provenance?.blockId ?? lineProvenance?.blockId ?? null,
        lineId: provenance?.lineId ?? lineProvenance?.lineId ?? null,
        lineTextSoFar: glyphs.map((g) => g.char).join(""),
      });
      if (rawProv && typeof rawProv.pdfCharCode === "number" && Array.isArray(rawProv.pdfTransform) && rawProv.pdfTransform.length === 6) {
        glyph.pdfCharCode = rawProv.pdfCharCode;
        glyph.pdfTransform = [...rawProv.pdfTransform] as TransformMatrix;
      }
      // ★★ D-a-1（P0-2）：originalBBox 独立回填（与 cid 无关 —— 全部可靠匹配的原字符
      //   都有 Sidecar sourceBBox 第一手事实）⇒ per-glyph mask 恢复 original ∪ new 覆盖。
      //   新增字符（游标不前进）⇒ 无 rawProv ⇒ originalBBox 保持 undefined（绝不伪造）。
      if (rawProv?.originalBBox) {
        glyph.originalBBox = { ...rawProv.originalBBox };
      }
      glyphs.push(glyph);
      counters.glyphs += 1;
    }
  };

  /**
   * 无布局时的 code point 展开。
   *
   * ⚠️ `textIndex` 必须是**段落坐标系**（= run 起点 + run 内偏移），
   * 与 `GlyphLayout.textIndex` 同一参照系；用 run-local 偏移会让非首个 run
   * 的 `runOffset` 变成负数 → 字符被整体丢弃。
   */
  const codePointItems = (
    run: TextRun,
    runStartInParagraph: number
  ): { textIndex: number; length: number; box: BBox }[] => {
    const box: BBox = {
      x: input.lineBox.x,
      y: input.lineBox.y,
      width: input.lineBox.width,
      height: input.lineBox.height,
    };
    const items: { textIndex: number; length: number; box: BBox }[] = [];
    let offset = 0;
    while (offset < run.text.length) {
      const code = run.text.codePointAt(offset);
      if (code === undefined) break;
      const char = String.fromCodePoint(code);
      items.push({ textIndex: runStartInParagraph + offset, length: char.length, box });
      offset += char.length;
    }
    return items;
  };

  if (input.slices) {
    // 有布局：按视觉行切片走（glyph 几何来自 Layout，逐字段透传）
    for (const slice of input.slices) {
      const run = findRun(paragraph.runs, slice.runId);
      if (!run) {
        warn(`${EXPORT_WARNING_UNKNOWN_RUN}: 布局引用不存在的 run ${slice.runId}`);
        continue;
      }
      emitRunGlyphs(run, runStartOffset(paragraph.runs, run.id), slice.glyphs);
    }
  } else {
    // 无布局：整段按 run 顺序展开，几何用行盒（已 warn）
    for (const run of paragraph.runs) {
      const runStart = runStartOffset(paragraph.runs, run.id);
      emitRunGlyphs(run, runStart, codePointItems(run, runStart));
    }
  }

  const shell = makeLineShell({
    input,
    glyphs,
    lineModified,
    lineProvenance,
    lineStyle: resolveLineStyle(lineStyleRef, styles, warn, paragraph),
  });

  // F3B-6.17-3C-6B1.1：Binding 侧 export drop overlay。
  //   匹配键 = **Core 身份**（textBoxId + paragraphId）——Core 替换后 run 变成 generated，
  //   桥接产物不再持有 PDF lineId，只有 Core 身份稳定可匹配。
  //   缺省（未注入 provider）⇒ 不写任何字段，行为与既有实现逐字段一致。
  if (options.lineDropOf) {
    const drop = options.lineDropOf({
      textBoxId: input.textBox.id,
      paragraphId: input.paragraph.id,
      blockId: input.blockId,
      pageIndex: input.pageIndex,
      textBoxIndex: input.textBoxIndex,
      paragraphIndex: input.paragraphIndex,
    });
    if (drop) {
      // ★ 2026-10-25（用户缺陷「修改后导出的 PDF 文本重复」）：drop **命中**即显式落
      //   `droppedOperatorIds`（**含空数组**）——空数组 = 投影命中但该行 glyph 无
      //   operatorId provenance（再导出产物重导入 / OCR 文本层）⇒ 剥离不可能，
      //   渲染器据此走 editedOriginalBounds 区域遮盖兜底（export-renderer
      //   skipOverlay 分支）。未命中的行不写该字段 ⇒ 语义三态清晰：
      //   undefined=未命中（零处理）/ 空=命中但剥离不可能（区域遮盖）/ 非空=常规剥离。
      shell.droppedOperatorIds = [...(drop.droppedOperatorIds ?? [])];
      if (drop.editedOriginalBounds?.length) {
        shell.editedOriginalBounds = drop.editedOriginalBounds.map((b) => ({ ...b }));
      }
    }
  }

  // F3B-6.28 · D-3B-1/3B-2：重绘几何挂载（**惰性、不影响任何既有写入资格**）。
  //   与 lineDropOf 同一匹配键体系（Core 身份 → 结构位置）；命中 ⇒ 挂到
  //   `redrawLines`（3B-2 重绘的唯一入口）与 `redrawGeometry`（= 首条，3B-1 诊断形状）；
  //   未注入 provider / 返回空 ⇒ 不挂任何字段，产物与既有实现逐字段一致。
  if (options.lineRedrawOf) {
    const query = {
      textBoxId: input.textBox.id,
      paragraphId: input.paragraph.id,
      blockId: input.blockId,
      pageIndex: input.pageIndex,
      textBoxIndex: input.textBoxIndex,
      paragraphIndex: input.paragraphIndex,
    };
    const redraws = options.lineRedrawOf(query);
    if (redraws && redraws.length > 0) {
      shell.redrawLines = [...redraws];
      shell.redrawGeometry = redraws[0] ?? null;
    } else if (options.lineRedrawCoveredOf?.(query) === true) {
      // 本行属于「已被重绘覆盖的 Core 段落」，只是几何被同段落的另一条视觉行认领了
      // ⇒ 必须标记，否则既有 overlay 会把同一段文字再画一遍。
      shell.redrawCovered = true;
    }
  }

  // ── Step 5B：行级原字体身份（export provenance）─────────────────────────
  //   行来源解析（三级，逐级降级，全部确定性）：
  //     ① 段内第一个带 lineId 的 run.source —— insert / 局部 replace
  //     ② TextBoxObject.source（当它确实带 lineId 时）
  //     ③ 行来源回溯表（import-time 快照按 paragraphId / 结构位置）
  //        —— **整行 replace 的唯一出路**：此时段内 run 全是 generated，①② 都答不出。
  //   ⚠️ 与 `glyph.metrics` 完全无关：编辑行的 glyph 级 metrics 必然为空
  //   （Core stripGlyphRange），但行级「原本用哪个字体」仍可确定回答。
  if (options.lineFontIdentityOf) {
    let lineSource: TextSourceBinding | undefined = paragraph.runs.find((r) => r.source?.lineId)
      ?.source;
    if (!lineSource && input.textBox.source?.lineId) lineSource = input.textBox.source;
    if (!lineSource) {
      lineSource = options.lineSourceFallbackOf?.({
        textBoxId: input.textBox.id,
        paragraphId: paragraph.id,
        pageIndex: input.pageIndex,
        textBoxIndex: input.textBoxIndex,
        paragraphIndex: input.paragraphIndex,
      });
    }
    const identity = lineSource ? options.lineFontIdentityOf({ source: lineSource }) : undefined;
    if (identity) shell.originalFontIdentity = identity;
  }

  return shell;
}

/** 行样式：取该行首个 run 的样式；空行（无 run）时用 Core 默认样式并记警告 */
function resolveLineStyle(
  styleRef: number | null,
  styles: ContentStyleRegistry,
  warn: (message: string) => void,
  paragraph: { id: string }
): EditableStyle {
  if (styleRef !== null) {
    const style = styles.list[styleRef];
    if (style) return style;
  }
  warn(
    `${EXPORT_WARNING_EMPTY_LINE_DEFAULT_STYLE}: 段落 ${paragraph.id} 没有 run → 行样式取 Core 默认值（该行无 glyph，不影响绘制）`
  );
  return toEditableStyle("__empty__", createTextStyle());
}

function makeLineShell(args: {
  input: LineInput;
  glyphs: EditableGlyph[];
  lineModified: boolean;
  lineProvenance: PdfProvenance | null;
  lineStyle: EditableStyle;
}): EditableLine {
  const { input, glyphs, lineModified, lineProvenance, lineStyle } = args;

  // 决策 A（render-identity.ts）：legacy id 只在能解析到时使用，否则用 Core id。
  // 绝不按 `pdf_${blockId}_l${idx}` 公式凭空拼 legacy id（OCR 侧是 UUID，拼了会对不上）。
  const legacyLineId = input.options.legacyLineId?.({
    provenance: lineProvenance,
    coreLineId: input.coreLineId,
    paragraphId: input.paragraph.id,
    textBoxId: input.textBox.id,
    visualLineIndex: input.visualLineIndex,
    lineIndexInTextBox: input.lineIndexInTextBox,
  });

  const id = legacyLineId ?? input.coreLineId;
  if (legacyLineId !== undefined) {
    // 一条 PDF 行被折成多条视觉行时，所有视觉行会解析出**同一个** legacy lineId
    // （Core 的 TextSourceBinding.lineId 是 run 级，天然表达不了折行）。
    // 这会让 `editedLines`（Set）匹配到多条行 → mask 裁剪错行。必须显式报告。
    if (input.usedLegacyLineIds.has(id)) {
      input.warn(
        `${EXPORT_WARNING_DUPLICATE_LEGACY_LINE_ID}: block=${input.blockId} lineId="${id}" 被多条视觉行复用（本条 visualLineIndex=${input.visualLineIndex}，TextBox 内行序=${input.lineIndexInTextBox}）—— resolver 必须使用 visualLineIndex`
      );
    } else {
      input.usedLegacyLineIds.add(id);
    }
  }

  const line: EditableLine = {
    id,
    source: input.options.renderSourceOf?.(input.blockId, input.coreLineId) ?? "vector",
    bbox: input.lineBox,
    baseline: input.lineBaseline,
    glyphs,
    style: lineStyle,
  };
  if (lineModified) line.edited = true;
  return line;
}

// ─────────────────────────────────────────────────────────────────────
//  样式注册表（按**内容**去重）
// ─────────────────────────────────────────────────────────────────────

/**
 * `EditableDocument.styles` 显式声明为「文档级样式表（去重）」
 * （`document-model/types.ts:718`），因此按**样式内容**去重 ——
 * 与 `render-command-bridge` 的「按 runId 不去重」是**两套 DTO 的不同语义**，
 * 两份文件各自写明理由，不存在"哪个对"的问题。
 */
class ContentStyleRegistry {
  private readonly refs = new Map<string, number>();
  private readonly items: EditableStyle[] = [];

  constructor(private readonly fontIdentity?: FontIdentityProvider) {}

  getOrCreate(runId: string, style: TextStyle): number {
    const key = styleContentKey(style, runId, this.fontIdentity);
    const existing = this.refs.get(key);
    if (existing !== undefined) return existing;
    const ref = this.items.length;
    this.items.push(toEditableStyle(runId, style, this.fontIdentity));
    this.refs.set(key, ref);
    return ref;
  }

  get list(): EditableStyle[] {
    return this.items;
  }
}

/** 内容键：包含所有影响渲染的字段 + 字体身份（否则会串味） */
function styleContentKey(
  style: TextStyle,
  runId: string,
  fontIdentity?: FontIdentityProvider
): string {
  return [
    style.fontFamily,
    String(style.fontSize),
    String(style.fontWeight),
    style.fontStyle,
    style.color,
    String(style.lineHeight),
    String(style.letterSpacing),
    style.sourceFontName ?? "",
    fontIdentity?.pdfjsFontFamilyOf?.(runId, style) ?? "",
    fontIdentity?.fontIdOf?.(runId, style) ?? "",
  ].join("\u0001");
}

// ─────────────────────────────────────────────────────────────────────
//  小工具
// ─────────────────────────────────────────────────────────────────────

function findRun(runs: readonly TextRun[], runId: string): TextRun | null {
  for (const run of runs) if (run.id === runId) return run;
  return null;
}

/** run 在段落中的 UTF-16 起点（Document 是权威；**不使用** `RunLayout.textStart`） */
function runStartOffset(runs: readonly TextRun[], runId: string): number {
  let offset = 0;
  for (const run of runs) {
    if (run.id === runId) return offset;
    offset += run.text.length;
  }
  return offset;
}

/** Core `TextSourceKind` → legacy `TextSource`（Core 的 user/generated 在 legacy 无对应值） */
function toTextSource(
  provenance: PdfProvenance | null,
  warn: (message: string) => void
): TextSource {
  const kind: TextSourceKind = provenance?.kind ?? "user";
  if (kind === "pdf-native") return "pdf_native";
  if (kind === "ocr") return "ocr";
  warn(
    `${EXPORT_WARNING_TEXT_SOURCE_FALLBACK}: kind="${kind}" 在 legacy TextSource（pdf_native/ocr/hybrid）中无对应值 → 暂映射为 "hybrid"`
  );
  return "hybrid";
}

// ─────────────────────────────────────────────────────────────────────
//  012-F Production Boundary Guard（EDITED BY 012-F1 AUDIT / F3B-2）
// ─────────────────────────────────────────────────────────────────────
//
// 本桥接（EDITOR-CORE-011-B）在 F3B-2 起**正式接 production export**：
//
//   useExport.ts（F3B-2）默认下载路径变为安全双路径：
//     Core Export ──▶ bytes ──▶ validate ──▶ valid? ─┬─ Yes ─▶ Core PDF
//                                                    └─ No  ─▶ Legacy PDF
//
// 旧生产源（editableDocumentRef.current + applySegmentEditsToDocument + exportEditableDocument）
// 仍完整保留，作为 Core 失败时的 fallback（F3B-2 红线：Legacy fallback 长期存在）。
//
// `CORE_EXPORT_PRODUCTION_WIRED` 是唯一的 wiring 开关，现翻 true，仅表达：
//   "Core production export path is enabled"。
// 实际是否走 Core 由 `runCoreProductionExport` 的 eligibility → success/failure → fallback 决定；
// 关闭为 false 仍可完整回退 legacy only。

/** 012-F Core export path 是否已接 production（F3B-2 起 = true，带安全 legacy fallback） */
export const CORE_EXPORT_PRODUCTION_WIRED = true;

/**
 * 源码级守卫：F3B-2 起要求 Core export path 必须已 production-wired，
 * 且其调用方（useExport）必须保留 legacy fallback（绝不产出坏 PDF）。
 * 未接线（false）即视为违规——与 F1 时代的语义相反，因为 F3B-2 已正式接线。
 */
export function assertCoreExportWired(): void {
  if (!CORE_EXPORT_PRODUCTION_WIRED) {
    throw new Error(
      "[012-F] Core export path 未标注为 production-wired；F3B-2 起必须接 production export，且保留 legacy fallback。"
    );
  }
}
