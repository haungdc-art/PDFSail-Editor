/**
 * export-raw-cid-font.ts — M7.8-033 RAW-CID Native Replay
 *
 * 目标：把 affected neighbor 的「原嵌入字体 + 逐 glyph 真实 CID(pdfCharCode)」原样写回 PDF，
 *       不经 Unicode→CID 映射（provenance 已证 unicode≠CID，如 'a'=68 非 97）。
 *
 * 边界（M7.8-033 允许层）：
 *   仅本模块 + export-renderer 消费方。
 *   禁止：font.encodeText(unicode)、page.drawText(unicode)、Unicode→CID 反推、subset 重定向、re-embed。
 *
 * 关键决策（来自 replay 实测）：
 *   pdf-lib 的 embedFont(bytes,{subset:false}) 会【重排 CID→GID 映射】，导致原始 pdfCharCode 在该新字体中无效
 *   → pdfjs paintChar 崩溃。因此**不重新嵌入**，而是直接引用原 PDF 中已存在的嵌入字体资源
 *   （copyPages 后该字体仍在目标页 /Resources/Font 下，键即 fontIdentity.fontRef 如 "/FT8"）。
 *   逐 glyph 用其真实 pdfTransform 作为 Tm（Tf=1，矩阵即真相），<cidHex> Tj 直发真实 CID。
 *
 * 机制：
 *   - x/y 直接来自 pdfTransform[4]/[5]（NativeReplayGlyph.x / y），不重新累积 advance。
 *   - cidHex 由 pdfCharCode 直出 2 字节（Identity-H 大端），不走 Unicode。
 */
import { PDFOperator, PDFOperatorNames, PDFHexString, type PDFPage } from "pdf-lib";
import type { TransformMatrix } from "./types";

/** 真实 CID → 2 字节 Identity-H hex（大端，padStart 4 位）。 */
export function cidToHexString(cid: number): string {
  return cid.toString(16).padStart(4, "0");
}

export interface RawCidGlyph {
  /** 真实字体 CID（来自 metrics.pdfCharCode） */
  cid: number;
  /** 完整原生变换矩阵（pdfTransform），[a,b,c,d,e,f] 已含 fontSize 缩放 + 平移 */
  transform: TransformMatrix;
}

function trimNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * 把一组 glyph 以 RAW-CID 方式写回 page（每 glyph 单独 BT…ET）。
 * 字体直接用原 PDF 已有资源名 fontRef（如 "FT8"），不重新嵌入。
 * @param page     目标页（原嵌入字体已在其 /Resources/Font 下）
 * @param fontRef  原字体资源名（如 "FT8"，不含前导 /）
 * @param glyphs   逐 glyph {cid, transform}
 */
export function emitRawCidGlyphs(page: PDFPage, fontRef: string, glyphs: RawCidGlyph[]): void {
  const key = fontRef.replace(/^\//, "");
  for (const g of glyphs) {
    const [a, b, c, d, e, f] = g.transform;
    const hex = cidToHexString(g.cid);
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, [`/${key}`, "1"]),
      PDFOperator.of(PDFOperatorNames.SetTextMatrix, [
        trimNum(a), trimNum(b), trimNum(c), trimNum(d), trimNum(e), trimNum(f),
      ]),
      PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of(hex)]),
      PDFOperator.of(PDFOperatorNames.EndText),
    );
  }
}

/**
 * M7.8-034 Phase C: Native Text Run —— 用原嵌入字体回放一个**文本块（Tj/TJ）**。
 *
 * 这是 Phase C 的正确粒度，原因（由 M7.8-034 实测证明）：
 *   EditableGlyph 是**字符**粒度，但其 metrics.pdfTransform 是**文本块**粒度 ——
 *   同一 Tj 块内所有字符共享同一个 pdfTransform（实测 "Engraving" 9 个字符的
 *   pdfTransform[4] 恒为 61.20）。块内字符的相对位置由**字体自身的 CID 宽度**推进，
 *   并不体现在 pdfTransform 里。
 *
 * 因此正确写法是：一个块发一次 Tj，块内 CID 序列交给字体推进。
 * 若错误地逐字符发 Tm + 累积 advance，则：
 *   · advance 只能取 Widths 表的 DW（实测恒为 0.5），与真实字宽不符；
 *   · 误差逐字符累积（实测最大 87.2pt），整行被压缩/拉伸。
 *
 * 附带好处：完全不需要 advance 数据，也就不会因 Widths 表缺失而失败。
 */
