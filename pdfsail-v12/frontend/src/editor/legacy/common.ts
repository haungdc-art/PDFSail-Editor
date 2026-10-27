/**
 * editor/legacy/common.ts — EDITOR-CORE-005（Legacy Import Adapter 公共部分）
 *
 * ── 为什么放在 editor/legacy/ 而不是 editor/core/ ──────────────────
 * 规范 §58：`src/editor/legacy/` 与 `src/editor/pdf/` 是受控 facade/adapter 层。
 * 本目录**是**允许认识 legacy 结构的地方（§43：adapter 可以理解 legacy，Editor Core 不可以）。
 *
 * 依赖方向（§57，单向）：
 *
 *     PDF Core / legacy（document-model、editor-engine、document-model-v2、ocr）
 *              ↓
 *        editor/legacy（本目录）
 *              ↓
 *        editor/core（EditorDocument / TextPosition / Command / History）
 *
 * editor/core 下**任何文件都不得** import ../legacy 或 legacy 类型。
 *
 * ── 坐标系（§19）──────────────────────────────────────────────────
 * 目标一律是 Editor Core 的 **Page Canvas Space**：原点左上、x 右、y 下、单位 px。
 * 所有受支持的 legacy 来源本身已是 CSS/canvas px（Segment.css*、TextBlock.x/y、
 * SemanticRun.visualBounds、EditableBlock.bbox、OcrTextBlock × cssScale），
 * 因此本层**不做坐标变换**，只做字段搬运 —— 避免制造第 5 套坐标系（架构地图 V4）。
 * 唯一需要映射的 LineGroup 路径由调用方注入既有 CoordinateMapper（见 line-group-adapter.ts）。
 *
 * ── glyph 索引的正确归属（架构地图 V7 / 规范 §9–§10）──────────────
 * legacy 的 blockId / lineId / startGlyphIndex / endGlyphIndex 一律写入
 * `TextSourceBinding`（provenance），**绝不**进入 TextPosition / TextRange / Caret / Selection。
 */

import {
  createEditorDocument,
  createEditorPage,
  createImageObject,
  createParagraph,
  createTextBox,
  createTextRun,
  createTextStyle,
  nextId,
} from "../core/document";
import type {
  EditorDocument,
  EditorObject,
  FontStyle,
  ImageAsset,
  ImageAssetRef,
  ImageObject,
  ParagraphAlignment,
  TextStyle,
  TextSourceBinding,
  TextSourceKind,
} from "../core/document/types";

/** 兜底页尺寸（US Letter pt），仅当来源完全未给出页面尺寸时使用 */
export const DEFAULT_PAGE_WIDTH = 612;
export const DEFAULT_PAGE_HEIGHT = 792;

/**
 * 导入粒度（EDITOR-CORE-012-A）。
 *
 * - `"block"`：缺省。`EditableBlock → TextBoxObject`，`EditableLine → Paragraph`。
 *   这是 **legacy / 兼容** 模式：一个 TextBox 内可以有多条视觉行，
 *   交给 Core Layout 会按 `TextBox.width` **重新折行**并按 `style.lineHeight` **累加 y**，
 *   因此**不能**用作 Core 生产渲染的输入（012-A 审计 §3.2）。
 *
 * - `"visual-line"`：`EditableLine → TextBoxObject`，即
 *   **1 视觉行 = 1 TextBox = 1 Paragraph = 1 Layout Line**。
 *   **Core Production Render 只允许这一种粒度**（012-A 决策 A）。
 *   它使四处几何与原文逐字段一致：
 *     `TextBox.x/y` = `ParagraphLayout.box.x/y` = `LineLayout.box.y` = `GlyphLayout.box.y` = `line.bbox.y`
 *   （`reflow.ts:294/316/344`：首行 `lineTop === textBox.y`；alignment=left 时 `lineX === textBox.x`）
 */
export type LayoutGranularity = "block" | "visual-line";

export interface ImportOptions {
  documentId?: string;
  /**
   * 导入粒度。缺省 `"block"`（兼容旧调用方）。
   * **Core Production Render 必须显式传 `"visual-line"`** —— 见 `LayoutGranularity` 注释。
   */
  layoutGranularity?: LayoutGranularity;
  /** 目标页码（1-based）。多页来源忽略此项，按来源自身页码分页 */
  pageIndex?: number;
  /** 页面宽度（Page Canvas Space px）。缺省由来源推断，再兜底 DEFAULT_PAGE_WIDTH */
  pageWidth?: number;
  /** 页面高度（Page Canvas Space px）。缺省由来源推断，再兜底 DEFAULT_PAGE_HEIGHT */
  pageHeight?: number;
  /** 默认段落对齐（来源未给出时使用） */
  alignment?: ParagraphAlignment;
  /** 默认文本样式（来源未给出时使用） */
  defaultStyle?: Partial<TextStyle>;
}

