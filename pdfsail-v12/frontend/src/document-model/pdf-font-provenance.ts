/**
 * M7.8-035-B · PDF Font Provenance
 *
 * 建立 **可靠** 的
 *     pdf.js loadedName (g_d0_fN)  →  PDF resource name (/F5 ../F12)
 * 映射。**禁止** g_d0_fN → FN 的编号猜测。
 *
 * 判据（M7.8-035-B Step 4 实测证明，6/6 唯一）：
 *   主判据：Type3 /FontBBox 四维精确相等
 *   辅判据：CharProcs 数量（= pdf.js charProcOperatorList 键数）
 *   兜底  ：FontDescriptor./FontName
 *
 * 背景：
 *   · 许多 PDF 把 /Font 放在 Form XObject 的 /Resources 里，page 级 /Font 为空；
 *   · 同一 FontDescriptor 常被多个 Type3 字体共享（如 /F8 /F9 /F10 共用 obj#119），
 *     因此**仅凭 FontName 无法消歧**，必须用 FontBBox。
 *
 * 注意 /FontBBox 的顺序差异：
 *   pdf-lib 读出为 [llx, ury, urx, lly]，pdf.js 侧 bbox 为 [llx, lly, urx, ury]。
 *   统一 normalize 成 minX/minY/maxX/maxY 后比较，规避顺序歧义。
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRef,
  PDFArray,
  PDFNumber,
  PDFStream,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { GlyphFontIdentity } from "./types";

/** 一个 PDF 字体资源的 provenance 快照 */
export interface PdfFontResource {
  /** PDF resource name，带前导斜杠，如 "/F5" */
  resourceName: string;
  /** 字体字典的对象号（调试/诊断用） */
  objectNumber: number;
  /** 字体字典的 PDFRef（导出时用于提升到 page /Resources） */
  ref: PDFRef;
  subtype: string;
  /** FontDescriptor./FontName（可能带子集前缀，如 BAAAAA+ProximaNova-Regular） */
  fontName?: string;
  /** 归一化后的 [minX, minY, maxX, maxY] */
  bbox?: number[];
  /** Type3: /CharProcs 条目数 */
  charProcCount?: number;
  /** Type0/Type3: /ToUnicode 是否存在 */
  hasToUnicode: boolean;
  embedded: boolean;
  encoding?: string;
  /** Type3: 从 /ToUnicode 反查得到的 unicode(字符) → charCode(整数) 表 */
  unicodeToCharCode?: Map<string, number>;
}

/** loadedName → provenance */
export interface FontProvenanceEntry {
  resourceName: string;
  objectNumber: number;
  ref: PDFRef;
  fontName: string;
  baseFont: string;
  subtype: string;
  embedded: boolean;
  encoding?: string;
  /** Type3: unicode → charCode 反查表（用于把 unicode 文本还原为原内容流 charCode） */
  unicodeToCharCode?: Map<string, number>;
  /** M7.8-035-FIX：字体资源身份（来自原 PDF object graph，非 fontIdentity===undefined 猜测）。
   *  直接供 EditableGlyph.fontIdentity / GlyphMetrics.fontIdentity 消费，驱动 Export native replay。 */
  fontIdentity: GlyphFontIdentity;
  /** 是否 Type3（便于 Export 走 raw-CID 路径，禁用 Helvetica fallback） */
  isType3: boolean;
  /** 与 unicodeToCharCode 同义（adapter 兼容别名：provEntry.pdfCharCode.get(str) → raw code） */
  pdfCharCode: Map<string, number>;
  /** 匹配依据（诊断用，便于确认不是编号猜测） */
  matchedBy: "fontBBox" | "charProcCount" | "fontName" | "single";
}

const isDict = (o: unknown): o is PDFDict => o instanceof PDFDict;
const nameOf = (d: any, k: string): string | undefined => {
  try { const v = d?.get?.(PDFName.of(k)); return v ? String(v) : undefined; } catch { return undefined; }
};

function lookup(doc: PDFDocument, r: unknown): unknown {
  try { return doc.context.lookup(r as any); } catch { return undefined; }
}

