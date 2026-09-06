/**
 * export-font-resolver.ts — M7.5-005B · Font Resolver
 *
 * 目标：Export 阶段根据 Native Font Identity（GlyphFontIdentity）找到正确字体资源，
 *       供后续 005C Matrix Writer / 005D CID Writer 消费。
 *
 * 唯一输入来源：EditableGlyph.metrics.fontIdentity（Native），绝不回退 CSS font mapping。
 *
 * Resolver 流程（按优先级）：
 *   1. Standard 14：baseFont ∈ {Helvetica, Times-Roman, Courier, Symbol, ZapfDingbats, …}
 *        → source=standard14，pdfFontName 归一化。
 *   2. Embedded：fontRef（页 /Font 资源名）+ 原始 PDF → 查询 FontDescriptor 的
 *        FontFile/FontFile2/FontFile3 流，抽取字节。
 *        → source=embedded，embeddedData 就绪（供后续 subset/embed）。
 *   3. Fallback：Embedded 缺失 / 提取失败 → source=system-fallback，须输出 reason，
 *        禁止静默 CJK→Helvetica。
 *
 * 边界：仅 Export 层（本模块 + export-command/export-renderer 消费方）。
 * 禁止：Content Stream rewrite / Mutation / Undo / Editor / Import。
 */
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { GlyphFontIdentity } from "./types";

/** 解析结果 */
export interface ResolvedFont {
  /** 字体来源 */
  source: "embedded" | "standard14" | "system-fallback";
  /** subset 前缀（如 "AAAAAA"，无则省略） */
  subsetPrefix?: string;
  /** 页 /Font 资源名（fontRef） */
  fontRef?: string;
  /** 剥 prefix 后的基础字体名 */
  baseFont?: string;
  /** PDF /Subtype（"Type1"|"TrueType"|"Type0"|…） */
  subtype?: string;
  /** 是否检测到内嵌字体 */
  embedded?: boolean;
  /** 抽取到的嵌入字体流字节（source=embedded 时存在） */
  embeddedData?: Uint8Array;
  /** 归一化的 PDF 标准字体名（source=standard14 时） */
  pdfFontName?: string;
  /** fallback 原因（source=system-fallback 时必有） */
  reason?: string;
}

const STANDARD14 = new Set<string>([
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Symbol",
  "ZapfDingbats",
]);

/**
 * 剥离 subset 前缀："AAAAAA+Calibri" → { subsetPrefix:"AAAAAA", baseFont:"Calibri" }。
 * 无前缀（含转义 "\+", "-2000" 等 pdf-lib 后缀）→ baseFont 原样。
 */
export function parseSubset(baseFont: string): {
  subsetPrefix?: string;
  baseFont: string;
} {
  const plus = baseFont.indexOf("+");
  if (plus > 0) {
    const prefix = baseFont.slice(0, plus);
    if (/^[A-Za-z]{6}$/.test(prefix)) {
      return { subsetPrefix: prefix, baseFont: baseFont.slice(plus + 1) };
    }
  }
  return { baseFont };
}

/** 是否 Standard 14（剥前缀后不区分大小写粗比较） */
export function isStandard14(baseFont: string): boolean {
  const { baseFont: clean } = parseSubset(baseFont);
  return STANDARD14.has(clean) || STANDARD14.has(clean.toLowerCase());
}

/** Standard 14 → 归一化 pdf-lib 字体名（供 xref PDFDocument.embedStandardFont） */
function standard14PdfFontName(clean: string): string | undefined {
  const lower = clean.toLowerCase();
  const map: Record<string, string> = {
    helvetica: "Helvetica",
    "times-roman": "TimesRoman",
    times: "TimesRoman",
    courier: "Courier",
    symbol: "Symbol",
    zapfdingbats: "ZapfDingbats",
  };
  return map[lower];
}

