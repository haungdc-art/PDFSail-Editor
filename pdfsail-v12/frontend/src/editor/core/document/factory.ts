/**
 * editor/core/document/factory.ts — EDITOR-CORE-001
 *
 * 模型创建工厂。全部为纯函数（除 id 序列计数器），不依赖 React / DOM / PDF。
 *
 * 规范约束：
 *   - §7  不新建顶层模型目录，直接扩展 editor/core/
 *   - §13 命令 API 必须与 React 无关 → 工厂保持纯函数
 *   - §42 本阶段只建模型，不改 UI、不改导出、不删 legacy
 */

import type {
  EditorDocument,
  EditorObject,
  EditorPage,
  ImageAssetRef,
  ImageObject,
  Paragraph,
  ParagraphAlignment,
  TextBoxObject,
  TextRun,
  TextStyle,
  TextSourceBinding,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
//  ID 生成
// ─────────────────────────────────────────────────────────────────────

/**
 * 模块级单调计数器。
 *
 * 不用 crypto.randomUUID()：
 *   - 便于单测可复现（配合 resetIdSequence）
 *   - Node / 浏览器 / worker 三种运行环境行为一致
 *   - 序列化 round-trip 后 id 稳定
 */
let _seq = 0;

export function nextId(prefix: string): string {
  _seq += 1;
  return `${prefix}_${_seq.toString(36)}`;
}

/** 仅供测试：重置 id 序列，保证断言可复现 */
export function resetIdSequence(value = 0): void {
  _seq = value;
}

// ─────────────────────────────────────────────────────────────────────
//  默认值
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_FONT_FAMILY = "sans-serif";
export const DEFAULT_FONT_SIZE = 12;
export const DEFAULT_FONT_WEIGHT = 400;
export const DEFAULT_FONT_STYLE = "normal";
export const DEFAULT_COLOR = "#000000";
/** 行高缺省系数：与 editor/document-engine/layout-engine.ts 的 1.3 保持一致 */
export const DEFAULT_LINE_HEIGHT_RATIO = 1.3;

export function createTextStyle(over: Partial<TextStyle> = {}): TextStyle {
  const fontSize = over.fontSize ?? DEFAULT_FONT_SIZE;
  const style: TextStyle = {
    fontFamily: over.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontSize,
    fontWeight: over.fontWeight ?? DEFAULT_FONT_WEIGHT,
    fontStyle: over.fontStyle ?? DEFAULT_FONT_STYLE,
    color: over.color ?? DEFAULT_COLOR,
    letterSpacing: over.letterSpacing ?? 0,
    lineHeight: over.lineHeight ?? fontSize * DEFAULT_LINE_HEIGHT_RATIO,
  };
  // sourceFontName 是 provenance，未给出时保持 undefined（不写空串）
  if (over.sourceFontName !== undefined) style.sourceFontName = over.sourceFontName;
  // 文本装饰（V1 format capability）：underline / strike 缺省 undefined（不写 false）
  if (over.underline !== undefined) style.underline = over.underline;
  if (over.strike !== undefined) style.strike = over.strike;
  return style;
}

// ─────────────────────────────────────────────────────────────────────
//  Run / Paragraph
// ─────────────────────────────────────────────────────────────────────

export function createTextRun(
  text: string,
  style: TextStyle | Partial<TextStyle> = {},
  id?: string
): TextRun {
  return {
    id: id ?? nextId("run"),
    text,
    // 允许直接传 Partial：内部判定是否已是完整 TextStyle（含 fontFamily + fontSize）
    style: isTextStyle(style) ? style : createTextStyle(style),
  };
}

function isTextStyle(v: TextStyle | Partial<TextStyle>): v is TextStyle {
  return typeof v.fontFamily === "string" && typeof v.fontSize === "number";
}

export interface CreateParagraphOptions {
  alignment?: ParagraphAlignment;
  /** 传入 string 时的统一样式 */
  style?: TextStyle | Partial<TextStyle>;
  id?: string;
}

/**
 * 创建段落。
 *
 * runs 允许三种形态：
 *   - string      → 单 run 纯文本
 *   - TextRun[]   → 多 run（富文本）
 * 空 runs 是合法的（空段落），供 Enter 拆段 / 删除后使用。
 */
export function createParagraph(
  runs: string | TextRun[],
  options: CreateParagraphOptions = {}
): Paragraph {
  const normalized: TextRun[] =
    typeof runs === "string"
      ? [createTextRun(runs, options.style ?? {})]
      : runs.map((r) => r);
  return {
    id: options.id ?? nextId("para"),
    runs: normalized,
    alignment: options.alignment ?? "left",
  };
}

// ─────────────────────────────────────────────────────────────────────
//  TextBox
// ─────────────────────────────────────────────────────────────────────

export interface CreateTextBoxInit {
  /** Page Canvas Space（左上原点，y 向下），px */
  x: number;
  y: number;
  /** 布局约束宽高，px（规范 §16：真实布局容器） */
  width: number;
  height: number;
  rotation?: number;
  /**
   * F3B-6.18-C.1：PDF 文本矩阵的归一化仿射分量 `[a,b,c,d]`（**authoritative**）。
   * 未显式传 `rotation` 时，`rotation` 由本字段派生（`atan2(b,a)`）—— 避免两套真相。
   */
  transform?: [number, number, number, number];
  /** 显式段落；与 text 二选一 */
  paragraphs?: Paragraph[];
  /** 便捷入参：单段纯文本 */
  text?: string;
  style?: TextStyle | Partial<TextStyle>;
  alignment?: ParagraphAlignment;
  source?: TextSourceBinding;
  id?: string;
}

export function createTextBox(init: CreateTextBoxInit): TextBoxObject {
  let paragraphs = init.paragraphs;
  if (!paragraphs) {
    paragraphs =
      init.text === undefined
        ? [createParagraph("", { style: init.style, alignment: init.alignment })]
        : [createParagraph(init.text, { style: init.style, alignment: init.alignment })];
  }
  const box: TextBoxObject = {
    id: init.id ?? nextId("tb"),
    type: "text",
    x: init.x,
    y: init.y,
    width: init.width,
    height: init.height,
    rotation: init.rotation ?? (init.transform ? transformAngle(init.transform) : 0),
    paragraphs,
  };
  if (init.transform !== undefined) box.transform = init.transform;
  if (init.source !== undefined) box.source = init.source;
  return box;
}

/** F3B-6.18-C.1：`[a,b,c,d]` → 顺时针角度（度）。Core 不 import document-model，故此处本地实现。 */
function transformAngle(t: readonly [number, number, number, number]): number {
  return (Math.atan2(t[1], t[0]) * 180) / Math.PI;
}

// ─────────────────────────────────────────────────────────────────────
//  ImageObject（规范 F3B-6.24-B3）
// ─────────────────────────────────────────────────────────────────────

export interface CreateImageObjectInit {
  /** Page Canvas Space（左上原点，y 向下），px */
  x: number;
  y: number;
  /** 布局约束宽高，px */
  width: number;
  height: number;
  rotation?: number;
  /**
   * F3B-6.18-C.1：PDF 图片矩阵的归一化仿射分量 `[a,b,c,d]`（authoritative）。
   * 未显式传 `rotation` 时，`rotation` 由本字段派生——避免两套真相。
   */
  transform?: [number, number, number, number];
  /** 指向 Binding 层 ImageAsset 的字符串引用（不持字节） */
  assetRef: ImageAssetRef;
  id?: string;
}

export function createImageObject(init: CreateImageObjectInit): ImageObject {
  const obj: ImageObject = {
    id: init.id ?? nextId("img"),
    type: "image",
    x: init.x,
    y: init.y,
    width: init.width,
    height: init.height,
    rotation: init.rotation ?? (init.transform ? transformAngle(init.transform) : 0),
    assetRef: init.assetRef,
  };
  if (init.transform !== undefined) obj.transform = init.transform;
  return obj;
}

// ─────────────────────────────────────────────────────────────────────
//  Page / Document
// ─────────────────────────────────────────────────────────────────────

export interface CreateEditorPageInit {
  /** 1-based 页码 */
  index: number;
  width: number;
  height: number;
  objects?: EditorObject[];
  id?: string;
}

export function createEditorPage(init: CreateEditorPageInit): EditorPage {
  return {
    id: init.id ?? nextId("page"),
    index: init.index,
    width: init.width,
    height: init.height,
    objects: init.objects ? init.objects.map((o) => o) : [],
  };
}

export interface CreateEditorDocumentInit {
  id?: string;
  pages?: EditorPage[];
  version?: number;
}

export function createEditorDocument(init: CreateEditorDocumentInit = {}): EditorDocument {
  return {
    id: init.id ?? nextId("doc"),
    pages: init.pages ? init.pages.map((p) => p) : [],
    version: init.version ?? 1,
  };
}

/**
 * 递增文档版本（规范 §66：细粒度失效判定）。
 * 返回新对象，不原地修改入参。
 */
export function bumpVersion(doc: EditorDocument): EditorDocument {
  return { ...doc, version: doc.version + 1 };
}

// ─────────────────────────────────────────────────────────────────────
//  结构化浅拷贝（历史快照 / 命令层使用）
// ─────────────────────────────────────────────────────────────────────

/**
 * 深拷贝文档（结构与文本完全隔离）。
 *
 * 供 EDITOR-CORE-003/004 的命令与历史使用；现阶段仅提供能力，未被任何生产路径调用。
 * 用 JSON 而非 structuredClone：后者在有 function/undefined 字段时行为不一致，
 * 且与序列化路径（serialize.ts）保持同一份语义。
 */
export function cloneEditorDocument(doc: EditorDocument): EditorDocument {
  return JSON.parse(JSON.stringify(doc)) as EditorDocument;
}
