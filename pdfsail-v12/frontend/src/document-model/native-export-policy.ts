/**
 * native-export-policy.ts — M7.5-005E-C2B-2C-3C · Native First Export Policy
 *
 * 目标：把 default export 从「总是 mask 旧文字 + overlay 新文字」升级为「Native First」：
 *
 *   if nativeReplacementState.ready:
 *       改写原 Tj/TJ（applyNativeBatchReplace → 写回 content stream）
 *       + 不画 mask / 不 overlay
 *   else:
 *       legacy overlay（mask 遮盖 + 重绘）
 *
 * 三层：
 *   - decideBlockNativeExport(): 每 block / 每 line 的导出决策（native-rewrite | legacy-overlay）
 *   - buildNativeExportPlan():   收集全部 native-ready line → BatchNativeReplaceRun[]（一次批替换）
 *   - exportDocumentNativeFirst():行级编排：native rewrite → 写回 → 仅对 legacy 行做 overlay
 *
 * 范围（3C 允许层）：
 *   ✅ export policy / export-router / export-renderer（复用 writeExportCommandsToPDF）
 *   ✅ native routing policy + fallback decision
 *   ❌ 不改 Mutation / TextOperation / Undo / Selection / Layout
 *
 * 原子性：buildNativeExportPlan 只产出「真正 native-ready」的 run；批替换任一失败 → 不写回，
 *         该批对应的 glyph 因仍 ready=true 会由 C2B-2C-2 过滤掉 overlay —— 因此失败时本层
 *         直接把该批标记为回退（见 applySuccessfulRewrite fallback 语义），避免丢失文字。
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
} from "pdf-lib";
import {
  renderDocumentToExportCommands,
  writeExportCommandsToPDF,
  ensureIndirectPageContents,
  type ExportContext,
} from "./export-renderer";
import { applyNativeBatchReplace, type BatchNativeReplaceRun } from "./native-batch-replace";
import { deriveNativeRoutingFromBlock, nativeLineKey } from "./native-export-router";
import { buildPageCidCodec } from "./pdf-font-metrics";
import type { EditableDocument, EditableBlock } from "./types";

export type NativeExportDecision = "native-rewrite" | "legacy-overlay";

export interface LineExportDecision {
  lineIndex: number;
  decision: NativeExportDecision;
}

export interface BlockExportDecision {
  blockId: string;
  blockDecision: NativeExportDecision;
  lines: LineExportDecision[];
}

/** 读取 block 内容流文本（字节对齐，供 writeBack 判断/审计） */
export interface NativeExportPlan {
  /** 需 native rewrite 的 batch run（一次性原子替换） */
  runs: BatchNativeReplaceRun[];
}

/**
 * block 级导出决策（纯函数）。逐 line 判定：
 *   - line native-ready（单 bindingId + all-ready）→ native-rewrite
 *   - 否则 → legacy-overlay
 * 不做「整个 block 强制 native」（Case3 混合 block 的行级语义）。
 */
export function decideBlockNativeExport(block: EditableBlock): BlockExportDecision {
  const routing = deriveNativeRoutingFromBlock(block);
  const lines: LineExportDecision[] = (block.lines || []).map((_, li) => ({
    lineIndex: li,
    decision:
      routing.replacedLines.has(nativeLineKey(block.id, li)) ||
      routing.fullyReplacedBlocks.has(block.id)
        ? "native-rewrite"
        : "legacy-overlay",
  }));
  return {
    blockId: block.id,
    blockDecision: routing.fullyReplacedBlocks.has(block.id) ? "native-rewrite" : "legacy-overlay",
    lines,
  };
}

/**
 * 从文档编辑态构建 native rewrite 计划（纯函数）。
 * 只收集「整行 all-ready + 同 bindingId」的 native-ready line。
 * originalText/replacementText 取自 binding 携带的单一事实源（nativeReplacementState.originalText/replacementText），
 * 缺失时回退到 glyph.originalChar/char 拼接（仅适用于 length 不变替换；见 glyph-mapping 对 originalChar 的写入语义）。
 */
