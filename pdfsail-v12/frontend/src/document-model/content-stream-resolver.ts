/**
 * content-stream-resolver.ts — M7.5-005E-C2B-1 · Target Resolver
 *
 * 目标：把 OriginalTextBinding（operator 上下文）解析为「真实 PDF 内容对象位置」：
 *   binding → ResolvedTextObject：
 *     - 内容 stream 对象引用（contentStreamRef.objectId，多 stream 页含 streamIndex）
 *     - showText 算子的实际文本 + 在流中的字节区间（operandStart..opEnd）
 *     - 该算子所用字体资源：resourceName（如 "F1"）+ 字体对象 objectRef（如 "12 0 R"）
 *
 * 范围（C2B-1 只读层）：
 *   ✅ 解析页面 content stream(s)，定位文本 showText 算子与字体资源
 *   ❌ 不删除 Tj / 不改 PDF stream / 不写入新文字 / 不写 Export
 *
 * 设计要点：
 *   - 轻量 content stream tokenizer（BT/ET、Tf、Td/TD/Tm、Tj/TJ…），非全量 PDF parser。
 *   - 兼容 literal `(str)` 与 hex `<..>` 形态。
 *   - 前端安全：用 pdf-lib decodePDFRawStream（内置 JS inflate），不依赖 node:zlib。
 *   - 字体资源解析：算子前后最近的 `/Fnn Tf` → 页面 /Font 字典 → 对象引用。
 *   - 歧义安全拒绑：rawText 匹配唯一则 strong；多个候选 → 返回 null（不误删）。
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFStream,
  PDFDict,
  decodePDFRawStream,
} from "pdf-lib";
import type { OriginalTextBinding } from "./types";

/** 内容流 token 类型 */
export type ContentToken =
  | { kind: "name"; value: string; start: number; end: number }
  | { kind: "literal"; value: string; start: number; end: number; bytes: number[] }
  | { kind: "hex"; value: string; start: number; end: number; bytes: number[] }
  | { kind: "array"; value: ContentToken[]; start: number; end: number }
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "op"; value: string; start: number; end: number };

/** 解码结果：literal → latin1；hex → 优先 UTF-16BE（Identity-H/CID），否则 latin1 */
function decodeOperatorBytes(kind: "literal" | "hex", bytes: number[]): string {
  if (kind === "hex") {
    // CID/Identity-H：<...> 每 2 字节一个 16-bit 码，多为非 ASCII → UTF-16BE
    if (bytes.length >= 2 && bytes.length % 2 === 0 && bytes.some((b) => b > 0x7f)) {
      let out = "";
      for (let i = 0; i < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        out += String.fromCharCode(code);
      }
      return out;
    }
  }
  return bytes.map((b) => String.fromCharCode(b & 0xff)).join("");
}

/** 反转义 PDF literal 字符串（含 \n \r \t \b \f \\ ( ) 与 \ddd 八进制）为字节 */
function parseLiteralBytes(raw: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (n in map) {
        out.push(map[n]);
        i++;
      } else if (/[0-7]/.test(n)) {
        let octal = n;
        let j = i + 2;
        while (j < raw.length && j < i + 4 && /[0-7]/.test(raw[j])) {
          octal += raw[j];
          j++;
        }
        out.push(parseInt(octal, 8) & 0xff);
        i = j - 1;
      } else {
        out.push(n.charCodeAt(0));
        i++;
      }
    } else {
      out.push(c.charCodeAt(0) & 0xff);
    }
  }
  return out;
}

