/**
 * F3B-6.17-3C-6B1.1-P1-C · Operator Provenance 纯计算入口
 *
 * 本模块是 provenance「计算」的**唯一**来源。Legacy adapter（`pdf-importer` 的
 * `assignOperatorProvenance`）与 Sidecar builder（`buildBindingSidecarFromPdfNative`）
 * 都只是 **consumer**：
 *   · Legacy adapter 把结果写回 legacy glyph（glyph.operatorId / glyph.operatorCharIndex）
 *   · Sidecar builder 把预计算结果落到 `OriginalGlyph`
 *
 * 设计约束（纯函数 / Binding 模块）：
 *   · 不 import React / DOM / 旧 renderer / useExport / editor-engine / pdf-lib*；
 *     （`pdfLibDoc` 参数类型经 `Parameters<typeof resolvePageShowTextWithXObjects>` 取得，
 *       不引入 pdf-lib 运行时依赖）
 *   · 不写任何 glyph（`glyph.operatorId` 一律由 consumer 写，本模块只产出 `GlyphProvenance`）；
 *   · `null` = 整页 UNKNOWN（resolve 抛错或 coverage < 0.5 时 fail-closed 整页放弃）；
 *   · 部分匹配即保留已知部分，绝不为未匹配 glyph 猜 operator。
 *
 * 复用既有算法（M7.8-036-FIX-002 / M7.9-BAND-FIX），**不改写**：
 *   Gstr 长文本拼接 + indexOf 文本身份匹配 + 基线带(band-Y)约束
 *   + 算子按 unicodeText 长度降序 + coverage gate（<0.5 整页放弃）。
 */

import { resolvePageShowTextWithXObjects } from "../../document-model/content-stream-resolver";

/** pdf-lib PDFDocument（结构化取得，不命名 pdf-lib 以免引入运行时依赖） */
type PdfLibDoc = Parameters<typeof resolvePageShowTextWithXObjects>[0];

export interface GlyphProvenance {
  operatorId?: string;
  operatorCharIndex?: number;
}

/**
 * 诊断汇出（可选）：供浏览器端复测 / 5C-A1 闭环验证读取，不影响计算语义。
 * 由 `computeOperatorProvenance` 在传入 `opts.diagnostics` 时填充；不传则不产生任何开销。
 */
export interface OperatorProvenanceDiagnostics {
  /** 本页 glyph 数（pageGlyphs.length；0 时也为 0） */
  totalGlyphs: number;
  /** 进入候选的算子数（charCodes !== null 且 unicodeText 非空） */
  totalOps: number;
  /** 实际匹配到的 glyph 字符数（= matchedGlyphs） */
  matchedGlyphs: number;
  /** 被钉死 operatorId 的 glyph 数（claimed = 统计口径，与 legacy glyph.operatorId 一致） */
  claimed: number;
  /** 因「基线带不匹配」被拒绝的候选对齐尝试次数（修复前 Form XObject 局部坐标会爆量） */
  rejectedBand: number;
  /** matchedGlyphs / totalGlyphs（修复前 ≈ 0.089） */
  coverage: number;
  /** 是否 fail-closed 整页放弃（resolve 抛错或 coverage < 0.5） */
  failClosed: boolean;
}

/** 单页 glyph 的扁平行输入（block→line→glyph 文档顺序，索引 i ↔ 结果 i）。 */
export interface GlyphProvenanceInput {
  /** glyph.char（拼接为对齐长文本 G） */
  char?: string | null;
  /** glyph.metrics.pdfTransform（最终 PDF 坐标，供 band-Y 约束；缺失则退化为纯文本匹配） */
  pdfTransform?: readonly number[] | null;
}

/**
 * 计算单页 glyph → operatorId / operatorCharIndex。
 *
 * @param pdfLibDoc 已加载的 pdf-lib PDFDocument（页面流 + Form XObject 递归解析来源）
 * @param pageIndex 0-based 页索引
 * @param pageGlyphs 本页 glyph 的扁平行（索引 i ↔ 结果 i）
 * @returns 与 `pageGlyphs` 等长的数组；`null` = 整页 UNKNOWN（fail-closed）。
 *          未匹配到的 glyph 其 `operatorId` / `operatorCharIndex` 为 `undefined`
 *          （仍属「已知部分缺失」，consumer 据此置 provenanceUnknown）。
 */
