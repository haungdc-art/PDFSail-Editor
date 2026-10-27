/**
 * editor/core/document/serialize.ts — EDITOR-CORE-001
 *
 * EditorDocument 的序列化 / 反序列化 + 结构校验。
 *
 * 用途：
 *   - 持久化 / 调试快照（规范 §67：每层状态都要可 inspect）
 *   - 未来 IndexedDB 草稿恢复
 *   - 单测的 round-trip 断言
 *
 * 规范约束：
 *   - §42 仅模型层，不接 UI / 导出
 *   - 反序列化必须**校验后补默认值**，不允许把外部 JSON 直接当文档用
 *     （否则 EditorDocument 会退化成"另一个不可信真相"，违背 §6）
 */

import {
  DEFAULT_COLOR,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_STYLE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT_RATIO,
} from "./factory";
import type {
  EditorDocument,
  EditorObject,
  EditorPage,
  FontStyle,
  ImageObject,
  Paragraph,
  ParagraphAlignment,
  TextBoxObject,
  TextRun,
  TextStyle,
  TextSourceBinding,
  TextSourceKind,
} from "./types";

/** 反序列化失败时抛出，便于调用方区分"数据损坏"与"逻辑错误" */
export class EditorDocumentParseError extends Error {
  constructor(message: string) {
    super(`[EditorDocument] ${message}`);
    this.name = "EditorDocumentParseError";
  }
}

// ─────────────────────────────────────────────────────────────────────
//  校验辅助
// ─────────────────────────────────────────────────────────────────────

function fail(path: string, expected: string): never {
  throw new EditorDocumentParseError(`${path} 非法，期望 ${expected}`);
}

function num(path: string, v: unknown, fallback?: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (fallback !== undefined) return fallback;
  return fail(path, "有限 number");
}

function str(path: string, v: unknown, fallback?: string): string {
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  return fail(path, "string");
}

function arr(path: string, v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return fail(path, "array");
}

function obj(path: string, v: unknown): Record<string, unknown> {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return fail(path, "object");
}

/** F3B-6.18-C.1：可选 `[a,b,c,d]` 仿射分量；`undefined` = 无旋转/无倾斜 */
function optionalTransform4(
  path: string,
  v: unknown
): [number, number, number, number] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length !== 4) return fail(path, "[a,b,c,d]（长度 4 的数组）");
  return [
    num(`${path}[0]`, v[0]),
    num(`${path}[1]`, v[1]),
    num(`${path}[2]`, v[2]),
    num(`${path}[3]`, v[3]),
  ];
}

const ALIGNMENTS: ParagraphAlignment[] = ["left", "center", "right", "justify"];
const FONT_STYLES: FontStyle[] = ["normal", "italic"];
const SOURCE_KINDS: TextSourceKind[] = ["pdf-native", "ocr", "user"];

// ─────────────────────────────────────────────────────────────────────
//  反序列化：逐层校验 + 补默认值
// ─────────────────────────────────────────────────────────────────────

function parseTextStyle(path: string, raw: unknown): TextStyle {
  const o = obj(path, raw);
  const fontSize = num(`${path}.fontSize`, o.fontSize, DEFAULT_FONT_SIZE);
  const style: TextStyle = {
    fontFamily: str(`${path}.fontFamily`, o.fontFamily, DEFAULT_FONT_FAMILY),
    fontSize,
    fontWeight: num(`${path}.fontWeight`, o.fontWeight, DEFAULT_FONT_WEIGHT),
    fontStyle: FONT_STYLES.includes(o.fontStyle as FontStyle)
      ? (o.fontStyle as FontStyle)
      : DEFAULT_FONT_STYLE,
    color: str(`${path}.color`, o.color, DEFAULT_COLOR),
    letterSpacing: num(`${path}.letterSpacing`, o.letterSpacing, 0),
    lineHeight: num(`${path}.lineHeight`, o.lineHeight, fontSize * DEFAULT_LINE_HEIGHT_RATIO),
  };
  if (typeof o.sourceFontName === "string") style.sourceFontName = o.sourceFontName;
  return style;
}

function parseTextRun(path: string, raw: unknown): TextRun {
  const o = obj(path, raw);
  const run: TextRun = {
    id: str(`${path}.id`, o.id),
    text: str(`${path}.text`, o.text),
    style: parseTextStyle(`${path}.style`, o.style ?? {}),
  };
  if (o.source !== undefined) run.source = parseSourceBinding(`${path}.source`, o.source);
  return run;
}

function parseParagraph(path: string, raw: unknown): Paragraph {
  const o = obj(path, raw);
  return {
    id: str(`${path}.id`, o.id),
    runs: arr(`${path}.runs`, o.runs).map((r, i) => parseTextRun(`${path}.runs[${i}]`, r)),
    alignment: ALIGNMENTS.includes(o.alignment as ParagraphAlignment)
      ? (o.alignment as ParagraphAlignment)
      : "left",
  };
}