/** pdf-lib 内部 deref */
function deref(v: unknown, doc: PDFDocument): unknown {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

/** 从 fontDict 定位 FontDescriptor 字典（简单字体直接在 dict；Type0 在 DescendantFonts[0]） */
function findFontDescriptor(
  doc: PDFDocument,
  fontDict: PDFDict,
): PDFDict | undefined {
  let d = deref(fontDict.get(PDFName.of("FontDescriptor")), doc);
  if (d instanceof PDFDict) return d;
  const desc = deref(fontDict.get(PDFName.of("DescendantFonts")), doc);
  if (desc instanceof PDFStream) return undefined;
  const arr = desc as unknown as {
    size(): number;
    get(i: number): unknown;
  };
  if (arr && typeof arr.size === "function") {
    for (let i = 0; i < arr.size(); i++) {
      const dd = deref(arr.get(i), doc);
      const fd = deref((dd as PDFDict)?.get?.(PDFName.of("FontDescriptor")), doc);
      if (fd instanceof PDFDict) return fd;
    }
  }
  return undefined;
}

/**
 * 从原始 PDF 按（pageIndex, resourceName）抽取内嵌字体流字节。
 * 读取 FontDescriptor 的 FontFile / FontFile2 / FontFile3（FlateDecode 自动解压，失败回退原始字节）。
 */
export function extractEmbeddedFont(
  pdf: PDFDocument,
  pageIndex: number,
  resourceName: string,
): Uint8Array | undefined {
  try {
    if (pageIndex < 0 || pageIndex >= pdf.getPageCount()) return undefined;
    const page = pdf.getPage(pageIndex);
    const res = page.node.Resources();
    if (!(res instanceof PDFDict)) return undefined;
    const fonts = deref(res.get(PDFName.of("Font")), pdf);
    if (!(fonts instanceof PDFDict)) return undefined;
    // resourceName（identity.fontRef）来自 PDFName.asString()，带前导 "/"（如 "/F1"）。
    // 归一化后按 Fonts dict 的 PDFName key 匹配，避免 PDFName.of 对 "/" 二次转义。
    const want = resourceName.replace(/^\//, "");
    let fontDict: unknown;
    for (const key of fonts.keys()) {
      if (key.asString().replace(/^\//, "") === want) {
        fontDict = deref(fonts.get(key), pdf);
        break;
      }
    }
    if (!(fontDict instanceof PDFDict)) return undefined;

    const fd = findFontDescriptor(pdf, fontDict);
    if (!fd) return undefined;

    for (const key of ["FontFile", "FontFile2", "FontFile3"]) {
      const raw = fd.get(PDFName.of(key));
      if (raw === undefined) continue;
      const stream = deref(raw, pdf);
      if (!(stream instanceof PDFStream)) continue;
      try {
        const dict = stream.dict as PDFDict;
        const decoded = decodePDFRawStream({
          dict,
          contents: stream.getContents(),
        });
        return decoded.getBytes();
      } catch {
        // 非压缩 / 无法解压 → 用原始字节
        return stream.getContents();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 主解析入口。
 * @param input.identity Native Font Identity（唯一来源）
 * @param input.pdf       原始 PDF（Overlay 时可用；供 embedded 抽取）
 * @param input.pageIndex 目标页
 */
export function resolveFont(input: {
  identity: GlyphFontIdentity;
  pdf?: PDFDocument;
  pageIndex?: number;
}): ResolvedFont {
  const { identity, pdf, pageIndex } = input;
  // 用 fontName（含 prefix）解析 subset；回退 baseFont
  const rawName = identity.fontName || identity.baseFont || "";
  const cleanName = identity.baseFont || parseSubset(rawName).baseFont;
  const { subsetPrefix } = parseSubset(rawName);

  // Step 1：Standard 14
  const cleanNoSlash = cleanName.replace(/^\//, "");
  if (isStandard14(cleanNoSlash)) {
    return {
      source: "standard14",
      subsetPrefix,
      fontRef: identity.fontRef,
      baseFont: cleanNoSlash,
      subtype: identity.subtype,
      embedded: false,
      pdfFontName: standard14PdfFontName(cleanNoSlash) ?? cleanNoSlash,
    };
  }

  // Step 2：Embedded
  if (identity.embedded && pdf && identity.fontRef && pageIndex !== undefined) {
    const bytes = extractEmbeddedFont(pdf, pageIndex, identity.fontRef);
    if (bytes && bytes.length > 0) {
      return {
        source: "embedded",
        subsetPrefix,
        fontRef: identity.fontRef,
        baseFont: cleanNoSlash,
        subtype: identity.subtype,
        embedded: true,
        embeddedData: bytes,
      };
    }
    return {
      source: "system-fallback",
      subsetPrefix,
      fontRef: identity.fontRef,
      baseFont: cleanNoSlash,
      subtype: identity.subtype,
      embedded: identity.embedded,
      reason: "embedded-font-stream-unavailable",
    };
  }

  // Step 2.5：Type3 字体 —— 无嵌入字节，但字形由 /CharProcs 定义，必须引用原资源
  // 重建（禁止回落 Standard-14/Helvetica，见 M7.8-035-B Step 9/12）。
  // 实际绘制由 export-renderer 的 raw-CID replay 用原 charCode + 原资源完成。
  if (identity.subtype === "Type3" && identity.fontRef) {
    return {
      source: "type3",
      subsetPrefix,
      fontRef: identity.fontRef,
      baseFont: cleanNoSlash,
      subtype: identity.subtype,
      embedded: false,
      reason: "type3-charprocs-reference",
    };
  }

  // Step 3：Fallback（须带 reason，禁止静默 CJK→Helvetica）
  return {
    source: "system-fallback",
    subsetPrefix,
    fontRef: identity.fontRef,
    baseFont: cleanNoSlash,
    subtype: identity.subtype,
    embedded: identity.embedded,
    reason: "no-embedded-font-data",
  };
}