/**
 * F3B-6.13 — Core → Binding Reconciliation Shadow Path（纯函数层）
 *
 * ── 本轮边界（6.13-E）────────────────────────────────────────────────
 *   · **不**改 `markLineEdited` / mask 算法 / `editedLineBoxes` / renderer / export
 *   · **不**改 Core Command / Core History
 *   · **不**把 Sidecar 写入 `EditorDocument`
 *   · **不**删除 legacy reconciliation
 *   · **production consumer = 0**：本模块只产出数据，不产生任何渲染副作用
 *
 * ── 职责分工（冻结）──────────────────────────────────────────────────
 *   Sidecar      = immutable original truth（原始几何 / provenance）
 *   Core Layout  = current geometry
 *   History      = 编辑当前是否生效（recompute / remove）
 *   Renderer     = presentation
 */

import type { BBox } from "../../document-model/types";
import type { EditorDocument } from "../core/document/types";
import {
  lookupBlockBinding,
  lookupGlyphRange,
  lookupLineBinding,
  type BindingSidecar,
  type OriginalGlyph,
  type SidecarRenderSource,
} from "./binding-sidecar";

// ─────────────────────────────────────────────────────────────────────
//  6.13-A：Affected Line Extraction
// ─────────────────────────────────────────────────────────────────────

/** 回退来源里允许读取的 run 形状（只取行身份，绝不触碰 glyph 索引以外的字段） */
interface RunSourceView {
  source?: { blockId?: string; lineId?: string; lineIdx?: number };
}

export interface AffectedBindingLine {
  blockId: string;
  lineId: string;
  /** import-time 行序（命中首个 run 的 lineIdx） */
  lineIdx?: number;
}

export interface ExtractAffectedInput {
  /** Core command 执行**之后**的 document */
  document: EditorDocument;
  /** `CommandResult.affectedTextBoxes` / `EditorCommand.affectedTextBoxes` */
  affectedTextBoxes?: readonly string[];
  /** `CommandResult.affectedParagraphs` / `EditorCommand.affectedParagraphs` */
  affectedParagraphs?: readonly string[];
  /**
   * F3B-6.28：**同一事务的 before document**（仅用于受影响行身份回退）。
   *
   * 背景（阶段 1 实测）：整行替换/清空后，受影响段落在 after 文档中只剩
   * `{kind:"generated"}` run（无 source）⇒ 本函数返回 0 ⇒ 6.14 reconciliation
   * 以 `no-affected-lines` 退出 ⇒ `editedLineBoxes` 为空 ⇒ 屏幕原文不被遮盖。
   *
   * 回退规则（6.13 冻结契约：被替换 run 的行身份只能来自 before-document）：
   *   仅当某个**受影响段落**在 after 中贡献了 0 个 sourced 行，
   *   才用 before 文档中**同一 paragraphId** 的 run 提取 blockId/lineId。
   *   · 不同 paragraphId 的 run 绝不串入；
   *   · before 缺失 / 段落不存在 / run 无 source ⇒ 保持 fail-closed（不猜）；
   *   · `affectedParagraphs` 为空（无过滤）时**不**回退（保持既有行为）。
   */
  beforeDocument?: EditorDocument | null;
  /**
   * F3B-6.28-A：**导入期 Core 快照**（`coreImportSnapshotRef`：只在 import/rehydrate
   * 写入、re-import 释放）—— 稳定的 paragraphId → 行身份来源。
   *
   * 为什么需要它：`beforeDocument`（最后一条事务）只对「导入后第一笔编辑」有效 ——
   * 第一笔整行替换后，后续每笔事务的 before 也只剩 generated run（阶段 2 实测：
   * 第 1 次 tick `affectedLines:1`，后续 tick 归 0）。
   *
   * 回退优先级（对每个未贡献的受影响段落）：
   *   ① originDocument（导入期快照，段落 id 跨 replace/clear 稳定）
   *   ② beforeDocument（最后一条事务）
   *   ③ 都没有 ⇒ fail-closed（不猜）。
   * 生命周期保证由调用方负责：快照随 re-import 释放 ⇒ 绝不跨文档复用行身份。
   */
  originDocument?: EditorDocument | null;
}

/**
 * 从 Core command 结果提取受影响的 `(blockId, lineId)`。
 *
 * 严格来源链（冻结）：
 *   affected paragraphs → paragraph.runs → run.source.blockId / run.source.lineId
 *
 * **禁止**使用：paragraph text length · glyph count · paragraphId→glyph range
 *              · glyph ID · Segment · legacy docBlocks
 *
 * Core Split 已冻结为整行 lookup：split 出两个 paragraph 共享同一 lineId，
 * 去重后自然收敛为单个 `(B, L1)`（6.10A 方案 A）。
 */
