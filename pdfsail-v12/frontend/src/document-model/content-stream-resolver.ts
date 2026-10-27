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
        if (i > numStart) {
          inner.push({ kind: "number", value: parseFloat(numStr), start: numStart, end: i });
        } else {
          // B2-FIX（BUG-1）：本分支是 array 元素解析的**最后兜底**。进入此处意味着
          //   `sc` ∉ { %, \s, /, (, <, ] } 且 ∉ [-+0-9.eE]（如 `>` `)` `=` 字母等）。
          //   旧实现会 push 一个 `parseFloat("")` 的 number 且 **不推进 i** ⇒ 主/内层
          //   while 反复处理同一字符 ⇒ zero-progress 死循环（已在真实 Download 中命中）。
          //   修复：unknown 单字符 → 产出**明确的单字符 op token** 并推进 i，绝不伪造 number。
          inner.push({ kind: "op", value: text[i], start: i, end: i + 1 });
          i++;
        }
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
    if (i === start) {
      // B2-FIX（BUG-2）：本分支是主循环的**最后兜底**。走到此处说明 `c` 未被任何前置分支
      //   消化，却又命中 L249 的排除类 —— 即 `)` / `>` / `]`，以及 `\v`、Unicode 空白
      //   （L116 的空白集合是显式枚举 `" \t\n\r\f"`，比 L249 的 `\s` 窄，二者不一致）。
      //   旧实现在这些情况下 `word=""` 且 **不推进 i** ⇒ 主 while 反复处理同一字符 ⇒
      //   zero-progress 死循环。
      //   修复：unknown 单字符 → 产出明确的单字符 op token 并推进 i。
      word = text[i];
      i++;
    }
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

  // 5C-A2-FIX: a single /ToUnicode CMap may be split across MULTIPLE beginbfchar/beginbfrange
  // blocks (observed: 3 blocks on some CID fonts, 9 on others). The previous non-global regex
  // matched only the FIRST block, so CIDs declared in later blocks were silently missing → their
  // operators decoded to no text and lost provenance. Parse ALL blocks (same authoritative source,
  // strictly additive — no guessing). Per-entry logic below is unchanged.
  const bfcharBlocks = text.match(/beginbfchar[\s\S]*?endbfchar/g) ?? [];
  for (const blk of bfcharBlocks) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blk))) map.set(parseInt(m[1], 16), hexToUnicode(m[2]));
  }
  const bfrangeBlocks = text.match(/beginbfrange[\s\S]*?endbfrange/g) ?? [];
  for (const blk of bfrangeBlocks) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[[\s\S]*?\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blk))) {
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
  /** M7.9-BAND-FIX · 该算子绘制时的文本矩阵 Y（PDF Tm/Td 域，与 glyph.metrics.pdfTransform[5]
   *  同一坐标系）。用于 provenance 匹配的「基线带」约束：跨行/跨带不得互相抢占，
   *  否则高频重复字符（如表格里的 "3" / "0" / 空格）会被错配到别的行
   *  → 该行原算子收集不到（残留重影）且别处算子被误剥离（内容丢失）。
   *  无法追踪到 Tm/Td 时为 undefined（此时退化为纯文本匹配，行为同旧版）。 */
  tmY?: number;
}

/** 2D 仿射矩阵 [a b c d e f]（PDF 约定：x' = a·x + c·y + e；y' = b·x + d·y + f） */
export type Matrix6 = [number, number, number, number, number, number];

/**
 * m1 × m2 —— PDF `cm` 的**左乘**语义。
 * 逐位复制自 extractShowTextRecords 内联的 `cm` 分支，保证两条路径合成口径完全一致。
 */
function composeCtm(m1: Matrix6, m2: Matrix6): Matrix6 {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/** 流级 CTM 状态机（q/Q 栈 + cm 左乘），供 `Do` 预扫描复用。 */
function createCtmTracker(initial?: Matrix6) {
  let ctm: Matrix6 = initial ? ([...initial] as Matrix6) : [1, 0, 0, 1, 0, 0];
  const stack: Matrix6[] = [];
  return {
    get(): Matrix6 {
      return ctm;
    },
    op(name: string, nums: number[]): void {
      if (name === "cm" && nums.length >= 6) {
        ctm = composeCtm([nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]], ctm);
      } else if (name === "q") {
        stack.push([...ctm] as Matrix6);
      } else if (name === "Q") {
        const prev = stack.pop();
        if (prev) ctm = prev;
      }
    },
  };
}