/** 归一化 bbox → [minX, minY, maxX, maxY]，规避 PDF 与 pdf.js 的坐标顺序差异 */
function normalizeBBox(arr: unknown): number[] | undefined {
  if (!arr) return undefined;
  const nums: number[] = [];
  try {
    const a = arr instanceof PDFArray ? arr : (arr as any);
    const n = a?.size?.() ?? (Array.isArray(arr) ? arr.length : 0);
    for (let i = 0; i < n && i < 4; i++) {
      const v = a.get ? a.get(i) : (arr as any)[i];
      const num = typeof v === "number" ? v : (v as any)?.asNumber?.();
      if (typeof num === "number" && Number.isFinite(num)) nums.push(num);
    }
  } catch { return undefined; }
  if (nums.length < 4) return undefined;
  const minX = Math.min(nums[0], nums[2]);
  const maxX = Math.max(nums[0], nums[2]);
  const minY = Math.min(nums[1], nums[3]);
  const maxY = Math.max(nums[1], nums[3]);
  return [minX, minY, maxX, maxY];
}

function bboxEquals(a?: number[], b?: number[], tol = 0.5): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

/** 常见 glyph name → Unicode。用于 Type3 字体没有 /ToUnicode 时从 /Encoding 反查。 */
const GLYPH_NAME_TO_UNICODE: Record<string, string> = {
  space: " ",
  comma: ",",
  period: ".",
  hyphen: "-",
  underscore: "_",
  slash: "/",
  backslash: "\\",
  colon: ":",
  semicolon: ";",
  exclam: "!",
  question: "?",
  ampersand: "&",
  parenleft: "(",
  parenright: ")",
  bracketleft: "[",
  bracketright: "]",
  braceleft: "{",
  braceright: "}",
  numbersign: "#",
  dollar: "$",
  percent: "%",
  at: "@",
  asterisk: "*",
  plus: "+",
  equal: "=",
  less: "<",
  greater: ">",
  bar: "|",
  quotedbl: '"',
  quotesingle: "'",
  quoteleft: "\u2018",
  quoteright: "\u2019",
  quotedblleft: "\u201C",
  quotedblright: "\u201D",
  bullet: "\u2022",
  middot: "\u00B7",
  endash: "\u2013",
  emdash: "\u2014",
  hyphenminus: "-",
  // 西班牙语/葡萄牙语/法语常见重音
  aacute: "\u00E1",
  agrave: "\u00E0",
  acircumflex: "\u00E2",
  atilde: "\u00E3",
  adieresis: "\u00E4",
  aring: "\u00E5",
  aelig: "\u00E6",
  ccedilla: "\u00E7",
  eacute: "\u00E9",
  egrave: "\u00E8",
  ecircumflex: "\u00EA",
  edieresis: "\u00EB",
  iacute: "\u00ED",
  igrave: "\u00EC",
  icircumflex: "\u00EE",
  idieresis: "\u00EF",
  ntilde: "\u00F1",
  oacute: "\u00F3",
  ograve: "\u00F2",
  ocircumflex: "\u00F4",
  otilde: "\u00F5",
  odieresis: "\u00F6",
  oslash: "\u00F8",
  uacute: "\u00FA",
  ugrave: "\u00F9",
  ucircumflex: "\u00FB",
  udieresis: "\u00FC",
  yacute: "\u00FD",
  ydieresis: "\u00FF",
  Aacute: "\u00C1",
  Agrave: "\u00C0",
  Acircumflex: "\u00C2",
  Atilde: "\u00C3",
  Adieresis: "\u00C4",
  Aring: "\u00C5",
  AE: "\u00C6",
  Ccedilla: "\u00C7",
  Eacute: "\u00C9",
  Egrave: "\u00C8",
  Ecircumflex: "\u00CA",
  Edieresis: "\u00CB",
  Iacute: "\u00CD",
  Igrave: "\u00CC",
  Icircumflex: "\u00CE",
  Idieresis: "\u00CF",
  Ntilde: "\u00D1",
  Oacute: "\u00D3",
  Ograve: "\u00D2",
  Ocircumflex: "\u00D4",
  Otilde: "\u00D5",
  Odieresis: "\u00D6",
  Oslash: "\u00D8",
  Uacute: "\u00DA",
  Ugrave: "\u00D9",
  Ucircumflex: "\u00DB",
  Udieresis: "\u00DC",
  Yacute: "\u00DD",
  Ydieresis: "\u0178",
  // 货币/其它
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  copyright: "\u00A9",
  registered: "\u00AE",
  trademark: "\u2122",
};