export function emitNativeTextRun(
  page: PDFPage,
  fontRef: string,
  base: TransformMatrix,
  hex: string,
  /**
   * 原 PDF 的文本状态（来自 glyph.metrics）。
   * 由于本函数用 Tf=1、由 Tm 携带 fontSize 缩放，charSpacing / wordSpacing 必须
   * **除以 fontSize** 才能等价（它们在文本空间里会被 Tm 再放大一次）。
   */
  textState?: {
    charSpacing?: number;
    wordSpacing?: number;
    horizontalScale?: number;
    fontSize?: number;
  },
  /**
   * M7.8-041-FIX-INVIS：显式填充色（0..1）。
   * 本函数不改动其它图形状态，若调用前图形状态残留白色填充（如原 PDF 末笔为白底/白块），
   * 重放文字会画成「白底白字」→ 整行文字凭空消失。必须显式设填充色确保可见。
   * 缺省不设置（保持旧行为），调用方（原生重放）应传入编辑行文字色。
   */
  fillColor?: { r: number; g: number; b: number },
): void {
  const key = fontRef.replace(/^\//, "");
  const [a, b, c, d, e, f] = base;
  const fs = textState?.fontSize ?? Math.hypot(a, b) ?? 1;
  const ops: PDFOperator[] = [];
  if (fillColor) {
    ops.push(
      PDFOperator.of(PDFOperatorNames.NonStrokingColorRgb, [
        trimNum(Math.max(0, Math.min(1, fillColor.r))),
        trimNum(Math.max(0, Math.min(1, fillColor.g))),
        trimNum(Math.max(0, Math.min(1, fillColor.b))),
      ]),
    );
  }
  ops.push(
    PDFOperator.of(PDFOperatorNames.BeginText),
    PDFOperator.of(PDFOperatorNames.SetFontAndSize, [`/${key}`, "1"]),
  );
  const ts = textState;
  if (ts?.charSpacing !== undefined && Number.isFinite(ts.charSpacing) && ts.charSpacing !== 0) {
    ops.push(PDFOperator.of(PDFOperatorNames.SetCharacterSpacing, [trimNum(ts.charSpacing / fs)]));
  }
  if (ts?.wordSpacing !== undefined && Number.isFinite(ts.wordSpacing) && ts.wordSpacing !== 0) {
    ops.push(PDFOperator.of(PDFOperatorNames.SetWordSpacing, [trimNum(ts.wordSpacing / fs)]));
  }
  if (
    ts?.horizontalScale !== undefined &&
    Number.isFinite(ts.horizontalScale) &&
    Math.abs(ts.horizontalScale - 1) > 1e-6
  ) {
    // Tz 的单位是百分比
    ops.push(PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [trimNum(ts.horizontalScale * 100)]));
  }
  ops.push(
    PDFOperator.of(PDFOperatorNames.SetTextMatrix, [
      trimNum(a), trimNum(b), trimNum(c), trimNum(d), trimNum(e), trimNum(f),
    ]),
    PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of(hex)]),
    PDFOperator.of(PDFOperatorNames.EndText),
  );
  page.pushOperators(...ops);
}

/**
 * M7.8-034 Phase C: Native Line Rebuild —— 用**原嵌入字体**重建整行（含被编辑的字符）。
 *
 * 与 emitRawCidGlyphs 的区别：
 *   emitRawCidGlyphs：每个 glyph 用**自己原有的** pdfTransform（只能回放未修改的行）。
 *   本函数：只给一个行首基准 transform，逐 glyph 按 **native trueAdvance** 累积推进
 *           e/f 平移分量。因此被修改、被插入、被删除后的行也能用原字体精确重建，
 *           文本长度自然变化而不会改变字体、字号、旋转或 baseline。
 *
 * 不变量（与 M7.8-033 一致）：
 *   - 直接引用原 PDF 的嵌入字体资源（fontRef），不重新嵌入、不 subset、不改 CID→GID。
 *   - Tf 恒为 1，Tm 即真相（矩阵已含 fontSize 缩放、旋转、倾斜、平移）。
 *   - a/b/c/d 完全沿用行首基准（字号/旋转/倾斜不变）；只有 e/f 按 advance 推进。
 *   - baseline 不变：f 分量只在有旋转（b≠0）时随 advance 变化，否则恒等于基准 baseline。
 *
 * @param page    目标页
 * @param fontRef 原字体资源名（如 "FT8"，含或不含前导 / 均可）
 * @param base    行首基准 transform [a, b, c, d, e, f]（取自本行原 glyph 的 pdfTransform）
 * @param glyphs  逐 glyph { hex, advance }
 *                  hex     = 该字符在原字体中的码位 hex（由 PageCidCodec.encodeHex 提供，
 *                            1 字节（simple font）或 2 字节（Type0/Identity-H）均正确）
 *                  advance = 该字符的 native trueAdvance（**fontSize=1 单位**，PDF pt）
 */
export interface NativeRebuildGlyph {
  hex: string;
  advance: number;
}

export function emitNativeLineGlyphs(
  page: PDFPage,
  fontRef: string,
  base: TransformMatrix,
  glyphs: NativeRebuildGlyph[],
): void {
  const key = fontRef.replace(/^\//, "");
  const [a, b, c, d, e0, f0] = base;
  let accAdv = 0;
  for (const g of glyphs) {
    // 沿文字方向（a, b）推进 advance；无旋转时 b=0 → f 恒为 baseline（不漂移）
    const e = e0 + accAdv * a;
    const f = f0 + accAdv * b;
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, [`/${key}`, "1"]),
      PDFOperator.of(PDFOperatorNames.SetTextMatrix, [
        trimNum(a), trimNum(b), trimNum(c), trimNum(d), trimNum(e), trimNum(f),
      ]),
      PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of(g.hex)]),
      PDFOperator.of(PDFOperatorNames.EndText),
    );
    accAdv += g.advance;
  }
}