export interface ImportResult {
  document: EditorDocument;
  /** 生成的 TextBox 数 */
  textBoxes: number;
  /** 生成的段落数 */
  paragraphs: number;
  /** 因空文本 / 未建模类型等原因被跳过的输入数 */
  skipped: number;
  /**
   * 图片资产（F3B-6.24-B3）：adapter 解码出的原始字节资产。
   * 文本导向的 adapter 返回空数组；只有 blocksToEditorDocument 的 ImageBlock 分支会填充。
   */
  assets: ImageAsset[];
  /** 诊断信息（迁移期 §64 双跑对照、以及"哪些数据未被建模"的显式记录） */
  warnings: string[];
}

/**
 * 图片 draft（F3B-6.24-B3）：仅携带 assetRef（字符串引用），不持字节。
 * 真实字节由 ImportResult.assets 承载。
 */
export interface ImportImageDraft {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  transform?: [number, number, number, number];
  assetRef: ImageAssetRef;
}

// ─────────────────────────────────────────────────────────────────────
//  Drop-in draft（各 adapter 只产出 draft，由 materializeImport 统一落成文档）
// ─────────────────────────────────────────────────────────────────────

export interface ImportRunDraft {
  text: string;
  style: TextStyle;
  /** provenance（可缺省）；**不是**位置信息 */
  source?: TextSourceBinding;
}

export interface ImportParagraphDraft {
  runs: ImportRunDraft[];
  alignment?: ParagraphAlignment;
}

export interface ImportBoxDraft {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  /** F3B-6.18-C.1：归一化仿射分量 `[a,b,c,d]`（authoritative；缺省 = 无旋转） */
  transform?: [number, number, number, number];
  source?: TextSourceBinding;
  paragraphs: ImportParagraphDraft[];
}

export interface ImportPageDraft {
  index: number;
  width: number;
  height: number;
  boxes: ImportBoxDraft[];
  /** F3B-6.24-B3：图片对象 draft（与 boxes 同层，都是页面上的 EditorObject） */
  images?: ImportImageDraft[];
}

/**
 * 把 draft 落成 EditorDocument。
 *
 * 全部走 Editor Core 的既有工厂（createTextBox / createParagraph / createTextRun /
 * createEditorPage / createEditorDocument），本层不自己拼装文档结构。
 */
