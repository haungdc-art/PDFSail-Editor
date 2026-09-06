/**
 * export-font-assembly.ts — M7.5-005E-A · Font Assembly
 *
 * 目标：把 005B ResolvedFont.embeddedData 真正装入 PDF：
 *       → /FontFile2（TrueType）或 /FontFile3（CFF/OpenType）
 *       → /FontDescriptor（Ascent / Descent / CapHeight / FontBBox / ItalicAngle / StemV / Flags）
 *
 * 设计：
 *   - 换新文档嵌入（embedFont），不触碰原 PDF 对象（005E-C 才做交换/替换）。
 *   - fontkit 由调用方注入（@param fontkit）：本模块不硬依赖打包 fontkit，
 *     只有真正装配嵌入字体才需要它（与 registerFontkit 边界一致）。
 *   - 嵌入后从字体对象读回 FontDescriptor 度量，供审计 / telemetry / 后续 005E-B /W。
 *
 * 边界（005E-A 允许层）：
 *   仅本模块 + 验收脚本；不做 CID title mapping / /W / Content Stream 替换
 *   （分别是 005E-B / 005E-B / 005E-C）。
 */
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  type PDFFont,
} from "pdf-lib";
import type { ResolvedFont } from "./export-font-resolver";

/** FontDescriptor 关键度量 */
export interface FontDescriptorMetrics {
  fontName?: string;
  ascent?: number;
  descent?: number;
  capHeight?: number;
  italicAngle?: number;
  stemV?: number;
  flags?: number;
  fontBBox?: [number, number, number, number];
  /** 是否含 /FontFile /FontFile2 /FontFile3 之一 */
  embedded: boolean;
}

/** 装配结果 */
export interface AssembledFont {
  font: PDFFont;
  /** subset：是否走了 pdf-lib 子集化嵌入 */
  subset: boolean;
  /** 嵌入流类型（/FontFile2 | /FontFile3 | undefined） */
  embeddedFormat: "FontFile2" | "FontFile3" | undefined;
  descriptor: FontDescriptorMetrics;
  /** 装配所用的原始 embeddedData（字节数） */
  embeddedDataLength: number;
}

/** 解引用（PDFDict 或 PDFRef） → 对象 */
function deref(
  obj: unknown,
  pdf: PDFDocument,
): unknown | undefined {
  if (!obj) return undefined;
  if (isRef(obj)) {
    const resolved = pdf.context.lookup(obj);
    return resolved === obj ? undefined : resolved;
  }
  if (obj instanceof PDFDict || obj instanceof PDFArray || obj instanceof PDFNumber) return obj;
  return obj;
}

function isRef(v: unknown): boolean {
  return !!v && typeof (v as { objectNumber?: unknown }).objectNumber === "number";
}

/** 读一个 PDFDict 的数值 key */
function numOf(dict: PDFDict | undefined, key: string): number | undefined {
  if (!dict) return undefined;
  const v = dict.get(PDFName.of(key));
  if (v instanceof PDFNumber) return v.asNumber();
  return undefined;
}

/** 读 /FontBBox LLX LLY URX URY */
function bboxOf(dict: PDFDict | undefined, pdf: PDFDocument): [number, number, number, number] | undefined {
  if (!dict) return undefined;
  const arr = dict.get(PDFName.of("FontBBox"));
  const a = deref(arr, pdf);
  if (!(a instanceof PDFArray)) return undefined;
  const n = (idx: number) => {
    const v = a.get(idx);
    return v instanceof PDFNumber ? v.asNumber() : NaN;
  };
  const bx = [n(0), n(1), n(2), n(3)];
  if (bx.some((x) => Number.isNaN(x))) return undefined;
  return [bx[0], bx[1], bx[2], bx[3]];
}

