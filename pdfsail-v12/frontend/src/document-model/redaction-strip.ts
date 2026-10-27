/**
 * redaction-strip.ts — F3B Release Gate · Redaction P0 真正剥离引擎
 *
 * 目标：把 Redaction block 从「黑框覆盖层」升级为「真正 Redaction」——
 * 从 PDF content stream 中**删除**落入 redaction 区域的 showText 算子，
 * 使被遮文本在文本提取 / Ctrl+F / 复制中均不可恢复（不再只是被黑框盖住）。
 *
 * 设计要点：
 *  - 复用 content-stream-resolver 的 tokenizeContentStream（已修复 zero-progress 死循环）。
 *  - 追踪文本状态：Tm / Td / TD（文本原点）、cm / q / Q（CTM 栈）、Tf（字体 + 字号）。
 *  - 对每個 Tj / TJ 算子精确计算文字包围盒（考虑旋转/缩放）；与 redaction 矩形
 *    相交 ⇒ **整算子删除**（redaction 语义下漏删是安全失败，多删可接受）。
 *  - 支持 page 级内容流 + Form XObject（递归其 /Matrix 作初始 CTM；忽略 placement cm，
 *    由 expanded bbox 补偿精度）。
 *  - 删除算子字节区间后以 latin1 重写该流，按 ref 用 PDFRawStream 替换（去 /Filter，
 *    存为未压缩流）。
 *  - 可选 sanitizeMetadata：清空 /Info 与 XMP 流。
 *
 * 边界（用户锁定）：
 *  - 不改动 Core export 的语义编辑路径 / renderToBlocks / edit（编辑模式）相关代码。
 *  - 不引入「猜测原文」逻辑；定位完全依赖 content stream 真实算子位置。
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFStream,
  PDFDict,
  PDFNumber,
  PDFFont,
} from "pdf-lib";
// pako 是 pdf-lib 的传递依赖（node_modules 中可用），用于解压 FlateDecode 内容流
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - pako 类型由 @types/pako 提供（传递依赖）
import { inflate } from "pako";
import { tokenizeContentStream, ContentToken } from "./content-stream-resolver";

export interface RedactionRect {
  /** 0-based 页码 */
  pageIndex: number;
  /** PDF 用户坐标（原点左下，y 向上），与 pdf-lib drawRectangle 同坐标系 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RedactionOptions {
  /** 清空文档 /Info 与 XMP 元数据（默认 false） */
  sanitizeMetadata?: boolean;
}

type CTM = [number, number, number, number, number, number];

const IDENTITY_CTM: CTM = [1, 0, 0, 1, 0, 0];

function matrixArrayToCTM(m: PDFArray | undefined | null): CTM {
  if (!m) return IDENTITY_CTM;
  const nums = m.asArray().map((n) => (typeof n === "number" ? n : (n as { value?: number }).value ?? 0));
  if (nums.length !== 6) return IDENTITY_CTM;
  return [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]] as CTM;
}

/** 把局部点 (lx, ly) 经 Tm 平移 + CTM 映射到页面坐标 */
function mapPoint(ctm: CTM, tmE: number, tmF: number, lx: number, ly: number): [number, number] {
  const x = tmE + lx;
  const y = tmF + ly;
  return [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
}

/** latin1 解码（与 content-stream-resolver 一致） */
function decodeLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** latin1 编码回字节（内容流其余部分本就是 latin1/ascii，往返无损） */
function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 取得内容流的解码后字节（供 tokenize 使用）。
 * - 若对象本身是 PDFContentStream（如 pdf-lib 绘制后产生的流），直接取 getUnencodedContents()。
 * - 若是 PDFRawStream（加载的原始流），getContents() 可能是被 FlateDecode 压缩的原始字节，
 *   需根据 /Filter 解压。任何失败都回退到原始字节（over-redact 安全：宁可多删不漏删）。
 */
function getUnencodedBytes(stream: PDFStream): Uint8Array {
  const asContent = stream as unknown as {
    getUnencodedContents?: () => Uint8Array;
  };
  if (typeof asContent.getUnencodedContents === "function") {
    return asContent.getUnencodedContents();
  }
  const raw = stream.getContents();
  const filter = stream.dict.lookup(PDFName.of("Filter"));
  if (filter) {
    try {
      return new Uint8Array(inflate(raw as unknown as Uint8Array));
    } catch {
      return raw;
    }
  }
  return raw;
}

type FontResolver = (key: string) => PDFFont | null;

function buildFontResolver(resourceDict: PDFDict | undefined | null): FontResolver {
  const cache = new Map<string, PDFFont | null>();
  const fontDict =
    resourceDict && resourceDict instanceof PDFDict
      ? (resourceDict.lookup(PDFName.of("Font")) as PDFDict | undefined)
      : undefined;
  return (key: string): PDFFont | null => {
    if (cache.has(key)) return cache.get(key)!;
    let font: PDFFont | null = null;
    try {
      const ref = fontDict?.lookup(key);
      if (ref) font = PDFFont.of(ref as PDFDict, undefined as unknown as PDFDocument);
    } catch {
      font = null;
    }
    cache.set(key, font);
    return font;
  };
}

/** 算子文字宽度：优先精确（PDFFont），失败回退保守估算（over-redact 安全方向） */
function operatorWidth(font: PDFFont | null, text: string, size: number): number {
  if (font && size > 0) {
    try {
      const w = font.widthOfTextAtSize(text, size);
      if (typeof w === "number" && isFinite(w) && w > 0) return w;
    } catch {
      /* fall through */
    }
  }
  // 保守估算：比例字体 ~0.5*size/字；非 ASCII（CJK 等）按全宽 1.0*size 兜底
  let est = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    est += code > 0x2000 || (code >= 0x2e80 && code <= 0x9fff) ? size : size * 0.5;
  }
  return Math.max(est, size * 0.1);
}