/** 解析 hex 字符串字节 */
function parseHexBytes(hex: string): number[] {
  const clean = hex.replace(/\s+/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  if (clean.length % 2 === 1) out.push(parseInt(clean[clean.length - 1], 16) << 4);
  return out;
}

/**
 * 轻量 content stream tokenizer。
 * 识别：name / literal / hex / array / number / operator 关键字。
 * % 注释、空白被跳过。
 */
export function tokenizeContentStream(text: string): ContentToken[] {
  const tokens: ContentToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "%") {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (c === "/") {
      const start = i;
      i++;
      let value = "";
      while (i < n && !/[\s(<>)/\[\]]/.test(text[i])) {
        if (text[i] === "#" && /[0-9A-Fa-f]{2}/.test(text.slice(i + 1, i + 3))) {
          value += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
          i += 3;
        } else {
          value += text[i];
          i++;
        }
      }
      tokens.push({ kind: "name", value, start, end: i });
      continue;
    }
    if (c === "(") {
      const start = i;
      i++;
      let raw = "";
      let depth = 1;
      // literal：处理转义与嵌套括号
      while (i < n && depth > 0) {
        const ch = text[i];
        if (ch === "\\") {
          raw += ch;
          if (i + 1 < n) { raw += text[i + 1]; i += 2; }
          else { i++; }
        } else if (ch === "(") {
          depth++;
          raw += ch;
          i++;
        } else if (ch === ")") {
          depth--;
          if (depth > 0) raw += ch;
          i++;
        } else {
          raw += ch;
          i++;
        }
      }
      const bytes = parseLiteralBytes(raw);
      tokens.push({ kind: "literal", value: decodeOperatorBytes("literal", bytes), start, end: i, bytes });
      continue;
    }
    if (c === "<") {
      const start = i;
      i++;
      // 若紧跟 "<<" 为 dictionary，跳过
      if (text[i] === "<") {
        while (i < n && !(text[i] === ">" && text[i + 1] === ">")) i++;
        i += 2;
        tokens.push({ kind: "name", value: "<<dict>>", start, end: i });
        continue;
      }
      let hex = "";
      while (i < n && text[i] !== ">") {
        hex += text[i];
        i++;
      }
      i++; // consume >
      const bytes = parseHexBytes(hex);
      tokens.push({ kind: "hex", value: decodeOperatorBytes("hex", bytes), start, end: i, bytes });
      continue;
    }
    if (c === "[") {
      const start = i;
      i++;
      const inner: ContentToken[] = [];
      // 收集 array 元素直到 ]
      while (i < n && text[i] !== "]") {
        // 嵌套字符串/hex/数字
        const sc = text[i];
        if (sc === "%") { while (i < n && text[i] !== "\n" && text[i] !== "\r") i++; continue; }
        if (/\s/.test(sc)) { i++; continue; }
        if (sc === "/") {
          let v = "";
          i++;
          while (i < n && !/[\s(<>)/\[\]]/.test(text[i])) { v += text[i]; i++; }
          inner.push({ kind: "name", value: v, start: i, end: i });
          continue;
        }
        if (sc === "(") {
          const s0 = i;
          i++;
          let raw = "";
          let depth = 1;
          while (i < n && depth > 0) {
            const ch = text[i];
            if (ch === "\\") { raw += ch; if (i + 1 < n) { raw += text[i + 1]; i += 2; } else i++; }
            else if (ch === "(") { depth++; raw += ch; i++; }
            else if (ch === ")") { depth--; if (depth > 0) raw += ch; i++; }
            else { raw += ch; i++; }
          }
          const bytes = parseLiteralBytes(raw);
          inner.push({ kind: "literal", value: decodeOperatorBytes("literal", bytes), start: s0, end: i, bytes });
          continue;
        }
        if (sc === "<") {
          const s0 = i;
          i++;
          let hex = "";
          while (i < n && text[i] !== ">") { hex += text[i]; i++; }
          i++;
          const bytes = parseHexBytes(hex);
          inner.push({ kind: "hex", value: decodeOperatorBytes("hex", bytes), start: s0, end: i, bytes });
          continue;
        }
        // number
        const numStart = i;
        let numStr = "";
        while (i < n && /[-+0-9.eE]/.test(text[i])) { numStr += text[i]; i++; }
        inner.push({ kind: "number", value: parseFloat(numStr), start: numStart, end: i });
      }
      i++; // consume ]
      tokens.push({ kind: "array", value: inner, start, end: i });
      continue;
    }
    // number / operator
    if (/[0-9]/.test(c) || c === "+" || c === "-" || c === ".") {
      const start = i;
      let numStr = "";
      while (i < n && /[-+0-9.eE]/.test(text[i])) { numStr += text[i]; i++; }
      tokens.push({ kind: "number", value: parseFloat(numStr), start, end: i });
      continue;
    }
    // operator keyword（非数字字母的其它 token 视为 op；此处字母序列为 op）
    const start = i;
    let word = "";
    while (i < n && !/[\s\t\n\r\f()<>/\[\]%]/.test(text[i])) { word += text[i]; i++; }
    tokens.push({ kind: "op", value: word, start, end: i });
  }
  return tokens;
}

/** M7.7-004A：TJ array 拼接，hex 元素用 ToUnicode 感知的 hexDecode 重新解码（CID → Unicode） */
function concatArrayTextWithCodec(
  array: ContentToken,
  hexDecode?: (fontRef: string, bytes: number[]) => string,
  fontRef?: string,
): { text: string; hasHex: boolean } {
  let out = "";
  let hasHex = false;
  for (const t of array.value as ContentToken[]) {
    if (t.kind === "literal") {
      out += t.value;
    } else if (t.kind === "hex") {
      hasHex = true;
      out += hexDecode && fontRef ? hexDecode(fontRef, t.bytes) : t.value;
    }
  }
  return { text: out, hasHex };
}

