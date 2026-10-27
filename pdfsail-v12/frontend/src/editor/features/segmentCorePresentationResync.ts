/**
 * F3B-6.28-F（第六刀阶段 2 · 路线 A）—— segments 呈现态随 Core Document 重放同步
 *
 * 背景（阶段 1 消费者调查）：
 *   · Core-owned blur 链 `handleSegmentChange` 写 `editedSegments[segEditKey(原文)] = newText`
 *     + `seg.text = newText`（单调累积 replay）；Core **成功**提交路径不触碰 segments；
 *     ⇒ Core undo/redo 后 replay 状态滞留 ⇒ ① segment-mask 白矩滞盖原文（行空白）
 *     ② 翻页重建回放 **复活已撤销编辑**。
 *
 * 语义（对每个 segment，按既有身份关系解析，绝不猜）：
 *   1. `coreParagraphIdForLineId(document, s.source.lineId)` 解析归属段落；
 *      解析失败 ⇒ **原样保留**（fail-open，不误删 replay 条目）。
 *   2. **段落已回到导入期文本**（`originTextOf(pid) === paraText`，origin = 导入期快照）：
 *      · `seg.text ← s.originalText`（**逐成员恢复切片原文** —— 安全：originalText
 *        未被 Core-owned 路径改写；修正版：不把整段文本写进切片成员）；
 *      · 移除 replay 条目（`segEditKey(s)`，存在才删）。
 *   3. **段落处于编辑态**（undo 到中间态 / redo）—— 仅按既有 binding 身份关系写：
 *      · `carriesWhole(pid, s.id)`（整段面承载者，既有 `domSurfaceCarriesWholeParagraph`）
 *        ⇒ `text ← paraText`、条目值 = paraText；
 *      · 否则 `sliceText(ownership, paraText, s.id)`（既有 `sliceTextFor`）非 null
 *        ⇒ `text ← slice`、条目值 = slice；
 *      · 均不可用 ⇒ **不动**（fail-open：切片面中间态的精确同步超出本刀，如实留档）。
 *
 * 绝不修改：`originalText`（replay key 依赖）、ledger、export safety-net、PDFCanvas。
 * 幂等：无变化返回同一引用。
 *
 * 已知边界（如实记录）：Legacy fallback 提交过的 segment 其条目 key（旧 originalText）
 * 与 `segEditKey(当前 s)` 不匹配 ⇒ 本原语不可见 ⇒ 保持原状（与既有行为一致，无回归）。
 */
import type { Segment } from "../../editor-engine/types";
import type { EditorDocument } from "../core/document/types";
import {
  coreParagraphIdForLineId,
  coreSegmentTextOf,
} from "../binding/core-segment-text-projection";
import { paragraphTextOf } from "../binding/paragraph-offset-core-target";

export interface SegmentPresentationResyncDeps {
  /** 必须与写入/回放使用同一 key 函数（= `segEditKey`） */
  keyOf: (s: Segment) => string;
  /** 就地更新的 replay store（= useSelection 的 `editedSegmentsRef.current`） */
  editedSegments: Map<string, string>;
  /** 既有 binding 身份关系（A 方案整段面承载者判定）；缺省 ⇒ 编辑态段落 fail-open 不动 */
  carriesWhole?: (segmentId: string, paragraphId: string) => boolean;
  /** 既有 `sliceTextFor` 的注入封装；返回 null ⇒ 不动 */
  sliceText?: (segmentId: string, paragraphId: string, paragraphText: string) => string | null;
}

export interface SegmentPresentationResyncSummary {
  segmentsChanged: number;
  entriesRemoved: number;
  entriesUpdated: number;
  failOpenSkipped: number;
}

export interface SegmentPresentationResyncResult {
  /** 无变化时返回**同一引用**（幂等） */
  segments: Segment[];
  summary: SegmentPresentationResyncSummary;
}

/** 导入期段落文本（paragraphId → text）；origin 缺省 ⇒ 编辑态判定退化为 fail-open */
function originParagraphTexts(origin: EditorDocument | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!origin) return map;
  for (const page of origin.pages ?? []) {
    for (const object of page.objects ?? []) {
      if (object.type !== "text") continue;
      for (const paragraph of object.paragraphs ?? []) {
        map.set(paragraph.id, (paragraph.runs ?? []).map((r: { text: string }) => r.text).join(""));
      }
    }
  }
  return map;
}