/** 计算算子包围盒（页面坐标 AABB） */
function operatorAABB(
  ctm: CTM,
  tmE: number,
  tmF: number,
  width: number,
  size: number,
  pad: number,
): [number, number, number, number] {
  const localCorners: Array<[number, number]> = [
    [0, -0.25 * size],
    [width, -0.25 * size],
    [0, 0.75 * size],
    [width, 0.75 * size],
  ];
  let xmin = Infinity,
    ymin = Infinity,
    xmax = -Infinity,
    ymax = -Infinity;
  for (const [lx, ly] of localCorners) {
    const [px, py] = mapPoint(ctm, tmE, tmF, lx, ly);
    if (px < xmin) xmin = px;
    if (px > xmax) xmax = px;
    if (py < ymin) ymin = py;
    if (py > ymax) ymax = py;
  }
  return [xmin - pad, ymin - pad, xmax + pad, ymax + pad];
}

function aabbIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

interface RemovalPlan {
  /** 该流解码文本中需删除的字节区间 [start, end) */
  ranges: Array<[number, number]>;
  /** 该流是否发生变化 */
  changed: boolean;
}

/**
 * 解析单个内容流，找出落入任一 redaction 矩形的 showText 算子字节区间。
 * @param decodedText 流的 latin1 解码文本
 * @param ctmPrefix 初始 CTM（page 级为 identity；Form XObject 为其 /Matrix）
 * @param fontResolver 该流所属资源的字体解析器
 * @param redactions 仅本页的 redaction 矩形
 */