/** Type0 预定义 CMap 中「定长 2 字节」的成员（UCS2 系列）。
 *  其余预定义 CMap（90ms-RKSJ-H、GBK-EUC-H、B5pc-H…）为 1/2 字节**变长混合**编码，
 *  无法在不解析 CMap 流的前提下权威解码 —— 一律判为 unknown 并拒绝猜测。 */
const FIXED_TWO_BYTE_CMAPS = new Set([
  "Identity-H", "Identity-V",
  "UCS2", "UCS2-H", "UCS2-V",
  "UniGB-UCS2-H", "UniGB-UCS2-V",
  "UniCNS-UCS2-H", "UniCNS-UCS2-V",
  "UniJIS-UCS2-H", "UniJIS-UCS2-V",
  "UniKS-UCS2-H", "UniKS-UCS2-V",
]);

/** 简单字体（单字节码）Subtype */
const SIMPLE_FONT_SUBTYPES = new Set(["TrueType", "Type1", "MMType1", "Type3"]);

/**
 * M7.8-036-FIX-001 · 按算子**实际使用的字体资源**把原始字节解成权威 charCode 序列。
 *
 * 背景：原先 export-renderer.operatorCidCodes() 依据 `rawBytes.length % 2` 推断
 * 1 字节 / 2 字节编码 —— 同一条流、同一套字体会因字节数奇偶在两种解析间跳变，
 * 导致 1 字节字体的偶数长度算子被错拆（如 [32,33] → [8225]），
 * charCode 序列永不匹配 → 原文无法删除 → 重影。
 *
 * 本函数只依据 PDF 字体字典（/Subtype + /Encoding），**不看字节长度**：
 *   - Type0 + Identity-H/V        → 定长 2 字节
 *   - Type0 + UCS2 系列 CMap      → 定长 2 字节
 *   - Type0 + 其它（变长）CMap    → unknown（拒绝）
 *   - TrueType / Type1 / MMType1 / Type3 → 单字节
 *   - 字体资源缺失 / 未知 Subtype → unknown（拒绝）
 */