/** 从已嵌入的字体对象读出 FontDescriptor 度量 + 嵌入流类型 */
export function readEmbeddedFontDescriptor(pdf: PDFDocument, fontRef: PDFFont["ref"]): {
  descriptor: FontDescriptorMetrics;
  embeddedFormat: "FontFile2" | "FontFile3" | undefined;
} {
  const fontObj = deref(fontRef, pdf);
  if (!(fontObj instanceof PDFDict)) {
    return { descriptor: { embedded: false }, embeddedFormat: undefined };
  }

  // 两种承载态：
  //   1) 简单字体：/FontDescriptor 直接在字体 dict
  //   2) 复合字体（Type0/CID，pdf-lib 对 sfnt 常生成）：/DescendantFonts[0]（CIDFont）→ /FontDescriptor
  let desc: PDFDict | undefined;
  const directDesc = deref(fontObj.get(PDFName.of("FontDescriptor")), pdf);
  if (directDesc instanceof PDFDict) {
    desc = directDesc;
  } else {
    const dArr = deref(fontObj.get(PDFName.of("DescendantFonts")), pdf);
    if (dArr instanceof PDFArray) {
      const first = deref(dArr.get(0), pdf);
      if (first instanceof PDFDict) {
        const nestedDesc = deref(first.get(PDFName.of("FontDescriptor")), pdf);
        if (nestedDesc instanceof PDFDict) desc = nestedDesc;
      }
    }
  }

  let embeddedFormat: "FontFile2" | "FontFile3" | undefined = undefined;
  let embedded = false;
  if (desc) {
    const file2 = desc.get(PDFName.of("FontFile2"));
    if (file2) { embedded = true; embeddedFormat = "FontFile2"; }
    const file3 = desc.get(PDFName.of("FontFile3"));
    if (file3) { embedded = true; embeddedFormat = "FontFile3"; }
    if (!file2 && !file3 && desc.get(PDFName.of("FontFile"))) embedded = true;
  }

  const descriptor: FontDescriptorMetrics = {
    fontName: (() => {
      const n = desc?.get(PDFName.of("FontName"));
      return n instanceof PDFName ? n.asString().replace(/^\//, "") : undefined;
    })(),
    ascent: numOf(desc, "Ascent"),
    descent: numOf(desc, "Descent"),
    capHeight: numOf(desc, "CapHeight"),
    italicAngle: numOf(desc, "ItalicAngle"),
    stemV: numOf(desc, "StemV"),
    flags: numOf(desc, "Flags"),
    fontBBox: bboxOf(desc, pdf),
    embedded,
  };
  return { descriptor, embeddedFormat };
}

/**
 * 把 ResolvedFont.embeddedData 装配成真实嵌入字体。
 * @throws 若 ResolvedFont 非 embedded 或无 embeddedData → 明确报错（不静默 fallback）。
 */
export async function assembleEmbeddedFont(
  pdf: PDFDocument,
  resolved: ResolvedFont,
  opts: {
    fontkit: unknown;
    subset?: boolean;
  },
): Promise<AssembledFont> {
  if (resolved.source !== "embedded" || !resolved.embeddedData) {
    throw new Error(
      `assembleEmbeddedFont requires source=embedded + embeddedData; got source=${resolved.source}${resolved.reason ? ` reason=${resolved.reason}` : ""}`,
    );
  }

  pdf.registerFontkit(opts.fontkit as Parameters<PDFDocument["registerFontkit"]>[0]);
  // fontkit 的 TTFFont.probe 用 buffer.toString('ascii',0,4) 探测 → 需要 Buffer（裸 Uint8Array 无
  // toString 编码，探测会失败）。运行时守卫：Node 环境取 Buffer；浏览器回退原字节。
  const fontBytes =
    typeof Buffer !== "undefined" && typeof (Buffer as { from?: unknown }).from === "function"
      ? (Buffer as { from(ab: Uint8Array): Uint8Array }).from(resolved.embeddedData)
      : resolved.embeddedData.slice(0);
  const font = await pdf.embedFont(fontBytes, {
    subset: opts.subset ?? false,
  });
  // pdf-lib 的字体嵌入对象是懒物化（embedder 在 save 时才写入 context）。
  // 触发保存以把 Font/FontDescriptor/FontFile2 物化进 context，才能读回度量。
  await pdf.save();
  const { descriptor, embeddedFormat } = readEmbeddedFontDescriptor(pdf, font.ref);

  return {
    font,
    subset: !!opts.subset,
    embeddedFormat,
    descriptor,
    embeddedDataLength: resolved.embeddedData.length,
  };
}

/** 装配完保存字节后的 /BaseFont 名（子集化时带 "XXXXXX+" 前缀） */
export function readBaseFont(pdf: PDFDocument, fontRef: PDFFont["ref"]): string | undefined {
  const fontObj = deref(fontRef, pdf);
  if (!(fontObj instanceof PDFDict)) return undefined;
  const n = fontObj.get(PDFName.of("BaseFont"));
  return n instanceof PDFName ? n.asString().replace(/^\//, "") : undefined;
}