function glyphNameToUnicode(name: string): string | undefined {
  if (!name) return undefined;
  // 单字符名（如 a, A, 1）
  if (name.length === 1) return name;
  // uniXXXX / uXXXX
  const mUni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (mUni) {
    const cp = parseInt(mUni[1], 16);
    if (cp > 0) return String.fromCodePoint(cp);
  }
  const mU = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (mU) {
    const cp = parseInt(mU[1], 16);
    if (cp > 0) return String.fromCodePoint(cp);
  }
  return GLYPH_NAME_TO_UNICODE[name];
}

/** 从 Type3 /Encoding（尤其是 /Differences）构建 unicode → charCode 反查表。
 *  当字体没有 /ToUnicode 时，这是唯一能正确把 replacement unicode 还原成原 charCode 的办法。 */
function buildUnicodeToCharCodeFromEncoding(
  doc: PDFDocument,
  fontDict: PDFDict,
): Map<string, number> | undefined {
  const encRef = fontDict.get(PDFName.of("Encoding"));
  const encLike = lookup(doc, encRef);
  if (!encLike) return undefined;

  // 预定义编码（极少用于 Type3，但防御性处理）
  if (typeof encLike === "string" || encLike instanceof PDFName) {
    const encName = String(encLike).replace(/^\//, "");
    const map = PREDEFINED_ENCODING[encName];
    if (!map) return undefined;
    const out = new Map<string, number>();
    for (const [code, ch] of map.entries()) out.set(ch, code);
    return out;
  }
  if (!isDict(encLike)) return undefined;

  const diffRef = encLike.get(PDFName.of("Differences"));
  const diffLike = lookup(doc, diffRef);
  if (!diffLike || !(diffLike as any).size) return undefined;
  const diff = diffLike as PDFArray;
  const out = new Map<string, number>();
  let code = 0;
  const n = diff.size();
  for (let i = 0; i < n; i++) {
    const item = diff.get(i);
    if (item instanceof PDFNumber) {
      code = item.asNumber();
    } else if (item instanceof PDFName) {
      const name = String(item).replace(/^\//, "");
      const ch = glyphNameToUnicode(name);
      if (ch !== undefined) out.set(ch, code);
      code++;
    }
  }
  return out.size > 0 ? out : undefined;
}

/** 常见预定义编码的 code → char 表（只列 WinAnsi / MacRoman / Standard） */
const PREDEFINED_ENCODING: Record<string, Map<number, string>> = {
  WinAnsiEncoding: buildAsciiEncodingMap([
    // 0x20-0x7E 与 ASCII 一致，0x80-0xFF 有一些符号
    "\u0020\u0021\u0022\u0023\u0024\u0025\u0026\u0027\u0028\u0029\u002A\u002B\u002C\u002D\u002E\u002F",
    "0123456789:;<=>?",
    "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_",
    "`abcdefghijklmnopqrstuvwxyz{|}~\u007F",
    "\u20AC\u0020\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u0020\u017D\u0020",
    "\u0020\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u0020\u017E\u0178",
    "\u00A0\u00A1\u00A2\u00A3\u00A4\u00A5\u00A6\u00A7\u00A8\u00A9\u00AA\u00AB\u00AC\u002D\u00AE\u00AF",
    "\u00B0\u00B1\u00B2\u00B3\u00B4\u00B5\u00B6\u00B7\u00B8\u00B9\u00BA\u00BB\u00BC\u00BD\u00BE\u00BF",
    "\u00C0\u00C1\u00C2\u00C3\u00C4\u00C5\u00C6\u00C7\u00C8\u00C9\u00CA\u00CB\u00CC\u00CD\u00CE\u00CF",
    "\u00D0\u00D1\u00D2\u00D3\u00D4\u00D5\u00D6\u00D7\u00D8\u00D9\u00DA\u00DB\u00DC\u00DD\u00DE\u00DF",
    "\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E6\u00E7\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED\u00EE\u00EF",
    "\u00F0\u00F1\u00F2\u00F3\u00F4\u00F5\u00F6\u00F7\u00F8\u00F9\u00FA\u00FB\u00FC\u00FD\u00FE\u00FF",
  ]),
  MacRomanEncoding: buildAsciiEncodingMap([
    "\u0020\u0021\u0022\u0023\u0024\u0025\u0026\u0027\u0028\u0029\u002A\u002B\u002C\u002D\u002E\u002F",
    "0123456789:;<=>?",
    "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_",
    "`abcdefghijklmnopqrstuvwxyz{|}~\u007F",
    "\u00C4\u00C5\u00C7\u00C9\u00D1\u00D6\u00DC\u00E1\u00E0\u00E2\u00E4\u00E3\u00E5\u00C7\u00E9\u00E8",
    "\u00EA\u00EB\u00ED\u00EC\u00EE\u00EF\u00F1\u00F3\u00F2\u00F4\u00F6\u00F5\u00FA\u00F9\u00FB\u00FC",
    "\u2020\u00B0\u00A2\u00A3\u00A7\u2022\u00B6\u00DF\u00AE\u00A9\u2122\u00B4\u00A8\u2260\u00C6\u00D8",
    "\u221E\u00B1\u2264\u2265\u00A5\u00B5\u2202\u2211\u220F\u03C0\u222B\u00AA\u00BA\u03A9\u00E6\u00F8",
    "\u00BF\u00A1\u00AC\u221A\u0192\u2248\u2206\u00AB\u00BB\u2026\u00A0\u00C0\u00C3\u00D5\u0152\u0153",
    "\u2013\u2014\u201C\u201D\u2018\u2019\u00F7\u25CA\u00FF\u0178\u2044\u20AC\u2039\u203A\uFB01\uFB02",
    "\u2021\u00B7\u201A\u201E\u2030\u00C2\u00CA\u00C1\u00CB\u00C8\u00CD\u00CE\u00CF\u00CC\u00D3\u00D4",
    "\uF8FF\u00D2\u00DA\u00DB\u00D9\u0131\u02C6\u02DC\u00AF\u02D8\u02D9\u02DA\u00B8\u02DD\u02DB\u02C7",
  ]),
  StandardEncoding: buildAsciiEncodingMap([
    "\u0020\u0021\u0022\u0023\u0024\u0025\u0026\u0027\u0028\u0029\u002A\u002B\u002C\u002D\u002E\u002F",
    "0123456789:;<=>?",
    "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_",
    "`abcdefghijklmnopqrstuvwxyz{|}~\u007F",
    "\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044\u2039\u203A\u2212\u2030\u201E\u201C\u201D\u2018",
    "\u2019\u201A\u2122\uFB01\uFB02\u0141\u0152\u0160\u0178\u017D\u0131\u0142\u0153\u0161\u017E\u017F",
    "\u20AC\u00A1\u00A2\u00A3\u00A4\u00A5\u00A6\u00A7\u00A8\u00A9\u00AA\u00AB\u00AC\u002D\u00AE\u00AF",
    "\u00B0\u00B1\u00B2\u00B3\u00B4\u00B5\u00B6\u00B7\u00B8\u00B9\u00BA\u00BB\u00BC\u00BD\u00BE\u00BF",
    "\u00C0\u00C1\u00C2\u00C3\u00C4\u00C5\u00C6\u00C7\u00C8\u00C9\u00CA\u00CB\u00CC\u00CD\u00CE\u00CF",
    "\u00D0\u00D1\u00D2\u00D3\u00D4\u00D5\u00D6\u00D7\u00D8\u00D9\u00DA\u00DB\u00DC\u00DD\u00DE\u00DF",
    "\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E6\u00E7\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED\u00EE\u00EF",
    "\u00F0\u00F1\u00F2\u00F3\u00F4\u00F5\u00F6\u00F7\u00F8\u00F9\u00FA\u00FB\u00FC\u00FD\u00FE\u00FF",
  ]),
};

function buildAsciiEncodingMap(rows: string[]): Map<number, string> {
  const map = new Map<number, string>();
  let code = 0x20;
  for (const row of rows) {
    for (const ch of row) {
      map.set(code, ch);
      code++;
    }
  }
  return map;
}

/** hex 字节串（2/4/6... hex digit，UTF-16）转 JS 字符串 */
/**
 * 把 CMap 流解码成文本。
 * M7.8-035-FIX：此前只尝试 pako.inflate，未压缩（无 /Filter）的 /ToUnicode 会直接解析失败
 * → unicode→charCode 表为空 → 导出拿不到原始 charCode → 回落 Helvetica。
 * 现按 pdf-lib decodePDFRawStream → 原始字节 两级尝试。
 */
function decodeCmapStream(stream: PDFStream | PDFRawStream): string | undefined {
  let contents: Uint8Array;
  try {
    contents =
      typeof (stream as any).asUint8Array === "function"
        ? (stream as any).asUint8Array()
        : stream.getContents();
  } catch {
    return undefined;
  }
  try {
    // pdf-lib 的 decodePDFRawStream 运行时可接受 {dict, contents}，但当前版本 .d.ts
    // 只声明了 PDFRawStream 入参；用 as any 绕过，与同仓库其他文件一致。
    const decoded = decodePDFRawStream({ dict: stream.dict, contents } as any);
    return new TextDecoder().decode((decoded as any).getBytes());
  } catch {
    /* 无 Filter / 无法解压 → 用原始字节 */
  }
  try {
    return new TextDecoder().decode(contents);
  } catch {
    return undefined;
  }
}

function hexToStr(hex: string): string {
  let s = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    s += String.fromCodePoint(parseInt(hex.substring(i, i + 4), 16));
  }
  return s;
}

/**
 * 解析 Type3 字体的 /ToUnicode CMap，构建 unicode(字符) → charCode(整数) 的反查表。
 * 这是把 pdf.js 给出的 unicode 文本还原为原 PDF 内容流的 charCode 的唯一可靠途径
 * （Type3 字形的 CharProcs 由 charCode 索引，不能用 unicode 文本直接 Tj）。
 *
 * 处理 beginbfchar / beginbfrange 两种条目；解析失败返回 undefined（不硬编码）。
 */
function parseToUnicode(doc: PDFDocument, ref: unknown): Map<string, number> | undefined {
  try {
    const stream: any = lookup(doc, ref);
    if (!(stream instanceof PDFRawStream) && !(stream instanceof PDFStream)) return undefined;

    const text = decodeCmapStream(stream as PDFStream | PDFRawStream);
    if (!text) return undefined;
    const map = new Map<string, number>();

    const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
    let bc: RegExpExecArray | null;
    while ((bc = bfchar.exec(text))) {
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(bc[1]))) {
        map.set(hexToStr(m[2]), parseInt(m[1], 16));
      }
    }

    const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
    let br: RegExpExecArray | null;
    while ((br = bfrange.exec(text))) {
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(br[1]))) {
        const startCode = parseInt(m[1], 16);
        const endCode = parseInt(m[2], 16);
        const startUni = parseInt(m[3], 16);
        for (let c = startCode, u = startUni; c <= endCode; c++, u++) {
          map.set(String.fromCodePoint(u), c);
        }
      }
    }
    return map.size ? map : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 递归收集页面及其 Form XObject 下的全部 /Font 资源。
 *
 * 关键：许多 PDF（含本次的 agmetnfsk.pdf）把 /Font 放在 Form 的 /Resources，
 * page 级 /Font 根本不存在 —— 只看 page 会漏掉全部字体。
 */