export function extractAffectedBindingLines(
  input: ExtractAffectedInput
): AffectedBindingLine[] {
  const { document, affectedTextBoxes, affectedParagraphs, beforeDocument, originDocument } = input;
  const paraFilter =
    affectedParagraphs && affectedParagraphs.length > 0
      ? new Set(affectedParagraphs)
      : null;
  const boxFilter =
    affectedTextBoxes && affectedTextBoxes.length > 0 ? new Set(affectedTextBoxes) : null;

  const out: AffectedBindingLine[] = [];
  const seen = new Set<string>();
  /** after 文档中已贡献 ≥1 个 sourced 行的受影响段落（这些段落**不**走回退） */
  const contributed = new Set<string>();

  for (const page of document.pages ?? []) {
    for (const object of page.objects ?? []) {
      if (boxFilter && !boxFilter.has(object.id)) continue;
      if (object.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of object.paragraphs ?? []) {
        if (paraFilter && !paraFilter.has(paragraph.id)) continue;
        let paraContributed = false;
        for (const run of paragraph.runs ?? []) {
          const blockId = run.source?.blockId;
          const lineId = run.source?.lineId;
          // generated run 无 provenance ⇒ 不参与，也**不**伪造
          if (!blockId || !lineId) continue;
          paraContributed = true;
          const key = `${blockId}|${lineId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ blockId, lineId, lineIdx: run.source?.lineIdx });
        }
        if (paraContributed) contributed.add(paragraph.id);
      }
    }
  }

  // ── F3B-6.28：before-document / origin-document 回退（仅行身份，fail-closed）──
  //   触发条件（全部满足才回退）：
  //     ① 存在 affectedParagraphs 过滤（无过滤 = 调用方未提供 affected 集 ⇒ 保持既有行为）
  //     ② 提供了 beforeDocument 或 originDocument
  //     ③ 该受影响段落在 after 中贡献了 0 个 sourced 行
  if (paraFilter && (beforeDocument || originDocument)) {
    /** 收集某个文档中「受影响段落集合」的 sourced runs（同 paragraphId，绝不串段） */
    const sourcedRunsOf = (doc: EditorDocument): Map<string, ReadonlyArray<RunSourceView>> => {
      const map = new Map<string, ReadonlyArray<RunSourceView>>();
      for (const page of doc.pages ?? []) {
        for (const object of page.objects ?? []) {
          if (object.type !== "text") continue;
          for (const paragraph of object.paragraphs ?? []) {
            if (!paraFilter.has(paragraph.id)) continue;
            map.set(paragraph.id, paragraph.runs ?? []);
          }
        }
      }
      return map;
    };
    // 优先级 ①：导入期快照（最稳定；段落 id 跨 replace/clear 不变）
    const originRuns = originDocument ? sourcedRunsOf(originDocument) : null;
    // 优先级 ②：最后一条事务的 before（对第一笔编辑有效）
    const beforeRuns = beforeDocument ? sourcedRunsOf(beforeDocument) : null;
    for (const pid of paraFilter) {
      if (contributed.has(pid)) continue;
      const runs = originRuns?.get(pid) ?? beforeRuns?.get(pid);
      // 两个来源都没有该段落 ⇒ fail-closed，不猜行身份
      if (!runs) continue;
      for (const run of runs) {
        const blockId = run.source?.blockId;
        const lineId = run.source?.lineId;
        if (!blockId || !lineId) continue; // 来源里也无 source ⇒ 不伪造
        const key = `${blockId}|${lineId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ blockId, lineId, lineIdx: run.source?.lineIdx });
      }
    }
  }

  return out;
}

/**
 * 6.14 辅助：由 History transaction 的 before/after document 推导受影响 paragraphId。
 *
 * `[coreInputTick]` 边界拿不到 `CommandResult`，只能从 History 事务的
 * `before.document` / `after.document` 做**文本差异**推导 paragraph 级范围。
 * 注意：这里只用 paragraph **id + 文本**做定位，**不涉及**任何 glyph 索引 / 文本长度换算。
 */