/** 读取 Form XObject 的 /Matrix（缺省 = 单位矩阵）。无法解析时返回 undefined（调用方按单位处理）。 */
function readXObjectMatrix(d: PDFDict | undefined, doc: PDFDocument): Matrix6 | undefined {
  if (!d) return undefined;
  const raw = d.get(PDFName.of("Matrix"));
  if (raw === undefined) return undefined;
  const arr = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const asArray = (arr as { asArray?: () => unknown[] } | undefined)?.asArray?.();
  if (!asArray || asArray.length < 6) return undefined;
  const nums: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = asArray[i] as { asNumber?: () => number } | undefined;
    const v = n?.asNumber?.();
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    nums.push(v);
  }
  return nums as Matrix6;
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
  /**
   * F3B-6.17-5C-A1 · 该流的**初始 CTM**（页面空间）。
   *
   * 用于 Form XObject：XObject 内容被 `/Matrix` + `Do` 处的页面 CTM 放置，
   * 其内部 Tm 处于**局部坐标**。若不把它合成进来，`finalTmY()` 返回局部 Y，
   * 与页面空间的 glyph 基线带（`glyph.metrics.pdfTransform[5]`）差一个放置偏移
   * ⇒ provenance 的基线带约束把绝大多数算子判为跨行而拒绝
   * ⇒ coverage 崩塌 → fail-closed 整页放弃 → 导出无法剥离原文（残留）。
   *
   * 缺省 = 单位矩阵（页面内容流的历史行为，逐字节不变）。
   */
  initialCtm?: Matrix6;
  /**
   * 5C-A2②：page /Contents 为**数组**时，PDF 32000-1 §7.8.2 规定各流「按单流拼接处理」，
   * **文本状态（含当前字体，由 Tf 设置）跨流延续**（BT 只重置文本矩阵/行矩阵，不重置字体）。
   * 逐流重置 `curFont` 会让数组里第 2..N 流中「本流未设字体、沿用前流」的 showText 算子
   * 拿不到字体 → decodeCharCodes 返回 null → 无 charCodes → 丢 operator provenance。
   * 实测某 CJK 简历 8 个算子因此丢失（4 个位于所在流 byte 0）。
   *
   * 缺省 = null（单流 / 无跨流需求的既有行为不变）。
   */
  initialFont?: string | null;
  /**
   * 5C-A2②：跨流共享的可变载体。extractShowTextRecords 入口读取 `curFont` 作为初值，
   * 出口写回该流结束时的当前字体，供调用方串起 /Contents 数组的下一流。
   * 仅 page 内容流之间传递；Form XObject 不参与（各自独立放置）。
   */
  fontCarryState?: { curFont?: string | null };
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
  // 5C-A2②：入口接受「前一流延续下来的当前字体」（/Contents 数组按单流拼接，文本状态跨流延续）。
  let curFont: string | null = opts?.initialFont ?? opts?.fontCarryState?.curFont ?? null;
  let seq = 0;
  // M7.9-BAND-FIX：追踪文本矩阵 Y（Tm 绝对定位 / Td·TD 相对位移）。
  // 坐标系与 glyph.metrics.pdfTransform[5] 一致（均为「流内 Tm 域」，未叠加外层 cm），
  // 供 assignOperatorProvenance 做基线带约束。
  // 当前文本原点（Tm 的 e/f，经 Td 累加），及当前 CTM（含 q/Q 栈）。
  // glyph.metrics.pdfTransform[5] 是**最终 PDF 坐标**（已叠加外层 cm），
  // 故算子侧必须同样合成 cm 才能比对 —— 只取流内 Tm 的 f 会差一个 cm 平移（实测 374.85pt）。
  let curTmE: number | undefined = undefined;
  let curTmF: number | undefined = undefined;
  // F3B-6.17-5C-A1：Form XObject 由 initialCtm 带入其放置变换（页面 CTM × /Matrix）。
  // 页面内容流不传 ⇒ 单位矩阵，历史行为逐字节不变。
  let ctm: [number, number, number, number, number, number] = opts?.initialCtm
    ? ([...opts.initialCtm] as [number, number, number, number, number, number])
    : [1, 0, 0, 1, 0, 0];
  const ctmStack: [number, number, number, number, number, number][] = [];
  const pendingNums: number[] = [];
  /** 文本原点经 CTM 后的最终 PDF y */
  const finalTmY = (): number | undefined => {
    if (curTmE === undefined || curTmF === undefined) return undefined;
    return ctm[1] * curTmE + ctm[3] * curTmF + ctm[5];
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === "number") {
      pendingNums.push(Number(tok.value));
      if (pendingNums.length > 6) pendingNums.shift();
      continue;
    }
    if (tok.kind === "op") {
      if (tok.value === "Tm" && pendingNums.length >= 6) {
        curTmE = pendingNums[4];
        curTmF = pendingNums[5];
      } else if (
        (tok.value === "Td" || tok.value === "TD") &&
        pendingNums.length >= 2 &&
        curTmE !== undefined &&
        curTmF !== undefined
      ) {
        curTmE += pendingNums[0];
        curTmF += pendingNums[1];
      } else if (tok.value === "cm" && pendingNums.length >= 6) {
        // CTM ← cm × CTM（PDF 中 cm 为左乘）
        const [a1, b1, c1, d1, e1, f1] = pendingNums;
        const [a2, b2, c2, d2, e2, f2] = ctm;
        ctm = [
          a1 * a2 + b1 * c2,
          a1 * b2 + b1 * d2,
          c1 * a2 + d1 * c2,
          c1 * b2 + d1 * d2,
          e1 * a2 + f1 * c2 + e2,
          e1 * b2 + f1 * d2 + f2,
        ];
      } else if (tok.value === "q") {
        ctmStack.push([...ctm] as [number, number, number, number, number, number]);
      } else if (tok.value === "Q") {
        const prev = ctmStack.pop();
        if (prev) ctm = prev;
      }
      pendingNums.length = 0;
      continue;
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
        tmY: finalTmY(),
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
        tmY: finalTmY(),
      });
      seq++;
      i++; // skip TJ
      continue;
    }
  }
  // 5C-A2②：把该流结束时的当前字体写回载体，供 /Contents 数组的下一流继承。
  if (opts?.fontCarryState) opts.fontCarryState.curFont = curFont;
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
  // F3B-6.17-5C-A1：图形状态必须沿内容流树**连续携带**。
  //   ① page /Contents 是**数组**时，PDF 32000-1 §7.8.2 规定各流「按单流拼接处理」，
  //      图形状态（CTM 等）跨流延续；逐流重置会让数组里第 2..N 流的算子落在错误坐标系。
  //   ② Form XObject 的入口 CTM = Do 处 CTM × 该 XObject 的 /Matrix。
  type StreamItem = {
    ref: string;
    text: string;
    resDict: PDFDict | undefined;
    streamIndex: number;
    ctm?: Matrix6;
    /** 是否为 page /Contents 数组中的流（需跨流继承图形状态） */
    isPageStream?: boolean;
  };
  const result: StreamItem[] = [];
  const queue: StreamItem[] = [];
  let xobjIdx = 1_000_000; // 给 XObject 流不与 page 内容流冲突的序号（strip 不再依赖它）

  const enqueue = (
    ref: string,
    text: string,
    resDict: PDFDict | undefined,
    streamIndex: number,
    ctm?: Matrix6,
    isPageStream?: boolean,
  ) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const item: StreamItem = { ref, text, resDict, streamIndex, ctm, isPageStream };
    result.push(item);
    queue.push(item);
  };

  const pageStreams = getPageContentsStreams(page);
  for (const s of pageStreams) {
    const bytes = streamToBytes(s.obj);
    if (!bytes) continue;
    enqueue(s.ref, new TextDecoder("latin1").decode(bytes), pageRes, s.streamIndex, undefined, true);
  }

  // [RESOLVE-B2] 临时诊断计数器（可移除；仅观察，不改变逻辑）
  let resolveIteration = 0;
  // ★ 5C-A1①：跨 /Contents 数组各流携带的 CTM（PDF 7.8.2：数组按单流拼接处理）
  let carriedPageCtm: Matrix6 | undefined = undefined;
  while (queue.length) {
    const cur = queue.shift()!;
    resolveIteration++;
    console.log("[RESOLVE-B2] iter", {
      i: resolveIteration,
      queueLen: queue.length,
      ref: cur.ref,
      textLen: cur.text.length,
    });
    console.log(`[RESOLVE-B2] before-tokenize i=${resolveIteration}`);
    const tokens = tokenizeContentStream(cur.text);
    console.log(`[RESOLVE-B2] after-tokenize i=${resolveIteration} tokens=${tokens.length}`);
    console.log(`[RESOLVE-B2] before-token-processing i=${resolveIteration}`);
    // F3B-6.17-5C-A1：追踪 Do 处的 CTM（q/Q/cm），用于跨流继承与 XObject 放置合成。
    //   page /Contents 数组的后续流从**上一流结束时的 CTM** 起（PDF 7.8.2）；
    //   XObject 流从「父流 Do 处 CTM × 自身 /Matrix」起。
    const startCtm = cur.ctm ?? (cur.isPageStream ? carriedPageCtm : undefined);
    cur.ctm = startCtm; // 固化入口 CTM，供下方 extraction 循环使用
    const tracker = createCtmTracker(startCtm);
    const pendingNums: number[] = [];
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i].kind === "number") {
        pendingNums.push(Number(tokens[i].value));
        if (pendingNums.length > 6) pendingNums.shift();
        continue;
      }
      if (tokens[i].kind === "op") {
        tracker.op(tokens[i].value, pendingNums);
        pendingNums.length = 0;
        continue;
      }
      // name Do → 该 XObject 由当前 resources /XObject 解析
      if (tokens[i].kind === "name" && tokens[i + 1].kind === "op" && tokens[i + 1].value === "Do") {
        console.log(`[RESOLVE-B2] do-found i=${resolveIteration} tok=${i} name=${tokens[i].value}`);
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
          // ★ 5C-A1：XObject 放置变换 = Do 处 CTM × /Matrix（缺省 /Matrix ⇒ 单位阵）
          const xm = readXObjectMatrix(d instanceof PDFDict ? d : undefined, doc);
          const childCtm = xm ? composeCtm(tracker.get(), xm) : tracker.get();
          enqueue(xrefStr, new TextDecoder("latin1").decode(xbytes), xres, xobjIdx++, childCtm);
        }
      }
    }
    // ★ 5C-A1①：把本页内容流结束时的 CTM 交给数组中的下一条流
    if (cur.isPageStream) carriedPageCtm = tracker.get();
    console.log(`[RESOLVE-B2] after-token-processing i=${resolveIteration}`);
  }

  // [RESOLVE-B2] 临时诊断 marker（可移除；仅观察，不改变返回值）
  console.log("[RESOLVE-B2] done", { iterations: resolveIteration, remainingQueue: queue.length });
  const fontOf = resolvePageFontResource(doc, pageIndex);
  const out: Array<TextShowRecord & { fontResource: FontResourceBinding[] }> = [];
  // 5C-A2②：page /Contents 数组各流按「单流拼接」处理 ⇒ 文本状态（当前字体）跨流延续。
  // 用一个共享载体把前一流末尾的 curFont 传给下一流；Form XObject 不参与（各自独立放置）。
  const pageFontCarry: { curFont?: string | null } = {};
  for (const s of result) {
    // M7.8-036-FIX-001：每个流用自己的资源字典 —— 页面流用 page /Resources，
    // Form XObject 流用该 XObject 自己的 /Resources（字体常只挂在 Form 下）。
    const resolveFontDict = makeFontDictResolver(doc, s.resDict ?? pageRes);
    const records = extractShowTextRecords(s.text, s.ref, s.streamIndex, {
      ...(opts ?? {}),
      resolveFontDict,
      doc,
      // F3B-6.17-5C-A1：把该流的放置 CTM 带入，使 tmY 落在页面空间。
      initialCtm: (opts ?? {}).initialCtm ?? s.ctm,
      // 5C-A2②：仅 page 内容流共享字体载体（XObject 之间不传递）。
      ...(s.isPageStream ? { fontCarryState: pageFontCarry } : {}),
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