export function buildNativeExportPlan(doc: EditableDocument): NativeExportPlan {
  const runs: BatchNativeReplaceRun[] = [];
  doc.pages.forEach((page, pageIdx) => {
    for (const block of page.blocks) {
      if (block.type !== "text") continue;
      const routing = deriveNativeRoutingFromBlock(block);
      block.lines.forEach((line, li) => {
        const isNative =
          routing.replacedLines.has(nativeLineKey(block.id, li)) ||
          routing.fullyReplacedBlocks.has(block.id);
        if (!isNative || line.glyphs.length === 0) return;
        const st = line.glyphs[0].nativeReplacementState;
        // M7.8-022A: native rewrite 的 originalText 必须来自 binding 单一事实源
        // （nativeReplacementState.originalText，由 attemptNativeReplaceForLine 成功时写入）。
        // 缺失时**不得**回退 glyph.originalChar 拼接 —— 该拼接长度 = 编辑后 glyph 数，
        // 对「长度变化」的替换无法还原原 PDF 文本（见 types.ts 对 originalText 的注释）。
        // 用它去匹配原 PDF 的 Tj/TJ 算子（r.operatorText === group.originalText）会
        // not-found 或命中错误算子 → 原文残留 + 新文字错位/换行（用户报告现象）。
        // 缺 binding 时跳过该 run → 该行走 overlay（mask + 重绘），视觉可控。
        if (!st?.originalText) {
          if (typeof console !== "undefined") {
            console.log(
              `[M7.8-022A][NATIVE_SKIP] blockId=${block.id} lineIndex=${li} ` +
                `reason="no-binding-originalText" → fallback overlay ` +
                `(glyphCount=${line.glyphs.length})`,
              "color:#f59e0b;",
            );
          }
          return;
        }
        const replText = st?.replacementText ?? line.glyphs.map((g) => g.char).join("");
        // M7.8-022A: 长度变化的替换禁用 native rewrite，强制走 overlay。
        // 根因：composeReplacementOperator（replace-text-operator.ts）会把 TJ 重建为
        //   单元素数组 `[(全文)] TJ`，原 PDF TJ 数组中的字距调整（kerning）数字全部丢失；
        //   长度变化还会使后续字形横向累积偏移 → 视觉"换行/下移/占位"（用户报告现象）。
        // 等长替换才能保持算子结构与字距保真；长度变化改用 overlay
        // （mask + 逐 glyph 重绘，几何由 glyph.bbox 精确控制）。
        if (st.originalText.length !== replText.length) {
          if (typeof console !== "undefined") {
            console.log(
              `[M7.8-022A][NATIVE_SKIP] blockId=${block.id} lineIndex=${li} ` +
                `reason="length-changed" → fallback overlay ` +
                `(origLen=${st.originalText.length} replLen=${replText.length})`,
              "color:#f59e0b;",
            );
          }
          return;
        }
        runs.push({
          blockId: block.id,
          lineIndex: li,
          pageIndex: pageIdx,
          glyphStart: 0,
          glyphEnd: line.glyphs.length - 1,
          bindingId: st?.bindingId ?? block.id,
          originalText: st.originalText,
          replacementText: replText,
        });
      });
    }
  });
  return { runs };
}

/**
 * 把 applyNativeBatchReplace 产出）更新后的内容流文本写回页面 Contents
 * （保留未命中流原对象引用；命中流用新 flate stream 替换）。
 */
function writeBackPageStreams(
  pdf: PDFDocument,
  pageIndex: number,
  streams: ReadonlyMap<number, string>,
): void {
  const page = pdf.getPage(pageIndex) as any;
  const ctx: PDFContext = page.doc?.context;
  if (!ctx) return;
  const enc = new TextEncoder();
  const cn = page.node.Contents?.();
  if (!cn) return;
  const deref = (v: unknown): unknown => (v instanceof PDFRef ? ctx.lookup?.(v) : v);
  const orig: { raw: unknown; obj: unknown }[] = [];
  if (cn instanceof PDFArray) {
    cn.asArray().forEach((x) => orig.push({ raw: x, obj: deref(x) }));
  } else {
    orig.push({ raw: cn, obj: deref(cn) });
  }
  const arr: unknown[] = orig.map((entry, i) => {
    if (!streams.has(i)) {
      // 未命中流：保留原条目引用。M7.8-042-FIX：entry.obj 是解引用后的**流对象**，
      // 直接放进 /Contents 数组会写成「直接流对象」（非法 PDF）→ 整页空白。
      // 原条目本身就是 PDFRef 时原样返回；若不幸是直接流，先 register 变间接对象。
      if (entry.raw instanceof PDFRef) return entry.raw;
      const obj = entry.obj;
      return obj instanceof PDFRawStream || obj instanceof PDFStream
        ? ctx.register(obj)
        : obj;
    }
    // 流必须是间接对象（ISO 32000-1 §7.3.8）；flateStream 返回未注册流，
    // 必须 register 取 PDFRef 才能以间接引用写入 /Contents（否则内联流 → Adobe 判损坏）。
    const s = ctx.flateStream(enc.encode(streams.get(i)!));
    return ctx.register(s);
  });
  page.node.set(PDFName.of("Contents"), arr.length === 1 ? arr[0] : ctx.obj(arr));
}