export function decodeCharCodes(
  bytes: number[],
  fontDict: PDFDict | undefined,
  doc: PDFDocument,
): { codes: number[] | null; basis: TextShowRecord["charCodeBasis"] } {
  if (!bytes || bytes.length === 0) return { codes: [], basis: "1-byte" };
  if (!fontDict || !(fontDict instanceof PDFDict)) return { codes: null, basis: "unknown" };

  const subtype = fontDict.get(PDFName.of("Subtype"));
  const sub = (subtype?.toString?.() ?? "").replace(/^\//, "");

  if (sub === "Type0") {
    // /Encoding 可能是 Name，也可能是 CMap 流的 PDFRef
    let encName = "";
    const enc = fontDict.get(PDFName.of("Encoding"));
    if (enc instanceof PDFName) {
      encName = enc.asString().replace(/^\//, "");
    } else {
      // 可能是 CMap 流的 PDFRef：解引用后取 /CMapName
      const cmap = asPDFDict(enc, doc);
      if (cmap) {
        const cn = cmap.get(PDFName.of("CMapName"));
        if (cn instanceof PDFName) encName = cn.asString().replace(/^\//, "");
      }
    }
    if (!FIXED_TWO_BYTE_CMAPS.has(encName)) return { codes: null, basis: "unknown" };
    // 定长 2 字节：字节数必须为偶数，否则说明解析有误 → 拒绝猜测
    if (bytes.length % 2 !== 0) return { codes: null, basis: "unknown" };
    const codes: number[] = [];
    for (let i = 0; i < bytes.length; i += 2) codes.push(((bytes[i] & 0xff) << 8) | (bytes[i + 1] & 0xff));
    return {
      codes,
      basis: encName === "Identity-H" || encName === "Identity-V" ? "2-byte-identity" : "2-byte-ucs2",
    };
  }

  if (SIMPLE_FONT_SUBTYPES.has(sub)) {
    return { codes: bytes.map((b) => b & 0xff), basis: "1-byte" };
  }

  return { codes: null, basis: "unknown" };
}

/** 把任意 PDF 对象解析为 PDFDict。
 *  注意：pdf-lib 的 **PDFDict 自身带一个名为 `dict` 的内部 Map**，
 *  因此 `(obj as {dict?}).dict ?? obj` 会错误地取到那个 Map 而非 PDFDict。
 *  必须先判 `obj instanceof PDFDict`，只有 PDFRawStream/PDFStream 之类才取 `.dict`。 */
function asPDFDict(obj: unknown, doc: PDFDocument): PDFDict | undefined {
  if (!obj) return undefined;
  if (obj instanceof PDFDict) return obj;
  if (obj instanceof PDFRef) {
    try {
      return asPDFDict(doc.context.lookup(obj), doc);
    } catch {
      return undefined;
    }
  }
  const inner = (obj as { dict?: unknown })?.dict;
  return inner instanceof PDFDict ? inner : undefined;
}

/** 把 4-hex 字符串解码为 unicode（bfchar 目标形如 <0041> 或 <1F600>） */
function hexToUnicode(hex: string): string {
  let s = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
  return s || String.fromCodePoint(parseInt(hex, 16) || 0x20);
}

/** 解析字体 /ToUnicode CMap 流 → charCode → unicode 映射。
 *  支持 bfchar（单点）与 bfrange（连续 / 数组两种写法）。无 /ToUnicode 或解析失败返回 null。 */
export function parseToUnicodeCMap(
  fontDict: PDFDict | undefined,
  doc: PDFDocument,
): Map<number, string> | null {
  if (!fontDict || !(fontDict instanceof PDFDict)) return null;
  const tu = fontDict.get(PDFName.of("ToUnicode"));
  if (!tu) return null;
  let stream: unknown = tu;
  if (tu instanceof PDFRef) stream = doc.context.lookup(tu);
  const rawStream = stream as PDFRawStream | undefined;
  if (!rawStream) return null;
  let bytes: Uint8Array | undefined;
  try {
    bytes = decodePDFRawStream(rawStream as PDFRawStream).decode();
  } catch {
    bytes = (rawStream as { contents?: Uint8Array }).contents;
  }
  if (!bytes || !(bytes instanceof Uint8Array)) return null;
  const text = new TextDecoder("latin1").decode(bytes);
  const map = new Map<number, string>();

  const bfchar = text.match(/beginbfchar[\s\S]*?endbfchar/);
  if (bfchar) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bfchar[0]))) map.set(parseInt(m[1], 16), hexToUnicode(m[2]));
  }
  const bfrange = text.match(/beginbfrange[\s\S]*?endbfrange/);
  if (bfrange) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[[\s\S]*?\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bfrange[0]))) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3].startsWith("[")) {
        const arr = m[3].match(/<([0-9A-Fa-f]+)>/g) ?? [];
        for (let i = 0; i <= hi - lo; i++) {
          if (arr[i]) map.set(lo + i, hexToUnicode(arr[i].slice(1, -1)));
        }
      } else {
        const dstLo = parseInt(m[4], 16);
        for (let i = 0; i <= hi - lo; i++) map.set(lo + i, String.fromCodePoint(dstLo + i));
      }
    }
  }
  return map.size ? map : null;
}

/** 由字体 /ToUnicode 把算子的权威 charCodes 解码为真实 unicode 文本；无 /ToUnicode 返回 null。 */
export function decodeOperatorUnicode(
  codes: number[] | null,
  fontDict: PDFDict | undefined,
  doc: PDFDocument,
): string | null {
  if (!codes || !fontDict) return null;
  const map = parseToUnicodeCMap(fontDict, doc);
  if (!map) return null;
  let out = "";
  for (const c of codes) out += map.get(c) ?? "";
  return out.length ? out : null;
}

/** 基于「当前流的资源字典」构造 字体 key → 字体字典 解析器。
 *  页面流用 page /Resources；Form XObject 用该 XObject 自己的 /Resources。 */
export function makeFontDictResolver(
  doc: PDFDocument,
  resDict: PDFDict | undefined,
): (key: string) => PDFDict | undefined {
  const rd = asPDFDict(resDict, doc);
  const fontDict = rd ? asPDFDict(rd.get(PDFName.of("Font")), doc) : undefined;
  return (key: string) => {
    if (!key || !fontDict) return undefined;
    return asPDFDict(fontDict.get(PDFName.of(key)), doc);
  };
}

