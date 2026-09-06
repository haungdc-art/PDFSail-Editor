/**
 * export-cid-font.ts — M7.5-005E-B · CID Font Mapping
 *
 * 目标：把 005D（CID bytes + Type0 结构 + ToUnicode）+ 005E-A（FontFile2 + FontDescriptor）
 *       真正连接成完整可消费的 Type0/CIDFontType2 字体资源：
 *           Unicode → CID（Identity-H hex，005D）
 *           CID → GID（/CIDToGIDMap）
 *           CID → advance（/W 宽度表，源自嵌入字体真实度量）
 *
 * 实现：用 pdf-lib 子集嵌入生成复合字体（自动产出 /DescendantFonts[0]=CIDFontType2、
 *       /CIDToGIDMap、/W、FontDescriptor/FontFile2、/ToUnicode），再读回结构供审计，
 *       并提供 005D 的 CID 运算子装配（Tm 保真复用 005C）。
 *
 * 边界（005E-B 允许层）：
 *   仅本模块 + 验收脚本；不做 Content Stream 替换 / 删除旧文本对象 / mask 移除（005E-C）。
 */
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFRef,
  type PDFFont,
} from "pdf-lib";
import type { ResolvedFont } from "./export-font-resolver";
import { composeCidTextRun } from "./export-cid-writer";
import { readEmbeddedFontDescriptor, type FontDescriptorMetrics } from "./export-font-assembly";
import type { TransformMatrix } from "./types";
import type { GlyphPlacement } from "./export-matrix-writer";

/** CID 字体结构审计结果 */
export interface CidFontStructure {
  type0: {
    subtype: string | undefined;
    encoding: string | undefined;
    hasToUnicode: boolean;
    descendantFontCount: number;
  };
  cidFont: {
    subtype: string | undefined;
    cidToGidMap: "Identity" | "Stream" | undefined;
    /** /W 中记录的 CID 数 */
    widthCount: number;
    defaultWidth: number | undefined;
  };
  descriptor: FontDescriptorMetrics;
  embeddedFormat: "FontFile2" | "FontFile3" | undefined;
}

/** 装配结果 */
export interface CidFontAssembled {
  font: PDFFont;
  baseFont: string;
  resourceName: string;
  /** 结构审计信息；仅当 materialize=true 时可用 */
  structure?: CidFontStructure;
  /** CID（Identity-H hex）→ advance（1000-em）；仅当 materialize=true 时可用 */
  widthsCidToAdvance?: Map<number, number>;
  /** 文本 → CID hex（Identity-H UTF-16BE） */
  textHex: (text: string) => string;
  /** 文本 → CID Text Run 运算子（复用 005C/005D） */
  runOperators: (placement: GlyphPlacement, text: string) => string;
}

function isRef(v: unknown): boolean {
  return !!v && typeof (v as { objectNumber?: unknown }).objectNumber === "number";
}
function deref(obj: unknown, pdf: PDFDocument): unknown | undefined {
  if (!obj) return undefined;
  if (isRef(obj)) {
    const resolved = pdf.context.lookup(obj as PDFRef);
    return resolved === obj ? undefined : resolved;
  }
  return obj;
}

/** 读 CID 字体（DescendantFonts[0]）的 /CIDToGIDMap 与 /W */
function readCidMapping(pdf: PDFDocument, fontRef: PDFFont["ref"]): {
  cidToGidMap: "Identity" | "Stream" | undefined;
  widths: Map<number, number>;
  defaultWidth: number | undefined;
  descendantFontCount: number;
} {
  const fontObj = deref(fontRef, pdf);
  const type0 = fontObj instanceof PDFDict ? fontObj : undefined;
  const dArr = type0 ? deref(type0.get(PDFName.of("DescendantFonts")), pdf) : undefined;
  const cid = dArr instanceof PDFArray && dArr.get(0) !== undefined ? deref(dArr.get(0), pdf) : undefined;
  const cidDict = cid instanceof PDFDict ? cid : undefined;

  let cidToGidMap: "Identity" | "Stream" | undefined;
  if (cidDict) {
    const ctm = cidDict.get(PDFName.of("CIDToGIDMap"));
    if (ctm instanceof PDFName && ctm.asString() === "/Identity") cidToGidMap = "Identity";
    else if (isRef(ctm)) cidToGidMap = "Stream";
  }

  // /W 解析：三种形态 [start [w…]] | [start hi width] | [start count w w …]
  const widths = new Map<number, number>();
  const wRaw = cidDict?.get(PDFName.of("W"));
  const wArr = deref(wRaw, pdf);
  if (wArr instanceof PDFArray) {
    for (let i = 0; i + 1 < wArr.size(); ) {
      const startEl = deref(wArr.get(i), pdf);
      const nextEl = deref(wArr.get(i + 1), pdf);
      if (!(startEl instanceof PDFNumber)) { i++; continue; }
      const start = startEl.asNumber();
      if (nextEl instanceof PDFArray) {
        for (let j = 0; j < nextEl.size(); j++) {
          const w = deref(nextEl.get(j), pdf);
          if (w instanceof PDFNumber) widths.set(start + j, w.asNumber());
        }
        i += 2;
      } else if (nextEl instanceof PDFNumber) {
        // [start hi width] —— 区间 [start, hi] 统一 width
        const hiEl = deref(wArr.get(i + 2), pdf);
        const wEl = deref(wArr.get(i + 3), pdf);
        const hi = hiEl instanceof PDFNumber ? hiEl.asNumber() : start;
        const width = wEl instanceof PDFNumber ? wEl.asNumber() : NaN;
        for (let c = start; c <= hi; c++) widths.set(c, width);
        i += 4;
      } else {
        i++;
      }
    }
  }

  let defaultWidth: number | undefined;
  if (cidDict) {
    const dw = cidDict.get(PDFName.of("DW"));
    if (dw instanceof PDFNumber) defaultWidth = dw.asNumber();
  }

  return {
    cidToGidMap,
    widths,
    defaultWidth,
    descendantFontCount: dArr instanceof PDFArray ? dArr.size() : 0,
  };
}

