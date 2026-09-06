/**
 * pdf-font-metrics.ts — M7.5-002 · PDF Native Glyph Metrics Pipeline
 *
 * 职责：解析 PDF Font Dictionary，产出真实的逐字符 advance width。
 *
 * 数据源（不依赖 pdf.js，也不依赖 Canvas measureText）：
 *   PDF Font Dictionary
 *     ├─ /Widths           （简单字体：charCode → 1/1000 em）
 *     ├─ /FirstChar /LastChar
 *     ├─ /Encoding         （/Differences → charCode → glyph 名）
 *     ├─ /ToUnicode        （charCode → Unicode CMap）
 *     ├─ /FontDescriptor   （/Ascent /Descent）
 *     └─ Standard 14       （无 /Widths，用 Adobe AFM 隐式表）
 *
 * 输出：每页 Map<fontResourceKey, ParsedFontMetrics>
 *
 * 边界：
 *   - 仅读取，Font Parser 层；不写 Renderer / Mutation / Undo / Export。
 *   - CID/CJK（Type0）现阶段 best-effort；解析不出 → 调用方走 canvas fallback。
 */
import {
  PDFDocument,
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import { AFM_BY_NAME } from "./font-afm";
import type { GlyphMetrics } from "./types";

/** 解析出的单个字体度量 */
export interface ParsedFontMetrics {
  /** PDF 字体资源 key（页面 /Font 下的名字，如 "F1"） */
  resourceName: string;
  /** BaseFont（如 "Helvetica"、"ABCDEF+Helvetica"） */
  baseFont: string;
  /** 字体类型分类 */
  kind: "standard14" | "simple" | "type0" | "unknown";
  /** M7.5-003：PDF /Subtype（"Type1" | "TrueType" | "Type0" | "CIDFontType0" | ...，可选） */
  subtype?: string;
  /** M7.5-003：是否内嵌字体（/FontDescriptor · FontFile/FontFile2/FontFile3 存在，可选） */
  embedded?: boolean;
  /** M7.5-003：编码（/Encoding 名，如 "WinAnsiEncoding" / "MacRomanEncoding" / "Differences"，可选） */
  encoding?: string;
  /** M7.5-003：FontMatrix [a,b,c,d,e,f]（/FontDescriptor · /FontMatrix；Type1 默认 [0.001,0,0,0.001,0,0]） */
  fontMatrix?: [number, number, number, number, number, number];
  /** /FontDescriptor /Ascent（1/1000 em，可选） */
  ascent?: number;
  /** /FontDescriptor /Descent（1/1000 em，可选） */
  descent?: number;
  /** charCode → Unicode 字符 */
  charCodeToUnicode: Map<number, string>;
  /** Unicode 字符 → 每字符 advance（PDF pt，fontSize=1） */
  unicodeToAdvance: Map<string, number>;
  /** charCode → 每字符 advance（PDF pt，fontSize=1） */
  charCodeToAdvance: Map<number, number>;
  /** 是否含完整 Width 数据（false → 调用方需 fallback） */
  hasWidthData: boolean;
}

/** 每页字体度量集 */
export interface PageFontMetrics {
  metrics: Map<string, ParsedFontMetrics>;
}

/**
 * 解析 PDF 全部页面字体度量（与 pdf.getPages() 顺序一致）。
 */
/**
 * M7.8-035R: 把字体对象（可能是 PDFRef → PDFDict，也可能是 PDFStream 包裹的字体字典）
 * 归一化为可读取的 PDFDict。嵌入字体常以 PDFStream 形式存在，旧的 `instanceof PDFDict`
 * 检查会直接跳过 → 字体表为空 → 原生重建跳过 → 回落 CSS 替代字体（BUG-3 字体不匹配/重影）。
 */
function toFontDict(o: unknown, doc: PDFDocument): PDFDict | null {
  let cur: any = o;
  while (cur instanceof PDFRef) cur = doc.context.lookup(cur);
  if (cur instanceof PDFDict) return cur;
  if (cur instanceof PDFStream) return cur.dict;
  return null;
}

/**
 * M7.8-035R: 沿页面树向上归集 /Resources 中的 /Font。
 *
 * pdf-lib 的 `page.node.Resources()` 只返回本节点直接挂的 /Resources，
 * 不解析由 Pages 父节点继承的资源。多数真实 PDF 的字体挂在父节点上，
 * 导致字体度量表为空 → 导入时 glyph 拿不到 fontIdentity → 导出原生重建
 * 跳过 → 回落 CSS 替代字体 → 字体视觉不一致 / 重影（BUG-3）。
 * 这里手动沿 Parent 链归集 /Font（子节点 key 覆盖父节点）。
 */
function collectPageFonts(doc: PDFDocument, pageNode: unknown): Map<string, unknown> {
  const collected = new Map<string, unknown>();
  const chain: unknown[] = [];
  let node: unknown = pageNode;
  while (node && node instanceof PDFDict) {
    chain.push(node);
    const parent = deref((node as PDFDict).get(PDFName.of("Parent")), doc);
    node = parent instanceof PDFDict ? parent : null;
  }
  for (const n of chain.reverse()) {
    const res = deref((n as PDFDict).get(PDFName.of("Resources")), doc);
    if (res instanceof PDFDict) {
      const fonts = toFontDict(res.get(PDFName.of("Font")), doc);
      if (fonts) {
        for (const k of fonts.keys()) collected.set(k.asString(), fonts.get(k));
      }
    }
  }
  return collected;
}

export function parsePdfFontMetrics(doc: PDFDocument): PageFontMetrics[] {
  return doc.getPages().map((page) => {
    const fonts = collectPageFonts(doc, page.node);
    const out: PageFontMetrics = { metrics: new Map() };
    for (const [keyName, fontObj] of fonts) {
      try {
        const fontDict = toFontDict(fontObj, doc);
        if (!fontDict) continue;
        const metrics = parseFontDict(doc, keyName, fontDict);
        if (metrics) out.metrics.set(keyName, metrics);
      } catch {
        // 单字体解析失败不影响其它字体
      }
    }
    return out;
  });
}

function parseFontDict(doc: PDFDocument, resourceName: string, fontDict: PDFDict): ParsedFontMetrics | null {
  const subtype = asName(fontDict.get(PDFName.of("Subtype")));
  // M7.5-004：asName() 返回带前导 "/" 的名称（如 "/Type0"），路由比较需剥离。
  const subtypePlain = subtype?.replace(/^\//, "");
  const baseFont = asName(fontDict.get(PDFName.of("BaseFont"))) ?? resourceName;
  // 归一化 BaseFont：去前导 "/"（如 pdf-lib 生成的 "/Helvetica"）、去 subset 前缀（"ABCDEF+"）
  const plainBase = baseFont.replace(/^\//, "").replace(/^.*\+/, "");
  const standard = AFM_BY_NAME[plainBase];

  let m: ParsedFontMetrics;
  if (subtypePlain === "Type0") {
    m = parseType0(doc, resourceName, baseFont, fontDict) ?? mkEmpty(resourceName, baseFont, "type0");
  } else if (standard) {
    m = mkStandard14(resourceName, baseFont, standard);
  } else {
    m = parseSimpleFont(doc, resourceName, baseFont, fontDict);
  }
  // M7.5-003：补全 Font Identity 字段（subtype 存 plain 值）
  m.subtype = subtypePlain ?? m.kind;
  if (m.encoding === undefined) {
    const enc = fontDict.get(PDFName.of("Encoding"));
    m.encoding = enc instanceof PDFName ? enc.asString() : enc instanceof PDFDict ? "Differences" : undefined;
  }
  // embedded 由 readDescriptor 检测 FontFile*, 若无 descriptor 则保留 undefined
  return m;
}

/** 通过 ref 解析对象 */
function deref(obj: unknown, doc: PDFDocument): unknown {
  let cur = obj;
  const guard = new Set<string>();
  while (cur instanceof PDFRef) {
    const key = cur.toString();
    if (guard.has(key)) return cur;
    guard.add(key);
    cur = doc.context.lookup(cur);
  }
  return cur;
}

/* ───────────────────────── Standard 14 ───────────────────────── */
function mkStandard14(resourceName: string, baseFont: string, afm: (typeof AFM_BY_NAME)[string]): ParsedFontMetrics {
  const iso = new Map<string, number>();
  const ic = new Map<number, string>();
  const ia = new Map<number, number>();
  for (const [ch, w] of Object.entries(afm.widths)) {
    const cp = ch.codePointAt(0)!;
    const adv = w / 1000;
    iso.set(ch, adv);
    ic.set(cp, ch);
    ia.set(cp, adv);
  }
  return {
    resourceName,
    baseFont,
    kind: "standard14",
    charCodeToUnicode: ic,
    unicodeToAdvance: iso,
    charCodeToAdvance: ia,
    hasWidthData: true,
    ascent: standardAscent(baseFont)?.ascent,
    descent: standardAscent(baseFont)?.descent,
    // Type1/TrueType 无 descriptor 时默认 FontMatrix（PDF spec Type1）
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
  };
}

/* ───────────────────────── 简单字体（Type1 / TrueType 带 /Widths） ───────────────────────── */
function parseSimpleFont(doc: PDFDocument, resourceName: string, baseFont: string, fontDict: PDFDict): ParsedFontMetrics {
  const first = asNumber(fontDict.get(PDFName.of("FirstChar"))) ?? 0;
  const last = asNumber(fontDict.get(PDFName.of("LastChar")));
  const widths = fontDict.get(PDFName.of("Widths"));
  if (last === undefined || !(widths instanceof PDFArray)) return mkEmpty(resourceName, baseFont, "simple");

  const toUnicode = codeToUnicodeFromToUnicode(doc, fontDict);
  const differences = codeToUnicodeFromDifferences(doc, fontDict);
  const m = mkEmpty(resourceName, baseFont, "simple");
  const list = widths.asArray();
  for (let c = first; c <= last; c++) {
    const idx = c - first;
    const rawW = list[idx];
    if (!(rawW instanceof PDFNumber)) continue;
    const adv = rawW.asNumber() / 1000;
    const uni = toUnicode.get(c) ?? differences.get(c) ?? latin1Char(c);
    if (uni) {
      m.unicodeToAdvance.set(uni, adv);
      m.charCodeToUnicode.set(c, uni);
    }
    m.charCodeToAdvance.set(c, adv);
    m.hasWidthData = true;
  }
  readDescriptor(doc, fontDict, m);
  return m;
}

/* ───────────────────────── Type0 / CID（best-effort） ───────────────────────── */
function parseType0(doc: PDFDocument, resourceName: string, baseFont: string, fontDict: PDFDict): ParsedFontMetrics | null {
  const m = mkEmpty(resourceName, baseFont, "type0");
  const toUnicode = codeToUnicodeFromToUnicode(doc, fontDict);
  if (toUnicode.size === 0) return m; // 无法关联 Unicode，留空 → fallback
  const descFonts = deref(
    fontDict.get(PDFName.of("DescendantFonts")) instanceof PDFArray
      ? (fontDict.get(PDFName.of("DescendantFonts")) as PDFArray).get(0)
      : undefined,
    doc,
  );
  if (!(descFonts instanceof PDFDict)) return m;
  const dw = asNumber(descFonts.get(PDFName.of("DW"))) ?? 1000;
  const w = descFonts.get(PDFName.of("W"));
  if (w instanceof PDFArray) {
    readGlyphWidths(w, dw, (cid, adv) => {
      const uni = toUnicode.get(cid);
      if (uni) {
        m.unicodeToAdvance.set(uni, adv);
        m.charCodeToUnicode.set(cid, uni);
      }
      m.charCodeToAdvance.set(cid, adv);
      m.hasWidthData = true;
    });
  }
  // M7.5-004：CID 字体的 /DW 默认宽 —— 未出现在 /W 中的码，也设默认宽（否则 unicode 无 adv → fallback canvas）
  const dwAdv = dw / 1000;
  for (const [cid, uni] of toUnicode) {
    if (m.charCodeToAdvance.has(cid)) continue;
    m.charCodeToAdvance.set(cid, dwAdv);
    m.unicodeToAdvance.set(uni, dwAdv);
    m.hasWidthData = true;
  }
  readDescriptor(doc, descFonts, m);
  return m;
}

/* ───────────────────────── Descriptor / Encoding / ToUnicode ───────────────────────── */
function readDescriptor(doc: PDFDocument, fontDict: PDFDict, m: ParsedFontMetrics): void {
  const desc = deref(fontDict.get(PDFName.of("FontDescriptor")), doc) as PDFDict | undefined;
  if (desc instanceof PDFDict) {
    const a = asNumber(desc.get(PDFName.of("Ascent")));
    const d = asNumber(desc.get(PDFName.of("Descent")));
    if (a !== undefined) m.ascent = a;
    if (d !== undefined) m.descent = d;
    // M7.5-003：内嵌字体检测（FontFile / FontFile2 / FontFile3 任一存在即内嵌）
    const hasFontFile =
      desc.has(PDFName.of("FontFile")) || desc.has(PDFName.of("FontFile2")) || desc.has(PDFName.of("FontFile3"));
    if (hasFontFile) m.embedded = true;
    // M7.5-003：FontMatrix（/FontDescriptor · /FontMatrix）
    m.fontMatrix = readFontMatrix(desc.get(PDFName.of("FontMatrix"))) ?? m.fontMatrix;
  }
  if (m.ascent === undefined || m.descent === undefined) {
    const sa = standardAscent(m.baseFont);
    if (m.ascent === undefined && sa) m.ascent = sa.ascent;
    if (m.descent === undefined && sa) m.descent = sa.descent;
  }
}

function standardAscent(plainBase: string): { ascent: number; descent: number } | undefined {
  const map: Record<string, { ascent: number; descent: number }> = {
    Helvetica: { ascent: 718, descent: -207 },
    Arial: { ascent: 905, descent: -212 },
    "Times-Roman": { ascent: 683, descent: -217 },
    Courier: { ascent: 629, descent: -157 },
  };
  return map[plainBase.replace(/^.*\+/, "")];
}

function codeToUnicodeFromToUnicode(doc: PDFDocument, fontDict: PDFDict): Map<number, string> {
  const out = new Map<number, string>();
  const raw = fontDict.get(PDFName.of("ToUnicode"));
  if (raw === undefined) return out; // 无 ToUnicode → 空
  const stream = deref(raw, doc);
  if (stream instanceof PDFStream) {
    try {
      let bytes: Uint8Array;
      try {
        // 处理 FlateDecode 等 Filter 压缩（pdf-lib getContents() 返回原始压缩字节，需解压）
        const decoded = decodePDFRawStream({ dict: stream.dict, contents: stream.getContents() });
        bytes = decoded.getBytes();
      } catch (e) {
        // 无法解压时回退原始字节（可能是未压缩流）
        bytes = stream.getContents();
      }
      parseToUnicodeCmap(new TextDecoder().decode(bytes), out);
    } catch (e) {
      /* CMap 解码失败则忽略 */
    }
  }
  return out;
}

function codeToUnicodeFromDifferences(doc: PDFDocument, fontDict: PDFDict): Map<number, string> {
  const out = new Map<number, string>();
  const enc = deref(fontDict.get(PDFName.of("Encoding")), doc);
  if (!(enc instanceof PDFDict)) return out;
  const diffs = enc.get(PDFName.of("Differences"));
  if (!(diffs instanceof PDFArray)) return out;
  let code = 0;
  for (const item of diffs.asArray()) {
    if (item instanceof PDFNumber) {
      code = item.asNumber();
    } else if (item instanceof PDFName) {
      const uni = glyphNameToUnicode(item.asString());
      if (uni !== undefined) out.set(code, uni);
      code++;
    }
  }
  return out;
}

/** 解析 Glyph 名 → Unicode（Latin 子集） */
function glyphNameToUnicode(name: string): string | undefined {
  if (/^uni[0-9a-fA-F]{4}$/.test(name)) return String.fromCodePoint(parseInt(name.slice(3), 16));
  if (name === "space") return " ";
  if (/^[A-Za-z]$/.test(name) || /^[0-9]$/.test(name)) return name;
  const named: Record<string, string> = {
    period: ".", comma: ",", hyphen: "-", colon: ":", semicolon: ";",
    exclam: "!", question: "?", quoteright: "’", quoteright2: "”",
  };
  return named[name];
}

function latin1Char(code: number): string | undefined {
  return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : undefined;
}

/* ───────────────────────── /W（CID 宽度数组）解析 ───────────────────────── */
function readGlyphWidths(
  w: PDFArray,
  defaultW: number,
  emit: (cid: number, adv: number) => void,
): void {
  const arr = w.asArray();
  let i = 0;
  while (i < arr.length) {
    const first = asNumber(arr[i]);
    if (first === undefined) { i++; continue; }
    const second = arr[i + 1];
    if (second instanceof PDFArray) {
      second.asArray().forEach((item, j) => {
        const v = item instanceof PDFNumber ? item.asNumber() / 1000 : defaultW / 1000;
        emit(first + j, v);
      });
      i += 2;
    } else {
      const last = asNumber(second);
      const value = asNumber(arr[i + 2]);
      i += 3;
      if (last === undefined || value === undefined) continue;
      if (last < first) continue;
      for (let c = first; c <= last; c++) emit(c, value / 1000);
    }
  }
}

/* ───────────────────────── 最小 CMap ToUnicode 解析器 ───────────────────────── */
function parseToUnicodeCmap(text: string, out: Map<number, string>): void {
  const re1 = /beginbfchar\n([^]*?)\nendbfchar/g;
  const re2 = /beginbfrange\n([^]*?)\nendbfrange/g;
  let mc: RegExpExecArray | null;
  while ((mc = re1.exec(text))) {
    for (const line of mc[1].trim().split("\n")) {
      const m = line.match(/^<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>$/);
      if (!m) continue;
      out.set(parseInt(m[1], 16), String.fromCodePoint(parseInt(m[2], 16)));
    }
  }
  while ((mc = re2.exec(text))) {
    for (const line of mc[1].trim().split("\n")) {
      const single = line.match(/^<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>$/);
      if (single) {
        const lo = parseInt(single[1], 16);
        const hi = parseInt(single[2], 16);
        const start = parseInt(single[3], 16);
        if (lo > hi) continue;
        for (let j = 0; j <= hi - lo; j++) out.set(lo + j, String.fromCodePoint(start + j));
        continue;
      }
      const arrayLine = line.match(/^<([0-9a-fA-F]+)>\s*\[([^[\]]+)\]$/);
      if (arrayLine) {
        const code = parseInt(arrayLine[1], 16);
        const items = [...arrayLine[2].matchAll(/<([0-9a-fA-F]+)>/g)];
        items.forEach((it, j) => out.set(code + j, String.fromCodePoint(parseInt(it[1], 16))));
      }
    }
  }
}

/* ───────────────────────── 小工具 ───────────────────────── */
function mkEmpty(resourceName: string, baseFont: string, kind: ParsedFontMetrics["kind"]): ParsedFontMetrics {
  return {
    resourceName,
    baseFont,
    kind,
    charCodeToUnicode: new Map(),
    unicodeToAdvance: new Map(),
    charCodeToAdvance: new Map(),
    hasWidthData: false,
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
  };
}

/** 读取 /FontMatrix（PDFArray 6 个数字），失败返回 undefined */
function readFontMatrix(v: unknown): [number, number, number, number, number, number] | undefined {
  if (!(v instanceof PDFArray)) return undefined;
  const arr = v.asArray();
  if (arr.length < 6) return undefined;
  const out = arr.slice(0, 6).map((it) => asNumber(it));
  if (out.some((n) => n === undefined)) return undefined;
  return out as [number, number, number, number, number, number];
}

function asName(v: unknown): string | undefined {
  return v instanceof PDFName ? v.asString() : undefined;
}
function asNumber(v: unknown): number | undefined {
  return v instanceof PDFNumber ? v.asNumber() : typeof v === "number" ? v : undefined;
}

/* ───────────────────────── GlyphMetrics 服务 ───────────────────────── */

/**
 * 由 ParsedFontMetrics 计算某 unicode 字符在给定字号下的 Glyph 度量（PDF pt 域）。
 *
 * @returns 补充的 GlyphMetrics 字段（不含 advanceWidth），或 undefined（无宽度数据）。
 */
export function glyphMetricsFromFont(
  fm: ParsedFontMetrics,
  unicode: string,
  fontSize: number,
  horizontalScale = 1,
  charSpacing = 0,
): Omit<GlyphMetrics, "advanceWidth"> | undefined {
  const advPt = fm.unicodeToAdvance.get(unicode);
  if (advPt === undefined && !fm.hasWidthData) return undefined;
  let pdfCharCode: number | undefined;
  for (const [code, u] of fm.charCodeToUnicode) {
    if (u === unicode) { pdfCharCode = code; break; }
  }
  return {
    pdfCharCode,
    unicode,
    fontName: fm.baseFont.replace(/^\//, ""),
    fontSize,
    horizontalScale,
    charSpacing,
    ascent: fm.ascent,
    descent: fm.descent,
    // M7.5-003：Font Identity + FontMatrix
    fontMatrix: fm.fontMatrix,
    fontIdentity: {
      fontRef: fm.resourceName,
      fontName: fm.baseFont.replace(/^\//, ""),
      baseFont: fm.baseFont.replace(/^\//, "").replace(/^.*\+/, ""),
      subtype: fm.subtype,
      embedded: fm.embedded,
      encoding: fm.encoding,
    },
  };
}

/**
 * 真正的逐字符 advance（PDF pt，已含 horizontalScale / charSpacing）。
 * @returns PDF pt；若该 unicode 无宽度数据则 undefined（调用方 fallback）。
 */
export function trueAdvancePt(fm: ParsedFontMetrics, unicode: string, fontSize: number, horizontalScale = 1, charSpacing = 0): number | undefined {
  const base = fm.unicodeToAdvance.get(unicode);
  if (base === undefined) return undefined;
  return base * fontSize * horizontalScale + charSpacing;
}

/* ───────────────────────── M7.7-004A · ToUnicode CID 编解码器 ───────────────────────── */

/**
 * 页面级 CID 编解码器（M7.7-004A · Font Identity Pipeline Repair）。
 *
 * 解决「CID/Type0/Identity-H 字体下 CID ≠ Unicode 码元」的问题：
 *   - decodeHex：CID 双字节码序列 → Unicode（供 content stream 算子匹配 binding / originalText）
 *   - encodeHex：Unicode → CID hex 字符串（供 native Tj/TJ 替换写入）；字符无 CID 时返回 null（整批回退 overlay）
 *
 * 数据源：页面 /Font 字典每字体的 /ToUnicode CMap（CID → Unicode）反查。
 */
export interface PageCidCodec {
  /** CID 双字节码序列（每码 ≤ 0xFFFF）→ Unicode 文本 */
  decodeHex(fontRef: string, bytes: number[]): string;
  /** Unicode 文本 → CID hex（不含 <>）；任一字符缺失 CID 返回 null */
  encodeHex(fontRef: string, text: string): string | null;
}

/**
 * 构建页面 CID 编解码器（按 /Font 资源 key 索引）。
 * 页面无任何带非空 ToUnicode 的字体时返回 null（调用方回退现有 heuristics）。
 */
export function buildPageCidCodec(doc: PDFDocument, pageIndex: number): PageCidCodec | null {
  const page = doc.getPage(pageIndex) as any;
  // M7.8-035R: 同样需解析继承的 /Font（pdf-lib 的 Resources() 不解析继承链）
  const fontsObj = collectPageFonts(doc, page.node);
  if (fontsObj.size === 0) return null;

  const cidToUnicodeMap = new Map<string, Map<number, string>>();
  // 归一化字体资源 key：内容流 tokenizer 的 fontResourceKey 不含前导 '/'，
  // 而 PDFName.asString() 含 '/'（如 "/F1"）→ 统一剥离，避免 lookup 失配。
  const norm = (s: string): string => s.replace(/^\//, "");
  for (const [keyName, fontObj] of fontsObj) {
    try {
      const fontDict = toFontDict(fontObj, doc);
      if (!fontDict) continue;
      const c2u = codeToUnicodeFromToUnicode(doc, fontDict);
      if (c2u.size > 0) cidToUnicodeMap.set(norm(keyName.asString()), c2u);
    } catch {
      /* 单字体解析失败忽略 */
    }
  }
  if (cidToUnicodeMap.size === 0) return null;

  const unicodeToCidMap = new Map<string, Map<string, number>>();
  for (const [ref, c2u] of cidToUnicodeMap) {
    const u2c = new Map<string, number>();
    for (const [cid, uni] of c2u) {
      if (!u2c.has(uni)) u2c.set(uni, cid);
    }
    unicodeToCidMap.set(ref, u2c);
  }

  return {
    decodeHex(fontRef: string, bytes: number[]): string {
      const c2u = cidToUnicodeMap.get(norm(fontRef));
      let out = "";
      for (let i = 0; i < bytes.length; i += 2) {
        const code = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
        out += c2u?.get(code) ?? String.fromCharCode(code);
      }
      return out;
    },
    encodeHex(fontRef: string, text: string): string | null {
      const u2c = unicodeToCidMap.get(norm(fontRef));
      if (!u2c) return null;
      let out = "";
      for (const ch of text) {
        const cid = u2c.get(ch);
        if (cid === undefined) return null; // 该字符无 CID → 无法 native 编码 → 整批回退 overlay
        out += cid.toString(16).padStart(4, "0").toUpperCase();
      }
      return out;
    },
  };
}