/** showText 算子记录（解析自单个 content stream） */
export interface TextShowRecord {
  streamObjRef: string;
  streamIndex: number;
  operatorText: string;
  op: "Tj" | "TJ";
  literalKind: "literal" | "hex";
  fontResourceKey: string;
  /** 内容流字节区间（deflate 前），operandStart..opEnd */
  byteStart: number;
  byteEnd: number;
  sequentia: number;
  /** M7.8-036-FIX-002 · 原子级 operator 身份（Original PDF Operator Provenance）。
   *  = `${streamObjRef}#${sequentia}`，全局唯一，稳定。
   *  stripReplacedTextOperators 按此直接定位原文子串，不再用 charCode 序列去猜。 */
  operatorId: string;
  /** 算子原始字节（literal/hex 的解码前字节，TJ 为内部各元素的字节拼接）。 */
  rawBytes: number[];
  /** M7.8-036-FIX-001 · 权威 charCode 序列。
   *  由该算子**实际使用的字体资源**（/Subtype + /Encoding）解出，是定位原 operator 的
   *  唯一合法依据。调用方（stripReplacedTextOperators）必须直接消费本字段，
   *  **禁止**再依据 rawBytes.length 的奇偶推断 1 字节 / 2 字节。
   *
   *  null = 无法权威解码（字体资源缺失、Type0 非定长 CMap、字节数与编码不符等）。
   *  此时调用方必须**跳过该算子**，不得猜测，避免误删。 */
  charCodes: number[] | null;
  /** charCodes 的解码依据（诊断用，便于确认不是长度猜测） */
  charCodeBasis: "1-byte" | "2-byte-identity" | "2-byte-ucs2" | "unknown";
  /** 由字体 /ToUnicode CMap 解出的算子真实 unicode 文本（逐字符）。
   *  用于与 glyph.char（pdf.js 已解码 unicode）对齐建立 provenance —— operatorText 只是
   *  原始字节的 latin1 解码，对子集字体是无意义乱码，不能作为对齐锚点。无 /ToUnicode 时为 undefined。 */
  unicodeText?: string;
  /** M7.8-042-FALLBACK-Y · 算子所在文本行矩阵（Tm/Td/TD/T* 累积）的起点，
   *  原始 PDF 用户空间坐标（未含 cm / Form XObject 变换）。
   *  供文本兜底剥离做 y 带过滤（仅同 baseline 的算子才参与行匹配，避免跨行误剥离）。
   *  与 pdf.js glyph 基线（metrics.pdfTransform[5]，视口 y 向下）的关系：
   *  textY ≈ cropBox.y1 - pdfjsY。无法追踪（畸形流）时为 undefined。 */
  textX?: number;
  textY?: number;
}

/** M7.7-004A：extractShowTextRecords 选项（ToUnicode 感知的 CID hex 解码） */
export interface ShowTextExtractOptions {
  /** hex 算子文本解码器（fontRef + CID 双字节序列 → Unicode）；缺省用现有 heuristic */
  hexDecode?: (fontRef: string, bytes: number[]) => string;
  /** M7.8-036-FIX-001：当前流资源字典下 字体 key → 字体字典。
   *  用于按真实字体编码解出权威 charCode 序列（见 decodeCharCodes）。
   *  不传时 charCodes 一律为 null（调用方会跳过，绝不猜测）。 */
  resolveFontDict?: (key: string) => PDFDict | undefined;
  /** M7.8-036-FIX-001：PDFDocument 实例，decodeCharCodes 解析 Type0 /Encoding 的
   *  CMap 引用时需要。缺省时 Type0 非 Name 型 /Encoding 判为 unknown。 */
  doc?: PDFDocument;
}