/**
 * 装配完整 Type0/CIDFontType2 字体资源。
 */
export async function assembleCidFont(
  pdf: PDFDocument,
  resolved: ResolvedFont,
  opts: {
    fontkit: unknown;
    resourceName: string;
    glyphText: string;
    /**
     * true（默认 false）＝跳过内部 save。
     * pdf-lib 的 subset 字体在第一次 save() 物化后，同一 doc 再写内容会导致下一次 save 丢弃该内容。
     * 真实导出（005E-C）须单次 save 写出，故走 noMaterialize=true：embler 只嵌字 + 布局 glyphText，
     * 由调用方写内容/连资源后自行 save 一次；此时不读 structure/widths（审计在可丢弃 doc 上做）。
     */
    noMaterialize?: boolean;
  },
): Promise<CidFontAssembled> {
  if (resolved.source !== "embedded" || !resolved.embeddedData) {
    throw new Error(
      `assembleCidFont requires source=embedded + embeddedData; got source=${resolved.source}${resolved.reason ? ` reason=${resolved.reason}` : ""}`,
    );
  }
  pdf.registerFontkit(opts.fontkit as Parameters<PDFDocument["registerFontkit"]>[0]);
  const fontBytes =
    typeof Buffer !== "undefined" && typeof (Buffer as { from?: unknown }).from === "function"
      ? (Buffer as { from(ab: Uint8Array): Uint8Array }).from(resolved.embeddedData)
      : resolved.embeddedData.slice(0);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  // 关键：subset 嵌入器只子集化「经过布局(glyphCache.access)」的字形。
  // 必须在物化前让 glyphText 的字符过一遍 encodeText，否则 /W 与 /ToUnicode 会为空。
  if (opts.glyphText) font.encodeText(opts.glyphText);

  const textHex = (text: string) =>
    composeCidTextRun({ transform: [1, 0, 0, 1, 0, 0] as TransformMatrix, x: 0, y: 0, fontSize: 1 }, text, opts.resourceName).hex;
  const runOperators = (placement: GlyphPlacement, text: string) =>
    composeCidTextRun(placement, text, opts.resourceName).operators;

  if (opts.noMaterialize) {
    // 真实导出：单次 save 由调用方完成；此处分叉返回，不触发物化、不读结构。
    return { font, baseFont: "", resourceName: opts.resourceName, textHex, runOperators };
  }

  await pdf.save(); // 审计用：物化后读结构（doc 为可丢弃）

  const { descriptor, embeddedFormat } = readEmbeddedFontDescriptor(pdf, font.ref);
  const mapping = readCidMapping(pdf, font.ref);

  // baseFont：取 CIDFont（DescendantFonts[0]）的 /BaseFont
  const fontObj = deref(font.ref, pdf);
  const dArr = fontObj instanceof PDFDict ? deref(fontObj.get(PDFName.of("DescendantFonts")), pdf) : undefined;
  const cid = dArr instanceof PDFArray ? deref(dArr.get(0), pdf) : undefined;
  const baseFont = (() => {
    const bf = cid instanceof PDFDict ? cid.get(PDFName.of("BaseFont")) : undefined;
    return bf instanceof PDFName ? bf.asString().replace(/^\//, "") : "";
  })();

  const topObj = deref(font.ref, pdf);
  const hasToUnicode = topObj instanceof PDFDict ? !!topObj.get(PDFName.of("ToUnicode")) : false;
  const encoding = (() => {
    const e = topObj instanceof PDFDict ? topObj.get(PDFName.of("Encoding")) : undefined;
    return e instanceof PDFName ? e.asString().replace(/^\//, "") : undefined;
  })();
  const subtype = (() => {
    const s = topObj instanceof PDFDict ? topObj.get(PDFName.of("Subtype")) : undefined;
    return s instanceof PDFName ? s.asString().replace(/^\//, "") : undefined;
  })();

  const structure: CidFontStructure = {
    type0: {
      subtype,
      encoding,
      hasToUnicode,
      descendantFontCount: mapping.descendantFontCount,
    },
    cidFont: {
      subtype: (() => {
        const s = cid instanceof PDFDict ? cid.get(PDFName.of("Subtype")) : undefined;
        return s instanceof PDFName ? s.asString().replace(/^\//, "") : undefined;
      })(),
      cidToGidMap: mapping.cidToGidMap,
      widthCount: mapping.widths.size,
      defaultWidth: mapping.defaultWidth,
    },
    descriptor,
    embeddedFormat,
  };

  return {
    font,
    baseFont,
    resourceName: opts.resourceName,
    structure,
    widthsCidToAdvance: mapping.widths,
    textHex,
    runOperators,
  };
}