export interface NativeFirstExportOptions {
  /** 原始 PDF 字节（Overlay 来源；native rewrite 在其上改写） */
  originalBytes: ArrayBuffer;
  doc: EditableDocument;
  /** 目标页码（0-based） */
  pageIndex: number;
  renderScale: number;
  cssScale: number;
  signatureRegions?: Parameters<typeof renderDocumentToExportCommands>[2];
  /** M7.7-006: 编辑态真实墨迹覆盖盒（lineId → CSS bbox），供 overlay 行 mask 覆盖真实墨迹。 */
  editedLineBoxes?: Parameters<typeof renderDocumentToExportCommands>[3];
}

/** M7.7-004A：剥离全部 native ready 态（返回新 doc，不修改输入）——供 native rewrite 失败时整批回退 overlay，保证文字不丢 */
export function stripNativeReadyState(doc: EditableDocument): EditableDocument {
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => ({
        ...block,
        lines: block.lines.map((line) => ({
          ...line,
          glyphs: line.glyphs.map((g) =>
            g.nativeReplacementState ? { ...g, nativeReplacementState: { ...g.nativeReplacementState, ready: false } } : g,
          ),
        })),
      })),
    })),
  };
}

/**
 * Native First Export 编排（行级）：
 *   1) native-rewrite 行 → applyNativeBatchReplace（ToUnicode CID codec）→ 成功写回，失败整批回退 overlay
 *   2) 仅对 legacy 行画 overlay（mask + 重绘）
 *   3) 保存
 */
export async function exportDocumentNativeFirst(
  options: NativeFirstExportOptions,
): Promise<Uint8Array> {
  const { originalBytes, doc, renderScale, cssScale, signatureRegions, editedLineBoxes } = options;
  const pdf = await PDFDocument.load(originalBytes);
  // M7.8-042-FIX：导入即归一化 —— /Contents 必须是间接引用（见 export-renderer 同名函数说明）。
  ensureIndirectPageContents(pdf);

  // 1) native rewrite（按页分组，逐页带 ToUnicode CID codec）
  const plan = buildNativeExportPlan(doc);
  let rewriteFailed = false;
  if (plan.runs.length > 0) {
    const byPage = new Map<number, BatchNativeReplaceRun[]>();
    for (const run of plan.runs) {
      const p = run.pageIndex ?? 0;
      const arr = byPage.get(p) || [];
      arr.push(run);
      byPage.set(p, arr);
    }
    for (const [pageIndex, runs] of byPage) {
      const codec = buildPageCidCodec(pdf, pageIndex);
      const res = applyNativeBatchReplace(pdf, pageIndex, runs, codec ?? undefined);
      if (res.success && res.streams.size > 0) {
        writeBackPageStreams(pdf, pageIndex, res.streams);
      } else {
        // 批替换失败：整批回退 overlay（不写回，后续仍按编辑态 overlay，避免丢文字）
        rewriteFailed = true;
        break;
      }
    }
  }

  // 2) overlay（renderDocumentToExportCommands 已按 C2B-2C-2 过滤 native-ready 行；
  //    rewrite 失败的批这里保留 overlay 作为安全回退）
  const ctx: ExportContext = {
    renderScale,
    cssScale,
    pageHeightPt: (doc.pages[0]?.height ?? 792) / (renderScale * cssScale),
  };
  // M7.7-004A：rewrite 失败 → 剥离 native ready，避免「native rewrite 失败 + overlay 被短路」导致文字丢失
  const renderDoc = rewriteFailed ? stripNativeReadyState(doc) : doc;
  const commands = renderDocumentToExportCommands(renderDoc, ctx, signatureRegions, editedLineBoxes);
  await writeExportCommandsToPDF(pdf, commands, (idx) => {
    const p = doc.pages[idx];
    return p ? p.height / (renderScale * cssScale) : 842;
  });

  // M7.8-042-FIX：保存前兜底 —— /Contents 必须为间接引用（流不能是直接对象）。
  ensureIndirectPageContents(pdf);

  return await pdf.save();
}