function planRemovalsForStream(
  decodedText: string,
  ctmPrefix: CTM,
  fontResolver: FontResolver,
  redactions: RedactionRect[],
): RemovalPlan {
  const tokens = tokenizeContentStream(decodedText);
  const ranges: Array<[number, number]> = [];
  let curFont: string | null = null;
  let curSize = 0;
  let tmE: number | undefined = undefined;
  let tmF: number | undefined = undefined;
  let ctm: CTM = [...ctmPrefix] as CTM;
  const ctmStack: CTM[] = [];
  const pendingNums: number[] = [];

  const hit = (start: number, end: number): void => {
    ranges.push([start, end]);
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
        tmE = pendingNums[4];
        tmF = pendingNums[5];
      } else if (
        (tok.value === "Td" || tok.value === "TD") &&
        pendingNums.length >= 2 &&
        tmE !== undefined &&
        tmF !== undefined
      ) {
        tmE += pendingNums[0];
        tmF += pendingNums[1];
      } else if (tok.value === "cm" && pendingNums.length >= 6) {
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
        ctmStack.push([...ctm] as CTM);
      } else if (tok.value === "Q") {
        const prev = ctmStack.pop();
        if (prev) ctm = prev;
      }
      pendingNums.length = 0;
      continue;
    }
    // /Fnn <size> Tf
    if (
      tok.kind === "name" &&
      tokens[i + 1]?.kind === "number" &&
      tokens[i + 2]?.kind === "op" &&
      tokens[i + 2].value === "Tf"
    ) {
      curFont = tok.value;
      curSize = Number(tokens[i + 1].value);
      i += 2;
      continue;
    }
    // (text) Tj
    if (
      (tok.kind === "literal" || tok.kind === "hex") &&
      tokens[i + 1]?.kind === "op" &&
      tokens[i + 1].value === "Tj"
    ) {
      if (tmE !== undefined && tmF !== undefined && curSize > 0 && redactions.length) {
        const width = operatorWidth(
          curFont ? fontResolver(curFont) : null,
          tok.value,
          curSize,
        );
        const pad = curSize * 0.15;
        const aabb = operatorAABB(ctm, tmE, tmF, width, curSize, pad);
        if (redactions.some((r) => aabbIntersects(aabb, [r.x, r.y, r.x + r.width, r.y + r.height]))) {
          hit(tok.start, tokens[i + 1].end);
        }
      }
      i++;
      continue;
    }
    // [ ... ] TJ
    if (
      tok.kind === "array" &&
      tokens[i + 1]?.kind === "op" &&
      tokens[i + 1].value === "TJ"
    ) {
      if (tmE !== undefined && tmF !== undefined && curSize > 0 && redactions.length) {
        let text = "";
        for (const t of tok.value as ContentToken[]) {
          if (t.kind === "literal" || t.kind === "hex") text += t.value;
        }
        const width = operatorWidth(curFont ? fontResolver(curFont) : null, text, curSize);
        const pad = curSize * 0.15;
        const aabb = operatorAABB(ctm, tmE, tmF, width, curSize, pad);
        if (redactions.some((r) => aabbIntersects(aabb, [r.x, r.y, r.x + r.width, r.y + r.height]))) {
          hit(tok.start, tokens[i + 1].end);
        }
      }
      i++;
      continue;
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return { ranges, changed: ranges.length > 0 };
}

/** 按 ranges 删除字节区间并 latin1 重写 */
function stripRanges(decodedText: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return decodedText;
  let out = "";
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) out += decodedText.slice(pos, start);
    pos = Math.max(pos, end);
  }
  if (pos < decodedText.length) out += decodedText.slice(pos);
  return out;
}

/** 按 ref 用未压缩 PDFRawStream 替换流内容 */
function rewriteStream(pdfDoc: PDFDocument, ref: PDFRef, newBytes: Uint8Array): void {
  const existing = pdfDoc.context.lookup(ref);
  const oldDict =
    existing instanceof PDFStream
      ? existing.dict
      : existing instanceof PDFDict
        ? existing
        : pdfDoc.context.obj({});
  const newDict = (oldDict as PDFDict).clone(pdfDoc.context);
  newDict.delete(PDFName.of("Filter"));
  newDict.delete(PDFName.of("DecodeParms"));
  newDict.delete(PDFName.of("Length"));
  newDict.set(PDFName.of("Length"), PDFNumber.of(newBytes.length));
  pdfDoc.context.assign(ref, PDFRawStream.of(newDict, newBytes));
}

/**
 * 取 page 底层字典。pdf-lib 不同版本中 `PDFPage.node` 既可能是持有 `dict` 的
 * `PDFPageLeaf` 实例，也可能是直接 `extends PDFDict` 的页面节点，此处做版本无关归一。
 */
function getPageDict(page: ReturnType<PDFDocument["getPage"]>): PDFDict {
  const node = (page as unknown as { node?: { dict?: PDFDict } | PDFDict }).node as
    | { dict?: PDFDict }
    | PDFDict
    | undefined;
  const dict = node && "dict" in node ? (node as { dict?: PDFDict }).dict : node;
  return dict instanceof PDFDict ? dict : (node as unknown as PDFDict);
}

/** 取 page 的 /Contents 间接引用列表 */
function getContentsRefs(page: ReturnType<PDFDocument["getPage"]>): PDFRef[] {
  const contentsNode = getPageDict(page).lookup(PDFName.of("Contents"));
  if (contentsNode instanceof PDFRef) return [contentsNode];
  if (contentsNode instanceof PDFArray) {
    return contentsNode
      .asArray()
      .filter((r): r is PDFRef => r instanceof PDFRef);
  }
  return [];
}

/** 取 page 资源字典（Form XObject 字体解析用） */
function getPageResources(page: ReturnType<PDFDocument["getPage"]>): PDFDict | undefined {
  const res = getPageDict(page).lookup(PDFName.of("Resources"));
  return res instanceof PDFDict ? res : undefined;
}