export function resyncSegmentsPresentationToCore(
  segments: readonly Segment[],
  document: EditorDocument | null | undefined,
  deps: SegmentPresentationResyncDeps & { originDocument?: EditorDocument | null },
): SegmentPresentationResyncResult {
  const summary: SegmentPresentationResyncSummary = {
    segmentsChanged: 0,
    entriesRemoved: 0,
    entriesUpdated: 0,
    failOpenSkipped: 0,
  };
  if (!document) return { segments: segments as Segment[], summary };
  const originTexts = originParagraphTexts(deps.originDocument);

  // F3B-6.28-H（第八刀）：稳定身份兜底 —— 段落作用域内的 segment 成员计数。
  // 作用域 = 本次重同步的 segments 数组（同文档同页：一个 lineId 的全部成员都在同一页
  // 数组中；跨文档由 clearSegmentEdits 隔离）。成员数 = 1 ⇒ 该 segment 必然承载整段，
  // 可作为 carriesWhole（DOM 表面判定）在 undo 后失效时的**稳定兜底**；
  // 成员数 > 1 ⇒ 仍走 sliceText / fail-open（不猜切片、不跨成员写整段文本）。
  const memberCountByLine = new Map<string, number>();
  for (const s of segments) {
    const lid = s.source?.lineId;
    if (!lid) continue;
    memberCountByLine.set(lid, (memberCountByLine.get(lid) ?? 0) + 1);
  }

  let changed = false;
  const next = segments.map((s): Segment => {
    const lineId = s.source?.lineId;
    if (!lineId) {
      summary.failOpenSkipped += 1;
      return s;
    }
    // 归属解析（F3B-6.28-I · 第九刀）：Core 文档优先；**编辑态回退 origin** ——
    // 整行替换后段落 runs 全为 generated（无 source.lineId）⇒ Core 侧解析必然失败；
    // origin 快照的 runs 恒为 pdf-native 且 paragraphId 跨 undo/redo 稳定
    // （第四刀分类器已依赖该不变量）。**只回退身份，不回退文本** —— paraText 始终取自
    // Core 文档（下方 paragraphTextOf(document, ...)）。两者都解析失败 ⇒ fail-open。
    const paragraphId =
      coreParagraphIdForLineId(document, lineId) ??
      (deps.originDocument ? coreParagraphIdForLineId(deps.originDocument, lineId) : null);
    if (!paragraphId) {
      summary.failOpenSkipped += 1;
      return s;
    }
    const paraText = paragraphTextOf(document, paragraphId);
    if (paraText === null || paraText === undefined) {
      summary.failOpenSkipped += 1;
      return s;
    }
    const key = deps.keyOf(s);
    const originText = originTexts.get(paragraphId);
    const atOrigin = originText !== undefined && originText === paraText;

    if (atOrigin) {
      // 段落已回到导入期文本 ⇒ 逐成员恢复切片原文 + 移除 replay 条目
      if (deps.editedSegments.delete(key)) summary.entriesRemoved += 1;
      if (s.text !== s.originalText) {
        summary.segmentsChanged += 1;
        changed = true;
        return { ...s, text: s.originalText };
      }
      return s;
    }

    // 编辑态段落（中间态 / redo）：仅按既有身份关系写
    // 优先级（F3B-6.28-H 裁决）：carriesWhole（DOM 快路径）⇒ 单成员稳定身份兜底 ⇒
    // sliceText（range ownership）⇒ fail-open。
    const isSingleMember = (memberCountByLine.get(lineId) ?? 0) === 1;
    if (deps.carriesWhole?.(s.id, paragraphId) || isSingleMember) {
      if (deps.editedSegments.get(key) !== paraText) {
        deps.editedSegments.set(key, paraText);
        summary.entriesUpdated += 1;
      }
      if (s.text !== paraText) {
        summary.segmentsChanged += 1;
        changed = true;
        return { ...s, text: paraText };
      }
      return s;
    }
    const slice = deps.sliceText?.(s.id, paragraphId, paraText) ?? null;
    if (slice !== null && deps.editedSegments.has(key)) {
      if (deps.editedSegments.get(key) !== slice) {
        deps.editedSegments.set(key, slice);
        summary.entriesUpdated += 1;
      }
      if (s.text !== slice) {
        summary.segmentsChanged += 1;
        changed = true;
        return { ...s, text: slice };
      }
      return s;
    }
    // fail-open：身份关系不可用 ⇒ 不猜、不动（条目也保留）
    summary.failOpenSkipped += 1;
    return s;
  });
  return { segments: changed ? next : (segments as Segment[]), summary };
}

// 保留阶段 1 引用（coreSegmentTextOf 供外部一致性检查；本文件主逻辑走 paraText 路径）
void coreSegmentTextOf;