export function collectFontResources(
  doc: PDFDocument,
  pageIndex: number,
): Map<string, PdfFontResource> {
  // M7.8-035-FIX：Export 每行都调用一次（elevate + charCode 查表），
  // 而解析需要递归 Form XObject 并解压每份 /ToUnicode —— 按 (context, pageIndex) 缓存，
  // 避免 O(行数 × 字体数) 的重复 inflate。
  const ctxKey = doc.context as unknown as object;
  let perDoc = FONT_RESOURCE_CACHE.get(ctxKey);
  if (!perDoc) {
    perDoc = new Map();
    FONT_RESOURCE_CACHE.set(ctxKey, perDoc);
  }
  const hit = perDoc.get(pageIndex);
  if (hit) return hit;

  const out = computeFontResources(doc, pageIndex);
  perDoc.set(pageIndex, out);
  return out;
}

/** 页面字体资源缓存（doc.context → pageIndex → resource 表） */
const FONT_RESOURCE_CACHE = new WeakMap<object, Map<number, Map<string, PdfFontResource>>>();

function computeFontResources(
  doc: PDFDocument,
  pageIndex: number,
): Map<string, PdfFontResource> {
  const out = new Map<string, PdfFontResource>();
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) return out;
  const page = doc.getPage(pageIndex);

  const visit = (resLike: unknown, depth: number) => {
    if (depth > 6) return;
    const rd = isDict(resLike) ? resLike : lookup(doc, resLike);
    if (!isDict(rd)) return;

    // /Font
    const fo = rd.lookup(PDFName.of("Font"));
    const fod = isDict(fo) ? fo : lookup(doc, fo);
    if (isDict(fod)) {
      for (const [k, v] of fod.entries()) {
        const dict = lookup(doc, v);
        if (!isDict(dict)) continue;
        const descRef = dict.get(PDFName.of("FontDescriptor"));
        const desc = lookup(doc, descRef);
        let fontName: string | undefined;
        if (isDict(desc)) {
          const fn = nameOf(desc, "FontName");
          if (fn) fontName = fn.replace(/^\//, "");
        }
        const cp = dict.get(PDFName.of("CharProcs"));
        const cpd = isDict(cp) ? cp : lookup(doc, cp);
        const charProcCount = isDict(cpd) ? cpd.keys().length : undefined;
        const resourceName = String(k);
        const tu = dict.get(PDFName.of("ToUnicode"));
        const subtype = (nameOf(dict, "Subtype") ?? "").replace(/^\//, "");
        let unicodeToCharCode = tu ? parseToUnicode(doc, tu) : undefined;
        // M7.8-035R: Type3 字体常没有 /ToUnicode，但 /Encoding/Differences 里直接保存了
        // glyph name → charCode 映射。据此反查 unicode → charCode，否则重绘时只能回退。
        // 注意：嵌入 TrueType/Type1 子集字体即使声明 /MacRomanEncoding 等预定义编码，其真实
        // 码位也常被子集重映射，标准编码表反查会得到错误码位 → 导出乱码。此类字体的正确映射
        // 来自原始 glyph 自身的 pdfCharCode（在渲染层 tryNativeLineReplay 中对「文本未变的编辑
        // 字符」直接复用 pdfCharCode，对新增字符走同族子集 findFontForChar）。故这里仅对 Type3 重建。
        if (!unicodeToCharCode && subtype === "Type3") {
          unicodeToCharCode = buildUnicodeToCharCodeFromEncoding(doc, dict);
        }
        if (!out.has(resourceName)) {
          out.set(resourceName, {
            resourceName,
            objectNumber: v instanceof PDFRef ? v.objectNumber : -1,
            ref: v as PDFRef,
            subtype: (nameOf(dict, "Subtype") ?? "").replace(/^\//, ""),
            fontName,
            bbox: normalizeBBox(dict.get(PDFName.of("FontBBox"))),
            charProcCount,
            hasToUnicode: !!tu,
            embedded: isDict(desc)
              ? ["FontFile", "FontFile2", "FontFile3"].some((kk) => !!desc.get(PDFName.of(kk)))
              : false,
            encoding: nameOf(dict, "Encoding"),
            unicodeToCharCode,
          });
        }
      }
    }

    // /XObject → 递归 Form
    const xo = rd.lookup(PDFName.of("XObject"));
    const xod = isDict(xo) ? xo : lookup(doc, xo);
    if (isDict(xod)) {
      for (const [, v] of xod.entries()) {
        const form = lookup(doc, v);
        const d: any = isDict(form) ? form : (form as PDFStream | PDFRawStream)?.dict;
        if (d && nameOf(d, "Subtype") === "/Form") {
          visit(d.get(PDFName.of("Resources")), depth + 1);
        }
      }
    }
  };

  visit(page.node.Resources(), 0);
  return out;
}

/**
 * M7.8-035-FIX：在本页（含 Form XObject）所有字体资源里，找能编码 `ch` 的字体。
 *
 * 用途：用户新输入的字符可能不在该 glyph 原字体的 /ToUnicode 子集里
 * （Type3 子集字体只含原文用到的字形）。此时**绝不能回落 Helvetica**，
 * 而应在同页其它同族字体中找同名字形，仍然走原生 Tf/Tj。
 *
 * 优先级：同 subtype 且同 baseFont > 同 subtype > 任意。
 */
export function findFontForChar(
  doc: PDFDocument,
  pageIndex: number,
  ch: string,
  prefer?: { subtype?: string; baseFont?: string },
): { resourceName: string; charCode: number } | undefined {
  const all = [...collectFontResources(doc, pageIndex).values()];
  const stripSubset = (n?: string) => (n ?? "").replace(/^[A-Z]{6}\+/, "");
  const score = (r: PdfFontResource): number => {
    let s = 0;
    if (prefer?.subtype && r.subtype === prefer.subtype) s += 2;
    if (prefer?.baseFont && stripSubset(r.fontName) === stripSubset(prefer.baseFont)) s += 1;
    return s;
  };
  const candidates: { r: PdfFontResource; code: number; s: number }[] = [];
  for (const r of all) {
    const code = r.unicodeToCharCode?.get(ch);
    if (code === undefined) continue;
    candidates.push({ r, code, s: score(r) });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.s - a.s);
  return {
    resourceName: candidates[0].r.resourceName,
    charCode: candidates[0].code,
  };
}

/** 从 pdf.js 侧取字体特征（loadedName → 特征） */
interface JsFontFeature {
  loadedName: string;
  name?: string;
  bbox?: number[];
  charProcCount?: number;
}

function collectJsFontFeatures(pdfjsDoc: unknown): Map<string, JsFontFeature> {
  const out = new Map<string, JsFontFeature>();
  const transport: any = (pdfjsDoc as any)?._transport;
  const co = transport?.commonObjs;
  if (!co || typeof co.get !== "function") return out;

  // pdf.js 的 loadedName 形如 g_d0_fN；无法枚举 commonObjs，按惯例探测
  // （这是 key 的**枚举**方式，不是映射判据 —— 映射仍由 bbox/charProcCount 决定）
  for (let pageIdx = 0; pageIdx < 4096; pageIdx++) {
    let found = false;
    for (let f = 1; f <= 512; f++) {
      const ln = `g_d${pageIdx}_f${f}`;
      let rec: any = null;
      try { rec = co.get(ln); } catch { rec = null; }
      if (!rec) continue;
      found = true;
      let charProcCount: number | undefined;
      try {
        const cpol = rec.charProcOperatorList;
        if (cpol && typeof cpol === "object") charProcCount = Object.keys(cpol).length;
      } catch { /* ignore */ }
      out.set(ln, {
        loadedName: ln,
        name: rec.name ? String(rec.name).replace(/^\//, "") : undefined,
        bbox: Array.isArray(rec.bbox) ? rec.bbox.slice(0, 4).map(Number) : undefined,
        charProcCount,
      });
    }
    if (!found && pageIdx > 2) break;
  }
  return out;
}

/**
 * M7.8-035-FIX：pdf.js 的字体对象（loadedName → bbox / charProcOperatorList）
 * 只有在该页 **operator list 被构建之后** 才会进入 `_transport.commonObjs`。
 *
 * 这是「同一份代码在 pdf-importer 里能建出映射、在 PDFEditor 里却是空」的根因：
 * pdf-importer 在构建前调了 `page.getOperatorList()`，而浏览器加载路径只调了
 * `page.getTextContent()` → commonObjs 里还没有字体 → provenance 条目 = 0
 * → glyph.fontIdentity 全空 → Export 回落 page.drawText → Helvetica。
 *
 * 这里显式确保 operator list 已构建，消除调用时序依赖。
 */
async function ensureJsFontsLoaded(pdfjsDoc: unknown, pageIndex: number): Promise<void> {
  const co = (pdfjsDoc as any)?._transport?.commonObjs;
  if (co && typeof co.get === "function") {
    try {
      if (co.get(`g_d${pageIndex}_f1`)) return; // 已就绪
    } catch {
      /* 未就绪，继续触发构建 */
    }
  }
  try {
    const page: any = await (pdfjsDoc as any)?.getPage?.(pageIndex + 1);
    await page?.getOperatorList?.();
  } catch {
    /* 失败不阻断：后续映射为空，调用方按「无溯源」处理 */
  }
}

/**
 * 建立 loadedName → PDF resource 的 provenance 映射。
 *
 * 匹配优先级：
 *   1. FontBBox 四维精确相等（唯一命中即可）
 *   2. CharProcs 数量 + FontName 组合唯一命中
 *   3. 全页仅一个字体 → 直接采用
 *   4. FontName 唯一命中（弱，仅在前述都失败时用）
 */
export async function buildFontProvenanceMap(
  pdfLibDoc: PDFDocument,
  pdfjsDoc: unknown,
  pageIndex: number,
): Promise<Map<string, FontProvenanceEntry>> {
  const out = new Map<string, FontProvenanceEntry>();
  const resources = collectFontResources(pdfLibDoc, pageIndex);
  if (resources.size === 0) return out;

  await ensureJsFontsLoaded(pdfjsDoc, pageIndex);

  const jsFonts = collectJsFontFeatures(pdfjsDoc);
  const all = [...resources.values()];
  const stripSubset = (n?: string) => (n ?? "").replace(/^[A-Z]{6}\+/, "");

  for (const [ln, feat] of jsFonts) {
    const mk = (r: PdfFontResource, matchedBy: FontProvenanceEntry["matchedBy"]): FontProvenanceEntry => {
      // M7.8-035-FIX：PdfFontResource.resourceName 已带前导 "/"（PDFName.asString()），
      // 此前再拼一次得到 "//F5" → 资源查找全线失配。统一规范为 "/F5"。
      const fontRef = r.resourceName.startsWith("/")
        ? r.resourceName
        : `/${r.resourceName}`;
      const fontName = r.fontName ?? feat.name ?? "";
      const baseFont = stripSubset(fontName);
      // unicode→charCode 反查表：统一成 Map（collectFontResources 某些分支返回普通对象）
      const u2cRaw = r.unicodeToCharCode as unknown;
      const u2c: Map<string, number> =
        u2cRaw instanceof Map ? u2cRaw : new Map(Object.entries((u2cRaw as Record<string, number>) ?? {}));
      const fontIdentity: GlyphFontIdentity = {
        fontRef,
        fontName,
        baseFont,
        subtype: r.subtype,
        embedded: r.embedded,
        encoding: r.encoding,
        objectNumber: r.objectNumber,
        unicodeToCharCode: u2c,
      };
      return {
        resourceName: r.resourceName,
        objectNumber: r.objectNumber,
        ref: r.ref,
        fontName,
        baseFont,
        subtype: r.subtype,
        embedded: r.embedded,
        encoding: r.encoding,
        unicodeToCharCode: u2c,
        fontIdentity,
        isType3: r.subtype === "Type3",
        pdfCharCode: u2c,
        matchedBy,
      };
    };

    // 1) FontBBox 精确相等
    if (feat.bbox) {
      const hits = all.filter((r) => bboxEquals(r.bbox, feat.bbox));
      if (hits.length === 1) { out.set(ln, mk(hits[0], "fontBBox")); continue; }
    }

    // 2) CharProcs 数量 + FontName 组合
    if (feat.charProcCount !== undefined) {
      const byCp = all.filter((r) => r.charProcCount === feat.charProcCount);
      const byCpAndName = byCp.filter((r) => stripSubset(r.fontName) === stripSubset(feat.name));
      if (byCpAndName.length === 1) { out.set(ln, mk(byCpAndName[0], "charProcCount")); continue; }
      if (byCp.length === 1) { out.set(ln, mk(byCp[0], "charProcCount")); continue; }
    }

    // 3) 全页仅一个字体
    if (all.length === 1) { out.set(ln, mk(all[0], "single")); continue; }

    // 4) FontName 弱匹配（唯一时）
    if (feat.name) {
      const byName = all.filter((r) => stripSubset(r.fontName) === stripSubset(feat.name));
      if (byName.length === 1) out.set(ln, mk(byName[0], "fontName"));
    }
  }
  return out;
}