/** 解析单个 content stream 文本为 showText 记录列表（含字体状态跟踪） */
export function extractShowTextRecords(
  contentText: string,
  streamObjRef: string,
  streamIndex: number,
  opts?: ShowTextExtractOptions,
): TextShowRecord[] {
  const tokens = tokenizeContentStream(contentText);
  const records: TextShowRecord[] = [];
  let curFont: string | null = null;
  let seq = 0;
  // M7.8-042-FALLBACK-Y：文本行矩阵追踪（Tm/Td/TD/TL/T*/'/"），供算子记录携带 baseline。
  let lineMatrix: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  const prevNums = (idx: number, max: number): number[] => {
    const out: number[] = [];
    let k = idx - 1;
    while (k >= 0 && tokens[k].kind === "number" && out.length < max) {
      out.unshift((tokens[k] as { value: number }).value);
      k--;
    }
    return out;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // 文本状态算子：维护行矩阵（textY = 行矩阵 f 分量 = baseline 的原始用户空间 y）
    if (tok.kind === "op") {
      const v = tok.value;
      if (v === "BT") {
        lineMatrix = [1, 0, 0, 1, 0, 0];
      } else if (v === "Tm") {
        const n = prevNums(i, 6);
        if (n.length === 6) lineMatrix = [n[0], n[1], n[2], n[3], n[4], n[5]];
      } else if (v === "Td" || v === "TD") {
        const n = prevNums(i, 2);
        if (n.length === 2) {
          const [tx, ty] = n;
          lineMatrix = [
            lineMatrix[0], lineMatrix[1], lineMatrix[2], lineMatrix[3],
            lineMatrix[4] + tx * lineMatrix[0] + ty * lineMatrix[2],
            lineMatrix[5] + tx * lineMatrix[1] + ty * lineMatrix[3],
          ];
          if (v === "TD") leading = -ty;
        }
      } else if (v === "TL") {
        const n = prevNums(i, 1);
        if (n.length === 1) leading = n[0];
      } else if (v === "T*" || v === "'" || v === '"') {
        lineMatrix = [lineMatrix[0], lineMatrix[1], lineMatrix[2], lineMatrix[3], lineMatrix[4], lineMatrix[5] - leading];
      }
    }
    // /Fnn <size> Tf → 字体资源（Tf 带字号操作数）
    if (
      tok.kind === "name" &&
      tokens[i + 1]?.kind === "number" &&
      tokens[i + 2]?.kind === "op" &&
      tokens[i + 2].value === "Tf"
    ) {
      curFont = tok.value;
      i += 2; // skip number + Tf
      continue;
    }
    if ((tok.kind === "literal" || tok.kind === "hex") && tokens[i + 1]?.kind === "op" && tokens[i + 1].value === "Tj") {
      // M7.7-004A：hex 算子文本用 ToUnicode 感知的 hexDecode 重新解码（CID → Unicode）
      const opText =
        tok.kind === "hex" && opts?.hexDecode && curFont
          ? opts.hexDecode(curFont, tok.bytes)
          : tok.value;
      const decoded = opts?.resolveFontDict && opts?.doc
        ? decodeCharCodes(tok.bytes, opts.resolveFontDict(curFont ?? ""), opts.doc)
        : { codes: null, basis: "unknown" as const };
      const uFont = opts?.resolveFontDict ? opts.resolveFontDict(curFont ?? "") : undefined;
      const unicodeText = opts?.doc && uFont && decoded.codes
        ? decodeOperatorUnicode(decoded.codes, uFont, opts.doc) ?? undefined
        : undefined;
      records.push({
        streamObjRef,
        streamIndex,
        operatorText: opText,
        op: "Tj",
        literalKind: tok.kind,
        fontResourceKey: curFont ?? "",
        byteStart: tok.start,
        byteEnd: tokens[i + 1].end,
        sequentia: seq,
        operatorId: `${streamObjRef}#${seq}`,
        rawBytes: tok.bytes,
        charCodes: decoded.codes,
        charCodeBasis: decoded.basis,
        unicodeText,
        textX: lineMatrix[4],
        textY: lineMatrix[5],
      });
      seq++;
      i++; // skip Tj
      continue;
    }
    if (tok.kind === "array" && tokens[i + 1]?.kind === "op" && tokens[i + 1].value === "TJ") {
      const joined = concatArrayTextWithCodec(tok, opts?.hexDecode, curFont ?? undefined);
      const tjBytes: number[] = [];
      for (const t of tok.value as ContentToken[]) {
        if (t.kind === "literal" || t.kind === "hex") tjBytes.push(...t.bytes);
      }
      const tjDecoded = opts?.resolveFontDict && opts?.doc
        ? decodeCharCodes(tjBytes, opts.resolveFontDict(curFont ?? ""), opts.doc)
        : { codes: null, basis: "unknown" as const };
      const uFont = opts?.resolveFontDict ? opts.resolveFontDict(curFont ?? "") : undefined;
      const unicodeText = opts?.doc && uFont && tjDecoded.codes
        ? decodeOperatorUnicode(tjDecoded.codes, uFont, opts.doc) ?? undefined
        : undefined;
      records.push({
        streamObjRef,
        streamIndex,
        operatorText: joined.text,
        op: "TJ",
        literalKind: joined.hasHex ? "hex" : "literal",
        fontResourceKey: curFont ?? "",
        byteStart: tok.start,
        byteEnd: tokens[i + 1].end,
        sequentia: seq,
        operatorId: `${streamObjRef}#${seq}`,
        rawBytes: tjBytes,
        charCodes: tjDecoded.codes,
        charCodeBasis: tjDecoded.basis,
        unicodeText,
        textX: lineMatrix[4],
        textY: lineMatrix[5],
      });
      seq++;
      i++; // skip TJ
      continue;
    }
  }
  return records;
}

/** 内容对象 /Font 解析结果 */
export interface FontResourceBinding {
  /** 内容流中字体资源 key（如 "F1"） */
  resourceName: string;
  /** 字体对象引用（如 "12 0 R"）；内联 dict 时为 null */
  objectRef: string | null;
}

