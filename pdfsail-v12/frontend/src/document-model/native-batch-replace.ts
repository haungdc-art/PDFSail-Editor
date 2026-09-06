/**
 * native-batch-replace.ts — M7.5-005E-C2B-2C-3B · Multi Glyph Batch Native Replace
 *
 * 目标：把「多 glyph / 一句一整段」的编辑从「逐 glyph binding → 多个 patch」升级为：
 *   OriginalTextBindingGroup（run）
 *        │  originalText（原始算子整文本）
 *        ▼
 *   Binding Group Resolver（resolveBoundRun：run → 唯一 ResolvedTextObject）
 *        ▼
 *   single Tj/TJ replacement（一次 patch，覆盖 run 内全部 glyph）
 *
 * 原子性（关键）：
 *   - 一批 run 要么全部 native 成功，要么整批回退 overlay，绝不允许部分 native（避免 PDF 重复文字）。
 *   - 任一 run 出现：歧义（同一文本多算子）、未命中、跨多算子（originalText 不是单个算子整文本）、patch 失败
 *     → 整批 success=false，保留原内容流，不产生任何 nativeReplacementState。
 *
 * 范围（3B 允许层）：
 *   ✅ 绑定组 resolver（新增本模块）
 *   ✅ 复用 replace-text-operator.ts（replaceTextOperator → 单算子 patch）
 *   ✅ 复用 content-stream-resolver.ts（extractShowTextRecords / ResolvedTextObject）
 *   ✅ 产出 NativeReplacementTarget（native-replacement-state.ts 类型）供 producer 落盘
 *   ❌ 不改 Mutation / Undo / Selection / Renderer
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import {
  extractShowTextRecords,
  type ResolvedTextObject,
  type ShowTextExtractOptions,
} from "./content-stream-resolver";
import { replaceTextOperator, type TextOperatorKind } from "./replace-text-operator";
import type { NativeReplacementTarget } from "./native-replacement-state";
import { buildPageCidCodec, type PageCidCodec } from "./pdf-font-metrics";

/** 一个待 batch 替换的 run（覆盖 line 上一段连续 glyph，对应 PDF 中单个 Tj/TJ 算子） */
export interface BatchNativeReplaceRun {
  blockId: string;
  lineIndex: number;
  /** 目标页码（0-based，可选；缺省 0） */
  pageIndex?: number;
  /** 参与该 run 的 glyph 区间（含两端） */
  glyphStart: number;
  glyphEnd: number;
  /** 原始算子整文本（须与 PDF 内容流中某个算子整文本精确相等，才判为「整算子替换」） */
  originalText: string;
  /** 替换文本 */
  replacementText: string;
  /** 编码模式：simple=literal，cid=hex；缺省按 replacement 推断 */
  kind?: TextOperatorKind;
}

export type BatchFailReason =
  | "resolve-not-found" // 原文未命中任何算子的整文本（如仅改算子的一部分 → 拒绝，避免拆分算子）
  | "resolve-ambiguous" // 同一原文出现在多个算子/流 → 歧义拒绑
  | "patch-fail" // 安全补丁失败（checksum / round-trip / fail-safe）
  | "empty-run"; // 空区间

export interface BatchNativeReplaceResult {
  success: boolean;
  /** 失败原因（success=false 时） */
  reason?: BatchFailReason;
  /** 失败命中的 run 信息（审计） */
  failedRun?: { originalText: string };
  /** 更新后的内容流文本（streamIndex → text）；与 pdf 无关，供调用方写回 / 校验 */
  streams: ReadonlyMap<number, string>;
  /** 全部成功时，供 producer 落盘的 native targets（整 run ready:true） */
  targets: NativeReplacementTarget[];
  /** 每个 run 绑定分配的自增 bindingId（审计/落盘） */
  bindingIds: string[];
}

