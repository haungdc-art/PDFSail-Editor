/**
 * export-cid-writer.ts — M7.5-005D · CID Writer
 *
 * 目标：让中文/CJK 编辑后的文字重新成为真正 Type0/CID PDF 文本对象（可选、可搜、可复制），
 *       而不是 PNG 位图或 Helvetica fallback。
 *
 * 覆盖（005D 允许层）：
 *   1. CID 字符编码：char → UTF-16BE hex（Identity-H 下字符码 = Unicode 码位）
 *        "中文" → <4e2d6587>
 *   2. Type0 字体资源结构：/Subtype /Type0 + /Encoding /Identity-H + /DescendantFonts[CIDFontType2]
 *   3. ToUnicode CMap：字母（字符码 → Unicode）→ 搜索/复制可用
 *   4. CJK glyph 运算子：`BT /F1 1 Tf <tm> Tm <hex> Tj ET`（复用 005C Matrix Writer 的 Tm 保真）
 *
 * 不做（留给 005E Content Rewrite）：
 *   - 删除旧 text object / overlay mask
 *   - content stream rewrite（交换旧对象）
 *   - undo / mutation
 *
 * 编码约定：
 *   - BMP 字符：2 字节 = char 的 UTF-16BE 码元
 *   - 非 BMP（代理对）：4 字节 = UTF-16BE 代理对
 *   - CIDFontType2 + Identity-H + CIDToGIDMap（Identity）是主流通用结构
 */
import { buildNativeTextMatrix, composeNativeTextRun, type GlyphPlacement } from "./export-matrix-writer";

/** 单次 CID Text Run 结果 */
export interface CidRunResult {
  /** 裸 hex（不含 <>），如 "4e2d6587" */
  hex: string;
  /** PDF hex 字符串（含 <>），如 "<4e2d6587>" */
  hexString: string;
  /** 完整 Content Stream 片段：BT /F1 1 Tf <tm> Tm <hex> Tj ET */
  operators: string;
  /** 去重后的字符（供 ToUnicode/宽度表） */
  distinctChars: string[];
}

/** Type0 字体资源结构（供审计 / 序列化 / 后续引用嵌入字体） */
export interface Type0Resource {
  resourceName: string;
  baseFont: string;
  subtype: "Type0";
  encoding: "Identity-H";
  descendantFont: {
    subtype: "CIDFontType2";
    cidToGidMap: "Identity";
    /** 每 CID → advance（1/1000 em；可选） */
    widths: Map<number, number>;
    defaultWidth: number;
  };
  toUnicode: string;
}

/**
 * char（单个 JS 码点）→ UTF-16BE hex（大字集 BMP 双字节；非 BMP 代理对四字节）。
 */
export function charCodeToUtf16Hex(codePoint: number): string {
  if (codePoint >= 0x10000) {
    let p = codePoint - 0x10000;
    const hi = 0xd800 + (p >> 10);
    const lo = 0xdc00 + (p & 0x3ff);
    return hi.toString(16).padStart(4, "0") + lo.toString(16).padStart(4, "0");
  }
  return codePoint.toString(16).padStart(4, "0");
}

/**
 * 把一段文本编码为 CID hex（UTF-16BE）。
 */
export function encodeTextAsCidHex(text: string): string {
  let out = "";
  for (const ch of text) {
    out += charCodeToUtf16Hex(ch.codePointAt(0)!);
  }
  return out;
}

/**
 * 组装 CID Text Run（复用 005C 的 Tm 保真）。
 * 与 ASCII 的 `(text) Tj` 不同，CID 用 `<hex> Tj` → 每个双字节是一个字符码（Identity-H）。
 */
export function composeCidTextRun(
  placement: GlyphPlacement,
  text: string,
  fontRef: string,
): CidRunResult {
  const hex = encodeTextAsCidHex(text);
  const hexString = `<${hex}>`;
  const textMatrix = buildNativeTextMatrix(placement);
  const [a, b, c, d, e, f] = textMatrix;
  const num = (n: number) => {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  };
  const operators =
    `BT /${fontRef} 1 Tf ${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} Tm ${hexString} Tj ET`;
  const distinctChars = [...new Set(Array.from(text))];
  return { hex, hexString, operators, distinctChars };
}

/**
 * 生成 ToUnicode CMap 内容（字符码 → Unicode）。
 * charCodes：Array [hexCharCode, unicodeHex]（如 ["4E2D","4E2D"]）。
 * Identity-H 下字符码 = Unicode 码元，故通常两者相等；也支持显式不一致（antialias 校对）。
 */
export function buildToUnicodeCMap(pairs: Array<[string, string]>): string {
  const dedup = new Map<string, string>();
  for (const [code, uni] of pairs) dedup.set(code.toUpperCase(), uni);
  const entries = [...dedup.entries()];
  const body = entries.map(([code, uni]) => `<${code}> <${uni}>`).join("\n");
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${entries.length} beginbfchar`,
    body,
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

/**
 * 构造 Type0 字体资源结构（描述结构；嵌入实际字形在消费层按 005B ResolvedFont 装配）。
 */
export function buildType0Resource(opts: {
  resourceName: string;
  baseFont: string;
  charWidths: Map<number, number>;
  defaultWidth?: number;
  toUnicodePairs: Array<[string, string]>;
}): Type0Resource {
  const widths = new Map<number, number>(opts.charWidths);
  const toUnicode = buildToUnicodeCMap(opts.toUnicodePairs);
  return {
    resourceName: opts.resourceName,
    baseFont: opts.baseFont,
    subtype: "Type0",
    encoding: "Identity-H",
    descendantFont: {
      subtype: "CIDFontType2",
      cidToGidMap: "Identity",
      widths,
      defaultWidth: opts.defaultWidth ?? 1000,
    },
    toUnicode,
  };
}

/** 从一段文本直接得到 Type0 资源结构 + CID Run（把字符全部转为 Identity 映射对） */
export function buildCidTextBlock(
  placement: GlyphPlacement,
  text: string,
  fontRef: string,
  opts: { baseFont?: string; defaultWidth?: number } = {},
): { run: CidRunResult; resource: Type0Resource } {
  const run = composeCidTextRun(placement, text, fontRef);
  const charWidths = new Map<number, number>();
  const pairs: Array<[string, string]> = [];
  for (const ch of run.distinctChars) {
    const cp = ch.codePointAt(0)!;
    charWidths.set(cp, opts.defaultWidth ?? 1000);
    pairs.push([charCodeToUtf16Hex(cp).toUpperCase(), cp.toString(16).padStart(4, "0").toUpperCase()]);
  }
  const resource = buildType0Resource({
    resourceName: fontRef,
    baseFont: opts.baseFont ?? "SubsetCID+Identity",
    charWidths,
    defaultWidth: opts.defaultWidth ?? 1000,
    toUnicodePairs: pairs,
  });
  return { run, resource };
}