export interface ResolvedTextObject {
  pageIndex: number;
  contentStreamRef: { objectId: string };
  streamIndex: number;
  operatorIndex: number;
  operator: { op: "Tj" | "TJ"; raw: string };
  fontResource: FontResourceBinding;
  byteStart: number;
  byteEnd: number;
}

/** 读取页面第 streamIndex 个内容流（单流或数组） */
function getPageContentsStreams(
  page: any,
): Array<{ ref: string; streamIndex: number; obj: unknown }> {
  const contentsNode = page.node.Contents?.();
  if (!contentsNode) return [];
  if (contentsNode instanceof PDFArray) {
    return contentsNode.asArray().map((item, si) => ({
      ref: item instanceof PDFRef ? item.toString() : String(item?.toString?.() ?? si),
      streamIndex: si,
      obj: item instanceof PDFRef ? page.doc?.context?.lookup?.(item) : item,
    }));
  }
  const ref = contentsNode instanceof PDFRef ? contentsNode.toString() : "embedded";
  return [{ ref, streamIndex: 0, obj: contentsNode instanceof PDFRef ? page.doc?.context?.lookup?.(contentsNode) : contentsNode }];
}

/** 从 stream 取解码字节 */
function streamToBytes(obj: unknown): Uint8Array | null {
  if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
    try {
      return (decodePDFRawStream(obj as PDFRawStream) as { getBytes(): Uint8Array }).getBytes();
    } catch {
      return new Uint8Array((obj as PDFNotNullableStreamLike).getContents?.() ?? []);
    }
  }
  return null;
}

type PDFNotNullableStreamLike = { getContents(): Uint8Array };

/** 解析页面全部 content stream 的 showText 记录（含字体资源 key），流内字节区间 */
export function resolvePageShowText(
  doc: PDFDocument,
  pageIndex: number,
): Array<TextShowRecord & { fontResource: FontResourceBinding[] }> {
  const page = doc.getPage(pageIndex) as any;
  const out: Array<TextShowRecord & { fontResource: FontResourceBinding[] }> = [];
  const streams = getPageContentsStreams(page);
  const pageRes = (page.node.Resources?.() as PDFDict) ?? undefined;
  // M7.8-036-FIX-001：页面流用 page /Resources 解析字体字典，产出权威 charCode
  const resolveFontDict = makeFontDictResolver(doc, pageRes);
  for (const s of streams) {
    const bytes = streamToBytes(s.obj);
    if (!bytes) continue;
    const text = new TextDecoder("latin1").decode(bytes);
    const records = extractShowTextRecords(text, s.ref, s.streamIndex, {
      resolveFontDict,
      doc,
    });
    // 收集该页字体资源
    const fontOf = resolvePageFontResource(doc, pageIndex);
    for (const r of records) {
      out.push({ ...r, fontResource: fontOf(r.fontResourceKey) });
    }
  }
  return out;
}

/**
 * Sprint40-fix（复制层 / Form XObject 递归）：同 resolvePageShowText，但额外遍历
 * 页面 Form XObject 内容流。许多 PDF（如简历）把正文放进 Form XObject、page 级
 * /Resources 为空 —— 只读 page 流会漏掉全部正文 → stripReplacedTextOperators 找不到
 * 原文算子 → 复制层残留旧文本。每个算子带其所属 stream 的真实 PDFRef（streamObjRef），
 * 供调用方按 ref 回填，而非按 page 内容流下标。
 */