/**
 * Binding Group Resolver（纯函数，针对单个 content stream 文本）。
 *
 * 将 run 解析为「该流中唯一、整算子匹配」的 ResolvedTextObject：
 *   - operatorText === group.originalText 且唯一 → { ok:true, resolved }（整算子替换）。
 *   - 0 个 -> { ok:false, reason:"not-found" }（未命中 / 部分算子）。
 *   - >1 个 -> { ok:false, reason:"ambiguous" }（同流内歧义）。
 */
export function resolveBoundRun(
  workingText: string,
  streamObjRef: string,
  streamIndex: number,
  group: BatchNativeReplaceRun,
  extractOpts?: ShowTextExtractOptions,
): { ok: true; resolved: ResolvedTextObject } | { ok: false; reason: "not-found" | "ambiguous" } {
  const records = extractShowTextRecords(workingText, streamObjRef, streamIndex, extractOpts);
  const candidates = records.filter((r) => r.operatorText === group.originalText);
  if (candidates.length === 0) return { ok: false, reason: "not-found" };
  if (candidates.length > 1) return { ok: false, reason: "ambiguous" };
  const c = candidates[0];
  return {
    ok: true,
    resolved: {
      pageIndex: 0,
      contentStreamRef: { objectId: c.streamObjRef },
      streamIndex: c.streamIndex,
      operatorIndex: c.sequentia,
      operator: { op: c.op, raw: c.operatorText },
      fontResource: { resourceName: c.fontResourceKey, objectRef: null },
      byteStart: c.byteStart,
      byteEnd: c.byteEnd,
    },
  };
}

/** 解码页面全部内容流为文本（latin1，字节对齐） */
function decodePageStreams(doc: PDFDocument, pageIndex: number): { streams: string[]; refs: string[] } {
  const page = doc.getPage(pageIndex) as any;
  const streams: string[] = [];
  const refs: string[] = [];
  const contentsNode = page.node.Contents?.();
  if (!contentsNode) return { streams, refs };
  const deref = (v: unknown): unknown => (v instanceof PDFRef ? page.doc?.context?.lookup?.(v) : v);
  const decode = (s: unknown): string => {
    if (s instanceof PDFRawStream || s instanceof PDFStream) {
      try {
        const b = (decodePDFRawStream(s as PDFRawStream) as { getBytes(): Uint8Array }).getBytes();
        return new TextDecoder("latin1").decode(b);
      } catch {
        return new TextDecoder("latin1").decode(new Uint8Array((s as { getContents(): Uint8Array }).getContents?.() ?? []));
      }
    }
    return "";
  };
  if (contentsNode instanceof PDFArray) {
    contentsNode.asArray().forEach((item, i) => {
      const obj = deref(item);
      streams.push(decode(obj));
      refs.push(item instanceof PDFRef ? item.toString() : String(i));
    });
  } else {
    streams.push(decode(deref(contentsNode)));
    refs.push(contentsNode instanceof PDFRef ? contentsNode.toString() : "embedded");
  }
  return { streams, refs };
}

/**
 * 主入口：批量替换一个或多个 run → 全部成功返回 targets + 更新流，任一失败整批回退。
 *
 * 用法（edit commit 后）：
 *   const result = applyNativeBatchReplace(pdf, pageIndex, runs);
 *   if (result.success) {
 *     produced = applyNativeReplacementResult(produced, result.targets);
 *     // …… 用 result.streams 覆盖对应 content stream，save()
 *   } else {
 *     // 什么都不改 → 原有 overlay fallback
 *   }
 */