export function diffAffectedParagraphIds(
  before: EditorDocument,
  after: EditorDocument
): string[] {
  const beforeText = new Map<string, string>();
  for (const page of before.pages ?? []) {
    for (const object of page.objects ?? []) {
      if (object.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of object.paragraphs ?? []) {
        beforeText.set(paragraph.id, paragraph.runs.map((r) => r.text).join(""));
      }
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const page of after.pages ?? []) {
    for (const object of page.objects ?? []) {
      if (object.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of object.paragraphs ?? []) {
        const text = paragraph.runs.map((r) => r.text).join("");
        const prev = beforeText.get(paragraph.id);
        if (prev !== text) {
          if (!seen.has(paragraph.id)) {
            seen.add(paragraph.id);
            out.push(paragraph.id);
          }
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  F3B-6.28-C（第四刀）：render state ⇆ Document 的一致性分类
// ─────────────────────────────────────────────────────────────────────

export interface RenderStateClassification {
  /** 有生效编辑（当前文本 ≠ 导入期文本）⇒ 需要 upsert box */
  upsert: AffectedBindingLine[];
  /** 当前文本 == 导入期文本 ⇒ 无生效编辑 ⇒ 应**移除**该行 render state
   *  （覆盖 undo 回原文；也覆盖手动改回原文 —— 此时原墨迹就是正确内容） */
  stale: AffectedBindingLine[];
  /** origin 无该行身份 ⇒ 无法判定，调用方保持现行为（按 upsert 处理），不猜 */
  unknown: AffectedBindingLine[];
}

/**
 * 按「当前段落文本 vs 导入期段落文本」把受影响行分类为 upsert / stale / unknown。
 *
 * 契约（F3B-6.28-C 裁决）：
 *   · 判据 = **paragraphId**（跨 replace/clear/undo/redo 稳定）+ **精确文本对比**；
 *     禁止文本相似度 / 猜测 / length 推导；
 *   · origin 来源 = 导入期 Core 快照（`coreImportSnapshotRef`，随 re-import 释放
 *     ⇒ 绝不跨文档复用行身份）；
 *   · origin 无该行身份（split 新段落等）⇒ unknown ⇒ 调用方保持现行为（fail-closed）；
 *   · 多段落共享同一 line（split）⇒ 文本按文档顺序合并后比较。
 */
export function classifyRenderStateByOriginText(input: {
  lines: ReadonlyArray<AffectedBindingLine>;
  originDocument?: EditorDocument | null;
  afterDocument: EditorDocument;
}): RenderStateClassification {
  const { lines, originDocument, afterDocument } = input;
  const upsert: AffectedBindingLine[] = [];
  const stale: AffectedBindingLine[] = [];
  const unknown: AffectedBindingLine[] = [];
  if (!originDocument) {
    upsert.push(...lines);
    return { upsert, stale, unknown };
  }

  /** origin: lineKey → { 该行对应的段落 id 集, 导入期文本 } */
  const originByLine = new Map<string, { paraIds: Set<string>; text: string }>();
  for (const page of originDocument.pages ?? []) {
    for (const object of page.objects ?? []) {
      if (object.type !== "text") continue;
      for (const paragraph of object.paragraphs ?? []) {
        const text = (paragraph.runs ?? []).map((r) => r.text).join("");
        for (const run of paragraph.runs ?? []) {
          const blockId = run.source?.blockId;
          const lineId = run.source?.lineId;
          if (!blockId || !lineId) continue;
          const key = `${blockId}|${lineId}`;
          let entry = originByLine.get(key);
          if (!entry) {
            entry = { paraIds: new Set<string>(), text };
            originByLine.set(key, entry);
          }
          entry.paraIds.add(paragraph.id);
        }
      }
    }
  }

  /** after: paragraphId → 当前文本 */
  const afterText = new Map<string, string>();
  for (const page of afterDocument.pages ?? []) {
    for (const object of page.objects ?? []) {
      if (object.type !== "text") continue;
      for (const paragraph of object.paragraphs ?? []) {
        afterText.set(paragraph.id, (paragraph.runs ?? []).map((r) => r.text).join(""));
      }
    }
  }

  for (const line of lines) {
    const key = `${line.blockId}|${line.lineId}`;
    const origin = originByLine.get(key);
    if (!origin) {
      unknown.push(line);
      continue;
    }
    // 按文档顺序合并该行对应段落（split 语义）的当前文本
    let current = "";
    for (const page of afterDocument.pages ?? []) {
      for (const object of page.objects ?? []) {
        if (object.type !== "text") continue;
        for (const paragraph of object.paragraphs ?? []) {
          if (!origin.paraIds.has(paragraph.id)) continue;
          current += (paragraph.runs ?? []).map((r) => r.text).join("");
        }
      }
    }
    (current === origin.text ? stale : upsert).push(line);
  }
  return { upsert, stale, unknown };
}

// ─────────────────────────────────────────────────────────────────────
//  6.13-B：Sidecar Reconciliation Lookup
// ─────────────────────────────────────────────────────────────────────

/** 当前几何来源 = Core Layout（**不是** legacy EditableDocument） */
export type CurrentGeometryProvider = (blockId: string, lineId: string) => BBox | undefined;

export interface ReconciliationTarget {
  blockId: string;
  lineId: string;
  lineIdx: number;

  /** 原始几何 / provenance（Sidecar） */
  originalGlyphs: OriginalGlyph[];
  originalLineBBox?: BBox;
  blockOriginalBounds?: BBox;
  renderSource: SidecarRenderSource;
  renderSourceDerived?: boolean;

  /** 当前几何（Core Layout；未注入 provider 时为 undefined） */
  currentGeometry?: BBox;

  /** Sidecar 是否命中（未命中 ⇒ 调用方应走 legacy fallback） */
  sidecarHit: boolean;
  /** 是否存在可用 operator provenance（决定 export 能否安全剥离原算子） */
  provenancePresent: boolean;
}

export interface ResolveTargetInput {
  affectedLines: readonly AffectedBindingLine[];
  sidecar: BindingSidecar | null;
  /** Core Layout 提供的当前几何（6.8 B1：不得再从 legacy doc 读） */
  currentGeometryOf?: CurrentGeometryProvider;
}

/**
 * 把 affected lines 解析为 **reconciliation input**（不操作 canvas / mask）。
 *
 * 不给 range：按 6.10A 冻结，返回**完整**原始 glyph 序列
 * （Core Split 下这就是正确语义，而非“过度遮盖”妥协）。
 */
export function resolveBindingReconciliationTarget(
  input: ResolveTargetInput
): ReconciliationTarget[] {
  const { affectedLines, sidecar, currentGeometryOf } = input;

  return affectedLines.map((line) => {
    const binding = sidecar
      ? lookupLineBinding(sidecar, line.blockId, line.lineId)
      : undefined;

    if (!sidecar || !binding) {
      return {
        blockId: line.blockId,
        lineId: line.lineId,
        lineIdx: line.lineIdx ?? -1,
        originalGlyphs: [],
        renderSource: "vector",
        currentGeometry: currentGeometryOf?.(line.blockId, line.lineId),
        sidecarHit: false,
        provenancePresent: false,
      };
    }

    const originalGlyphs = lookupGlyphRange(sidecar, line.blockId, line.lineId);
    return {
      blockId: line.blockId,
      lineId: line.lineId,
      lineIdx: binding.lineIdx,
      originalGlyphs,
      originalLineBBox: binding.originalLineBBox,
      blockOriginalBounds: lookupBlockBinding(sidecar, line.blockId)?.blockOriginalBounds,
      renderSource: binding.renderSource,
      renderSourceDerived: binding.renderSourceDerived,
      currentGeometry: currentGeometryOf?.(line.blockId, line.lineId),
      sidecarHit: true,
      provenancePresent: originalGlyphs.some((g) => g.operatorId !== undefined),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
//  6.13-D：Shadow vs Legacy 来源对比（只记录，不做决策）
// ─────────────────────────────────────────────────────────────────────

export interface ReconciliationSourceComparison {
  blockId: string;
  lineId: string;
  /** legacy 路径会读到的原始几何（模拟/实测传入） */
  legacyOriginalGeometry: BBox | null;
  /** Shadow 的原始几何（必须 === Sidecar） */
  shadowOriginalGeometry: BBox | null;
  /** Shadow 的当前几何（必须 === Core Layout） */
  shadowCurrentGeometry: BBox | null;
  /** 原始几何确实来自 Sidecar */
  originalFromSidecar: boolean;
  /** 当前几何确实来自 Core Layout（而非 legacy EditableDocument） */
  currentFromCoreLayout: boolean;
}

export function compareReconciliationSources(input: {
  target: ReconciliationTarget;
  legacyOriginalGeometry?: BBox | null;
}): ReconciliationSourceComparison {
  const { target, legacyOriginalGeometry = null } = input;
  return {
    blockId: target.blockId,
    lineId: target.lineId,
    legacyOriginalGeometry,
    shadowOriginalGeometry: target.originalLineBBox ?? null,
    shadowCurrentGeometry: target.currentGeometry ?? null,
    originalFromSidecar: target.sidecarHit && target.originalLineBBox !== undefined,
    currentFromCoreLayout: target.currentGeometry !== undefined,
  };
}