export function computeOperatorProvenance(
  pdfLibDoc: PdfLibDoc,
  pageIndex: number,
  pageGlyphs: GlyphProvenanceInput[],
  opts?: { diagnostics?: OperatorProvenanceDiagnostics },
): GlyphProvenance[] | null {
  // 可能抛出（P1-A 诊断已在 Legacy adapter 捕获）——此处不吞异常，保持纯计算语义。
  const records = resolvePageShowTextWithXObjects(pdfLibDoc, pageIndex);
  const glyphs = pageGlyphs;
  if (glyphs.length === 0) {
    if (opts?.diagnostics) {
      Object.assign(opts.diagnostics, {
        totalGlyphs: 0, totalOps: 0, matchedGlyphs: 0, claimed: 0,
        rejectedBand: 0, coverage: 0, failClosed: false,
      });
    }
    return [];
  }

  // M7.8-036-FIX-002 · 内容身份对齐（content-identity alignment）。
  const Gstr = glyphs.map((g) => g.char ?? "").join("");
  const claimed = new Array<boolean>(glyphs.length).fill(false);
  const assigned: GlyphProvenance[] = glyphs.map(() => ({}));
  let matchedGlyphs = 0;

  // 长文本优先匹配，避免短词（如 "de"）被更长算子文本（如 "devedocument..."）抢注后长串失配。
  const ops = records
    .filter((r) => r.charCodes !== null && !!r.unicodeText && r.unicodeText.length > 0)
    .sort((a, b) => b.unicodeText!.length - a.unicodeText!.length);

  // M7.9-BAND-FIX · 基线带约束（band constraint）：高频重复字符（如 "3" / "0" / 空格）
  // 不得跨行/跨带互相抢占，否则本行原算子收集不到（残留重影）且别处被误剥离（内容丢失）。
  const BAND_TOL = 2.5;
  const glyphBandY: (number | undefined)[] = glyphs.map((g) => {
    const pt = g.pdfTransform;
    return Array.isArray(pt) && typeof pt[5] === "number" ? (pt[5] as number) : undefined;
  });

  let rejectedBand = 0;

  for (const r of ops) {
    const U = r.unicodeText!;
    let j = Gstr.indexOf(U, 0);
    while (j >= 0) {
      const end = j + U.length;
      let overlap = false;
      for (let k = j; k < end; k++) {
        if (claimed[k]) { overlap = true; break; }
      }
      // 基线带校验：算子 tmY 已知时，候选 glyph 必须同带（gy 未知则不阻拦，保守放行）。
      let bandOk = true;
      if (r.tmY !== undefined) {
        for (let k = j; k < end; k++) {
          const gy = glyphBandY[k];
          if (gy !== undefined && Math.abs(gy - r.tmY) > BAND_TOL) { bandOk = false; break; }
        }
      }
      if (!overlap && bandOk) {
        for (let k = j; k < end; k++) {
          assigned[k] = { operatorId: r.operatorId, operatorCharIndex: k - j };
          claimed[k] = true;
        }
        matchedGlyphs += U.length;
        break;
      }
      // 非重叠但因 band 不匹配而落空的候选对齐尝试，计入 rejectedBand（诊断用）。
      if (!overlap) rejectedBand += 1;
      j = Gstr.indexOf(U, j + 1);
    }
    // 未命中：该算子不建 provenance（fail-safe，见上方注释）。
  }

  // fail-closed：若整体命中率极低（编码/对齐整体不可信），整页放弃 provenance，
  // 宁可全部保留原文也不在可疑位置删除。
  const coverage = glyphs.length ? matchedGlyphs / glyphs.length : 0;
  const claimedCount = assigned.filter((a) => a.operatorId !== undefined).length;
  if (opts?.diagnostics) {
    Object.assign(opts.diagnostics, {
      totalGlyphs: glyphs.length,
      totalOps: ops.length,
      matchedGlyphs,
      claimed: claimedCount,
      rejectedBand,
      coverage,
      failClosed: coverage < 0.5,
    });
  }
  if (coverage < 0.5) return null;

  return assigned;
}