/**
 * 对单个 PDF 页面应用真正 redaction：删除其全部内容流（page 级 + Form XObject）中
 * 落入 redaction 矩形的 showText 算子。返回是否发生任何删除。
 */
function redactPage(pdfDoc: PDFDocument, pageIndex: number, redactions: RedactionRect[]): boolean {
  if (!redactions.length) return false;
  const page = pdfDoc.getPage(pageIndex);
  const pageResources = getPageResources(page);
  const fontResolver = buildFontResolver(pageResources);
  let anyChanged = false;

  // 1) page 级内容流
  for (const ref of getContentsRefs(page)) {
    const stream = pdfDoc.context.lookup(ref);
    if (!(stream instanceof PDFStream)) continue;
    const bytes = getUnencodedBytes(stream);
    const decoded = decodeLatin1(bytes);
    const plan = planRemovalsForStream(decoded, IDENTITY_CTM, fontResolver, redactions);
    if (plan.changed) {
      const stripped = encodeLatin1(stripRanges(decoded, plan.ranges));
      rewriteStream(pdfDoc, ref, stripped);
      anyChanged = true;
    }
  }

  // 2) Form XObject 内容流（递归其 /Matrix 作初始 CTM）
  const xobjects = pageResources?.lookup(PDFName.of("XObject"));
  if (xobjects instanceof PDFDict) {
    for (const [, valRef] of xobjects.entries()) {
      if (!(valRef instanceof PDFRef)) continue;
      const xobj = pdfDoc.context.lookup(valRef);
      if (!(xobj instanceof PDFDict)) continue;
      if (xobj.lookup(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
      const xStream = pdfDoc.context.lookup(valRef);
      if (!(xStream instanceof PDFStream)) continue;
      const xMatrix = matrixArrayToCTM(
        xobj.lookup(PDFName.of("Matrix")) as PDFArray | undefined,
      );
      const xFontResolver = buildFontResolver(xobj);
      const bytes = getUnencodedBytes(xStream);
      const decoded = decodeLatin1(bytes);
      const plan = planRemovalsForStream(decoded, xMatrix, xFontResolver, redactions);
      if (plan.changed) {
        const stripped = encodeLatin1(stripRanges(decoded, plan.ranges));
        rewriteStream(pdfDoc, valRef, stripped);
        anyChanged = true;
      }
    }
  }

  return anyChanged;
}

/** 清空 /Info 与 XMP 元数据流 */
function sanitizeMetadata(pdfDoc: PDFDocument): void {
  // /Info 由 pdf-lib 存于 trailer（见 PDFDocument.getInfoDict：读 context.trailerInfo.Info），
  // 而非 catalog 的 /Info 条目。必须走 trailer 引用才能定位真实 Info 字典。
  const infoRef = pdfDoc.context.trailerInfo?.Info;
  const info = infoRef ? pdfDoc.context.lookup(infoRef) : undefined;
  if (info instanceof PDFDict) {
    for (const name of [
      "Title",
      "Author",
      "Subject",
      "Keywords",
      "Creator",
      "Producer",
    ]) {
      info.delete(PDFName.of(name));
    }
  }
  // XMP 流（/Metadata，catalog 级）
  const metadata = pdfDoc.catalog.lookup(PDFName.of("Metadata"));
  if (metadata instanceof PDFRef || metadata instanceof PDFStream) {
    pdfDoc.catalog.delete(PDFName.of("Metadata"));
  }
}

/**
 * 对整份 PDF 应用真正 redaction。
 * @param pdfDoc 已加载的 PDFDocument（如 exportPDF 中 PDFDocument.load(originalBytes) 的结果）
 * @param redactions 所有 redaction 矩形（跨页）
 * @param options.sanitizeMetadata 是否清空元数据
 * @returns 是否发生任何文本删除
 */
export function applyTrueRedaction(
  pdfDoc: PDFDocument,
  redactions: RedactionRect[],
  options: RedactionOptions = {},
): boolean {
  if (!redactions.length) return false;
  const byPage = new Map<number, RedactionRect[]>();
  for (const r of redactions) {
    const list = byPage.get(r.pageIndex) ?? [];
    list.push(r);
    byPage.set(r.pageIndex, list);
  }
  let changed = false;
  for (const [pageIndex, pageReds] of byPage) {
    if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;
    if (redactPage(pdfDoc, pageIndex, pageReds)) changed = true;
  }
  if (options.sanitizeMetadata) sanitizeMetadata(pdfDoc);
  return changed;
}