export function applyNativeBatchReplace(
  pdf: PDFDocument,
  pageIndex: number,
  runs: BatchNativeReplaceRun[],
  /** M7.7-004A：ToUnicode 感知的 CID 编解码器（可选；提供时 hex 算子用 CID→Unicode 匹配、Unicode→CID 编码替换） */
  codec?: PageCidCodec,
): BatchNativeReplaceResult {
  if (runs.length === 0) return { success: false, reason: "empty-run", streams: new Map(), targets: [], bindingIds: [] };

  const { streams, refs } = decodePageStreams(pdf, pageIndex);
  const working = streams.slice(); // 每 stream 独立工作副本
  const targets: NativeReplacementTarget[] = [];
  const bindingIds: string[] = [];
  let bindingSeq = 0;
  const extractOpts: ShowTextExtractOptions | undefined = codec ? { hexDecode: codec.decodeHex } : undefined;

  for (const run of runs) {
    if (run.glyphStart < 0 || run.glyphEnd < run.glyphStart) {
      return fail(run, "empty-run");
    }
    // 跨流聚合：同流内歧义 / 多流各一命中 → ambiguous；零命中 → not-found；唯一 → 使用
    const matchStreams: number[] = [];
    let ambiguousInStream = false;
    for (let si = 0; si < working.length; si++) {
      const res = resolveBoundRun(working[si], refs[si], si, run, extractOpts);
      if (res.ok) matchStreams.push(si);
      else if (res.reason === "ambiguous") ambiguousInStream = true;
    }
    if (ambiguousInStream || matchStreams.length > 1) return fail(run, "resolve-ambiguous", { streams: working });
    if (matchStreams.length === 0) return fail(run, "resolve-not-found", { streams: working });

    const hitStream = matchStreams[0];
    const ri = resolveBoundRun(working[hitStream], refs[hitStream], hitStream, run, extractOpts)!;
    if (!ri.ok) return fail(run, ri.reason, { streams: working });
    const rep = replaceTextOperator({
      resolved: ri.resolved,
      streamText: working[hitStream],
      replacement: run.replacementText,
      kind: run.kind ?? (codec ? "cid" : undefined),
      cidEncode: codec?.encodeHex,
    });
    if (!rep) return fail(run, "patch-fail", { streams: working });

    working[hitStream] = rep.contentText;
    targets.push({
      blockId: run.blockId,
      lineIndex: run.lineIndex,
      pageIndex: run.pageIndex ?? pageIndex,
      glyphStart: run.glyphStart,
      glyphEnd: run.glyphEnd,
      bindingId: `bn-${pageIndex}-${bindingSeq++}`,
      ready: true,
      originalText: run.originalText,
      replacementText: run.replacementText,
    });
    bindingIds.push(`bn-${pageIndex}-${bindingSeq - 1}`);
  }

  const streamMap = new Map<number, string>();
  working.forEach((t, i) => streamMap.set(i, t));
  return { success: true, streams: streamMap, targets, bindingIds };
}

function fail(
  run: BatchNativeReplaceRun,
  reason: BatchFailReason,
  ctx?: { streams?: string[] },
): BatchNativeReplaceResult {
  const streamMap = new Map<number, string>();
  ctx?.streams?.forEach((t, i) => streamMap.set(i, t));
  return { success: false, reason, failedRun: { originalText: run.originalText }, streams: streamMap, targets: [], bindingIds: [] };
}

/**
 * M7.7-004A · edit-commit 异步验证助手。
 *
 * 用法（onTextEditSave 提交后）：
 *   const r = await attemptNativeReplaceForLine(pdfBytes, pageIndex, run);
 *   if (r.success) produced = applyNativeReplacementResult(produced, r.targets); // 标记 nativeReady
 *   else → 不标记 → Export 走 overlay fallback（不破坏）。
 *
 * 说明：这里只做「验证 + 产出 targets」，不写回 PDF（原始字节不变）；
 *      真正的 stream 写回发生在 Export 侧 exportDocumentNativeFirst（同 codec，幂等）。
 */
export async function attemptNativeReplaceForLine(
  originalBytes: ArrayBuffer,
  pageIndex: number,
  run: BatchNativeReplaceRun,
): Promise<{ success: boolean; targets: NativeReplacementTarget[]; reason?: BatchFailReason }> {
  const pdf = await PDFDocument.load(originalBytes);
  const codec = buildPageCidCodec(pdf, pageIndex);
  const res = applyNativeBatchReplace(pdf, pageIndex, [run], codec ?? undefined);
  return { success: res.success, targets: res.targets, reason: res.reason };
}