export function resolvePageShowTextWithXObjects(
  doc: PDFDocument,
  pageIndex: number,
  opts?: ShowTextExtractOptions,
): Array<TextShowRecord & { fontResource: FontResourceBinding[] }> {
  const page = doc.getPage(pageIndex) as any;
  const pageRes = (page.node.Resources?.() as PDFDict) ?? undefined;
  const seen = new Set<string>();
  const result: Array<{ ref: string; text: string; resDict: PDFDict | undefined; streamIndex: number }> = [];
  const queue: Array<{ ref: string; text: string; resDict: PDFDict | undefined; streamIndex: number }> = [];
  let xobjIdx = 1_000_000; // 给 XObject 流不与 page 内容流冲突的序号（strip 不再依赖它）

  const enqueue = (ref: string, text: string, resDict: PDFDict | undefined, streamIndex: number) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const item = { ref, text, resDict, streamIndex };
    result.push(item);
    queue.push(item);
  };

  const pageStreams = getPageContentsStreams(page);
  for (const s of pageStreams) {
    const bytes = streamToBytes(s.obj);
    if (!bytes) continue;
    enqueue(s.ref, new TextDecoder("latin1").decode(bytes), pageRes, s.streamIndex);
  }

  while (queue.length) {
    const cur = queue.shift()!;
    const tokens = tokenizeContentStream(cur.text);
    for (let i = 0; i + 1 < tokens.length; i++) {
      // name Do → 该 XObject 由当前 resources /XObject 解析
      if (tokens[i].kind === "name" && tokens[i + 1].kind === "op" && tokens[i + 1].value === "Do") {
        const name = tokens[i].value;
        const resDict = cur.resDict ?? pageRes;
        if (!resDict) continue;
        const xo = resDict.get(PDFName.of("XObject"));
        const xod = xo instanceof PDFRef ? (doc.context.lookup(xo) as PDFDict | undefined) : (xo as PDFDict | undefined);
        if (!xod || !(xod instanceof PDFDict)) continue;
        const xref = xod.get(PDFName.of(name));
        if (!xref) continue;
        const xobj = doc.context.lookup(xref as PDFRef);
        if (!xobj) continue;
        const d = (xobj as any).dict ?? xobj;
        const sub = d instanceof PDFDict ? d.get(PDFName.of("Subtype")) : undefined;
        if (!(sub?.toString?.() === "/Form")) continue;
        const xbytes = streamToBytes(xobj);
        if (!xbytes) continue;
        // 用 xref（PDFRef 本身）而非解析后对象的 .ref（lookup 后常无 .ref）
        const xrefStr = xref instanceof PDFRef ? `${xref.objectNumber} ${xref.generationNumber} R` : undefined;
        if (xrefStr) {
          const xres = d instanceof PDFDict ? (d.get(PDFName.of("Resources")) as PDFDict | undefined) : undefined;
          enqueue(xrefStr, new TextDecoder("latin1").decode(xbytes), xres, xobjIdx++);
        }
      }
    }
  }

  const fontOf = resolvePageFontResource(doc, pageIndex);
  const out: Array<TextShowRecord & { fontResource: FontResourceBinding[] }> = [];
  for (const s of result) {
    // M7.8-036-FIX-001：每个流用自己的资源字典 —— 页面流用 page /Resources，
    // Form XObject 流用该 XObject 自己的 /Resources（字体常只挂在 Form 下）。
    const resolveFontDict = makeFontDictResolver(doc, s.resDict ?? pageRes);
    const records = extractShowTextRecords(s.text, s.ref, s.streamIndex, {
      ...(opts ?? {}),
      resolveFontDict,
      doc,
    });
    for (const r of records) out.push({ ...r, fontResource: fontOf(r.fontResourceKey) });
  }
  return out;
}

/** 建立字体资源 key → 对象引用的解析函数 */
function resolvePageFontResource(
  doc: PDFDocument,
  pageIndex: number,
): (key: string) => FontResourceBinding[] {
  const page = doc.getPage(pageIndex) as any;
  const resources = page.node.Resources?.() as PDFDict | undefined;
  let fontDict: PDFDict | undefined;
  if (resources) {
    const fontVal = resources.get(PDFName.of("Font"));
    fontDict =
      fontVal instanceof PDFRef
        ? (page.doc.context.lookup(fontVal) as PDFDict)
        : (fontVal as PDFDict | undefined);
  }
  return (key: string) => {
    if (!key || !fontDict || !(fontDict instanceof PDFDict)) return [];
    const val = fontDict.get(PDFName.of(key));
    if (val === undefined || val === null) return [];
    if (val instanceof PDFRef) return [{ resourceName: key, objectRef: val.toString() }];
    return [{ resourceName: key, objectRef: null }];
  };
}

/**
 * 主入口（只读）：binding → ResolvedTextObject | null。
 *
 * 匹配：rawText 相等且唯一 → strong 返回；
 *       多候选（同一文本出现在多个算子/流）→ 返回 null（歧义安全拒绑）。
 */
export function resolveBinding(
  doc: PDFDocument,
  pageIndex: number,
  binding: Pick<OriginalTextBinding, "rawText" | "op"> | { rawText: string },
): ResolvedTextObject | null {
  const records = resolvePageShowText(doc, pageIndex);
  const candidates = records.filter((r) => r.operatorText === binding.rawText);
  if (candidates.length !== 1) return null;
  const c = candidates[0];
  const fr = c.fontResource[0] ?? { resourceName: "", objectRef: null };
  return {
    pageIndex,
    contentStreamRef: { objectId: c.streamObjRef },
    streamIndex: c.streamIndex,
    operatorIndex: c.sequentia,
    operator: { op: c.op, raw: c.operatorText },
    fontResource: { resourceName: fr.resourceName, objectRef: fr.objectRef },
    byteStart: c.byteStart,
    byteEnd: c.byteEnd,
  };
}