function parseSourceBinding(path: string, raw: unknown): TextSourceBinding {
  const o = obj(path, raw);
  const binding: TextSourceBinding = {
    kind: SOURCE_KINDS.includes(o.kind as TextSourceKind)
      ? (o.kind as TextSourceKind)
      : "user",
  };
  if (typeof o.blockId === "string") binding.blockId = o.blockId;
  if (typeof o.lineId === "string") binding.lineId = o.lineId;
  if (typeof o.lineIdx === "number" && Number.isFinite(o.lineIdx)) binding.lineIdx = o.lineIdx;
  if (typeof o.startGlyphIndex === "number" && Number.isFinite(o.startGlyphIndex)) {
    binding.startGlyphIndex = o.startGlyphIndex;
  }
  if (typeof o.endGlyphIndex === "number" && Number.isFinite(o.endGlyphIndex)) {
    binding.endGlyphIndex = o.endGlyphIndex;
  }
  return binding;
}

function parseObject(path: string, raw: unknown): EditorObject {
  const o = obj(path, raw);
  // 图片对象（F3B-6.24-B3）：无嵌套段落，仅标量几何 + assetRef。
  if (o.type === "image") {
    // width/height 必须有限且 > 0（与 AddBlockCommand / ResizeObjectCommand 几何口径统一，C4-D）
    const width = num(`${path}.width`, o.width);
    const height = num(`${path}.height`, o.height);
    if (width <= 0 || height <= 0) {
      return fail(`${path}.width/height`, "> 0 的 number");
    }
    const img: ImageObject = {
      id: str(`${path}.id`, o.id),
      type: "image",
      x: num(`${path}.x`, o.x),
      y: num(`${path}.y`, o.y),
      width,
      height,
      rotation: num(`${path}.rotation`, o.rotation, 0),
      assetRef: str(`${path}.assetRef`, o.assetRef),
    };
    const transform = optionalTransform4(`${path}.transform`, o.transform);
    if (transform !== undefined) img.transform = transform;
    return img;
  }
  // 文本对象：其余未知类型直接报错，
  // 避免"半个对象"进入 Editor Core 成为新的隐式真相。
  if (o.type !== "text") return fail(`${path}.type`, '"text" 或 "image"');
  const box: TextBoxObject = {
    id: str(`${path}.id`, o.id),
    type: "text",
    x: num(`${path}.x`, o.x),
    y: num(`${path}.y`, o.y),
    width: num(`${path}.width`, o.width),
    height: num(`${path}.height`, o.height),
    rotation: num(`${path}.rotation`, o.rotation, 0),
    paragraphs: arr(`${path}.paragraphs`, o.paragraphs).map((p, i) =>
      parseParagraph(`${path}.paragraphs[${i}]`, p)
    ),
  };
  const transform = optionalTransform4(`${path}.transform`, o.transform);
  if (transform !== undefined) box.transform = transform;
  if (o.source !== undefined) box.source = parseSourceBinding(`${path}.source`, o.source);
  return box;
}

function parsePage(path: string, raw: unknown): EditorPage {
  const o = obj(path, raw);
  return {
    id: str(`${path}.id`, o.id),
    index: num(`${path}.index`, o.index),
    width: num(`${path}.width`, o.width),
    height: num(`${path}.height`, o.height),
    objects: arr(`${path}.objects`, o.objects).map((b, i) => parseObject(`${path}.objects[${i}]`, b)),
  };
}

/**
 * 反序列化。接受 JSON 字符串或已解析对象。
 * @throws {EditorDocumentParseError} 结构非法
 */
export function deserializeEditorDocument(input: string | unknown): EditorDocument {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new EditorDocumentParseError("JSON 解析失败");
    }
  }
  const o = obj("root", raw);
  return {
    id: str("root.id", o.id),
    pages: arr("root.pages", o.pages).map((p, i) => parsePage(`root.pages[${i}]`, p)),
    version: num("root.version", o.version, 1),
  };
}

/**
 * 宽松校验：只判断能否反序列化，不抛异常。
 * 用于 UI 层（如恢复草稿）先探测再决定是否降级。
 */
export function isValidEditorDocument(input: string | unknown): boolean {
  try {
    deserializeEditorDocument(input);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  序列化
// ─────────────────────────────────────────────────────────────────────

export function serializeEditorDocument(doc: EditorDocument, pretty = false): string {
  return pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
}

/**
 * 调试摘要（规范 §67：每层都要可 inspect）。
 * 不打印全文，只给结构规模，便于在 console / FidelityDebugPanel 里快速核对。
 */
export function summarizeEditorDocument(doc: EditorDocument): {
  id: string;
  version: number;
  pages: number;
  textBoxes: number;
  paragraphs: number;
  runs: number;
  characters: number;
} {
  let textBoxes = 0;
  let paragraphs = 0;
  let runs = 0;
  let characters = 0;
  for (const page of doc.pages) {
    for (const box of page.objects) {
      // F3B-6.24-B3：图片对象无段落/文本统计，仅计入 textBoxes 数量
      if (box.type !== "text") {
        textBoxes += 1;
        continue;
      }
      textBoxes += 1;
      for (const para of box.paragraphs) {
        paragraphs += 1;
        for (const run of para.runs) {
          runs += 1;
          characters += run.text.length;
        }
      }
    }
  }
  return {
    id: doc.id,
    version: doc.version,
    pages: doc.pages.length,
    textBoxes,
    paragraphs,
    runs,
    characters,
  };
}