export function materializeImport(
  pages: ImportPageDraft[],
  options: ImportOptions = {},
  warnings: string[] = [],
  /** adapter 侧已经判定"不进入 EditorDocument"的输入数（如未建模的块类型） */
  skippedBeforeMaterialize = 0,
  /** F3B-6.24-B3：图片资产（由调用方解码后传入，与页面内 images draft 的 assetRef 对应） */
  assets: ImageAsset[] = []
): ImportResult {
  let textBoxes = 0;
  let paragraphs = 0;
  let skipped = skippedBeforeMaterialize;

  const editorPages = pages.map((page) => {
    const boxObjects: EditorObject[] = page.boxes
      .filter((box) => {
        // 空 box（无段落，或所有 run 都为空串）不落成 TextBox：
        // 一个空 TextBox 会成为无法定位的 TextPosition 目标（§35）
        const hasText = box.paragraphs.some((p) => p.runs.some((r) => r.text.length > 0));
        if (!hasText) {
          skipped += 1;
          return false;
        }
        return true;
      })
      .map((box) => {
        textBoxes += 1;
        const paras = box.paragraphs.map((para) => {
          paragraphs += 1;
          return createParagraph(
            para.runs.map((run) => {
              const textRun = createTextRun(run.text, run.style);
              if (run.source !== undefined) textRun.source = run.source;
              return textRun;
            }),
            { alignment: para.alignment ?? options.alignment ?? "left" }
          );
        });
        return createTextBox({
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          rotation: box.rotation ?? 0,
          transform: box.transform,
          paragraphs: paras,
          source: box.source,
        });
      });

    // F3B-6.24-B3：图片对象与文本框同层，都是页面上的 EditorObject。
    const imageObjects: ImageObject[] = (page.images ?? []).map((img) =>
      createImageObject({
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
        rotation: img.rotation ?? 0,
        transform: img.transform,
        assetRef: img.assetRef,
      })
    );

    return createEditorPage({
      index: page.index,
      width: page.width,
      height: page.height,
      objects: [...boxObjects, ...imageObjects],
    });
  });

  return {
    document: createEditorDocument({ id: options.documentId, pages: editorPages }),
    textBoxes,
    paragraphs,
    skipped,
    assets,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  样式归一化（legacy 各来源字段形态不一，此处收敛成 TextStyle）
// ─────────────────────────────────────────────────────────────────────

export function normalizeFontWeight(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "bold" || lower === "bolder") return 700;
    if (lower === "lighter") return 300;
    const parsed = Number(lower);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 400;
}

export function normalizeFontStyle(value: string | undefined): FontStyle {
  return value === "italic" || value === "oblique" ? "italic" : "normal";
}

/** 空/非法颜色 → 默认黑；保留原值形态（rgb(...) / #rrggbb）不做解析改写 */
export function normalizeColor(value: string | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "#000000";
}

export interface StyleInput {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  color?: string;
  /** 行高：px 或倍数（由 lineHeightIsRatio 指定语义） */
  lineHeight?: number;
  lineHeightIsRatio?: boolean;
  letterSpacing?: number;
  sourceFontName?: string;
  /** 对齐（不属于 TextStyle，由调用方消费） */
  textAlign?: ParagraphAlignment;
}

/** 收敛为完整 TextStyle（缺省值走 Editor Core 的 createTextStyle） */
export function toTextStyle(input: StyleInput, options: ImportOptions = {}): TextStyle {
  const base = options.defaultStyle ?? {};
  const fontSize = input.fontSize ?? base.fontSize ?? 12;
  const lineHeight =
    input.lineHeight === undefined
      ? base.lineHeight
      : input.lineHeightIsRatio
        ? fontSize * input.lineHeight
        : input.lineHeight;
  const style = createTextStyle({
    ...base,
    fontFamily: input.fontFamily ?? base.fontFamily,
    fontSize,
    fontWeight: normalizeFontWeight(input.fontWeight ?? base.fontWeight),
    fontStyle: normalizeFontStyle(input.fontStyle ?? base.fontStyle),
    color: normalizeColor(input.color ?? base.color),
    lineHeight,
    letterSpacing: input.letterSpacing ?? base.letterSpacing,
  });
  const sourceFontName = input.sourceFontName ?? base.sourceFontName;
  if (sourceFontName !== undefined) style.sourceFontName = sourceFontName;
  return style;
}

/** legacy TextSource → Editor Core TextSourceKind（不冒充 pdf-native） */
export function toSourceKind(source: string | undefined): TextSourceKind {
  switch (source) {
    case "pdf_native":
      return "pdf-native";
    case "ocr":
      return "ocr";
    case "hybrid":
      // 含 OCR 成分，按 ocr 记录；绝不冒充 pdf-native
      return "ocr";
    default:
      return "user";
  }
}

// ─────────────────────────────────────────────────────────────────────
//  几何（只做矩形并集，不做坐标变换）
// ─────────────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function unionRect(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 文本按 "\n" 切成段落（与 createParagraph 的段落语义一致） */
export function splitParagraphs(text: string): string[] {
  return text.split("\n");
}

// ─────────────────────────────────────────────────────────────────────
//  图片资产 ingestion（规范 F3B-6.24-B3）
// ─────────────────────────────────────────────────────────────────────

/**
 * 把 dataURL **同步**解码为 ImageAsset。
 *
 * 约束（用户裁决）：docBlocks 的 ImageBlock.src 经确认恒为 dataURL
 * （PDFEditor 经 `FileReader.readAsDataURL` 写入），因此可同步解码，
 * **不引入异步 / 网络 IO**，adapter 保持同步。
 *
 * 远程 URL / blob 暂不在此处理：需另设 ingestion 路径，禁止把网络 IO 塞进 adapter。
 *
 * 非法输入（非 dataURL / 无法解码）返回 null，由调用方计入 unmodeled。
 */
export function ingestImageDataUrl(src: string): ImageAsset | null {
  const match = /^data:([^;,]*?)?(;base64)?,(.*)$/s.exec(src.trim());
  if (!match) return null;
  const mime = match[1] && match[1].length > 0 ? match[1] : "application/octet-stream";
  const isBase64 = match[2] === ";base64";
  const payload = match[3];
  let bytes: Uint8Array;
  try {
    if (isBase64) {
      const bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      // 非 base64（极少）：按 UTF-8 取字节
      const bin = decodeURIComponent(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
  } catch {
    return null;
  }
  return { id: nextId("asset"), bytes, mime };
}
