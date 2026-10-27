/**
 * F3B-6.13 — 当前几何来源 = **Core Layout**（不是 legacy EditableDocument）
 *
 * 这条模块是 F3B-6.8 blocker **B1** 的正面回答：
 *   Core input 路径 `legacyMutation` 恒为 `false`（core-input-source L17-19），
 *   因此 `markLineEdited` 现读的 `editableDocumentRef.current` 是**编辑前的陈旧 glyph**。
 *   Shadow path 的当前几何必须来自 Core Layout。
 *
 * 本模块**不修改 Core**，只消费 `layoutTextBox`。
 */

import type { BBox } from "../../document-model/types";
import type { EditorDocument } from "../core/document/types";
import type { FontMetricsProvider } from "../core/layout/metrics";
import { layoutTextBox } from "../core/layout/reflow";
import type { CurrentGeometryProvider } from "./reconciliation-target";

interface IndexEntry {
  textBoxId: string;
  paragraphIds: Set<string>;
}

/**
 * 构造「按 (blockId, lineId) 取当前几何」的 provider。
 *
 * 映射方式：
 *   run.source.(blockId,lineId) → 所在 paragraph → `layoutTextBox` 产出该 paragraph 的所有
 *   visual line box → **取并集**。
 *
 * 并集语义正好覆盖 Core Split：split 后两个 paragraph 共享同一 lineId，
 * 各自一条 visual line，并集即「该原始行当前占据的全部区域」（与 6.10A 整行语义一致）。
 */
export function createCoreLayoutCurrentGeometryProvider(
  document: EditorDocument,
  metrics: FontMetricsProvider,
  /**
   * Step 3：按 TextBox 注入的**真实** per-glyph 度量（与 Core 可见渲染同一套原则）。
   * 未提供某 TextBox 则回退 `metrics` 参数；缺省不传等价于 Step 3 之前。
   * 只解决几何度量，不重新定义 ownership（ownership 属 Step 2b）。
   */
  metricsByTextBox?: ReadonlyMap<string, FontMetricsProvider>,
  /**
   * F3B-6.28-B：**导入期 Core 快照**（`coreImportSnapshotRef`）—— 只用于补全**行身份索引**。
   *
   * 背景（阶段 2 实测）：整行替换/清空后，受影响段落在 after 文档只剩
   * `{kind:"generated"}` run（无 source）⇒ 本 provider 的索引（只扫 `document` 的
   * `run.source`）没有该 `(blockId,lineId)` key ⇒ 行 81 返回 `undefined`
   * ⇒ `missing-current-geometry` ⇒ mask 不渲染 ⇒ 屏幕原文残留。
   *
   * 合并规则（关键约束）：
   *   · **after 优先**：after 已有的 key 一律不覆盖（当前文档的 textBoxId 与布局
   *     结果仍是当前几何的权威来源）；
   *   · origin 只补**缺失的 key**（行身份），**绝不**提供布局盒 —— 布局盒仍完全
   *     来自 after 文档的 `layoutTextBox`；
   *   · origin 无对应身份、或当前布局中不存在该行盒 ⇒ 仍返回 `undefined`
   *     （fail-closed 保持，不用原始几何冒充当前几何）；
   *   · 生命周期由调用方保证：传入当前会话的 `coreImportSnapshotRef.current`
   *     （随 re-import 释放），不缓存跨文档索引。
   */
  originDocument?: EditorDocument | null
): CurrentGeometryProvider {
  const index = new Map<string, IndexEntry>();

  const indexRuns = (doc: EditorDocument): void => {
    for (const page of doc.pages ?? []) {
      for (const object of page.objects ?? []) {
        if (object.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
        for (const paragraph of object.paragraphs ?? []) {
          for (const run of paragraph.runs ?? []) {
            const blockId = run.source?.blockId;
            const lineId = run.source?.lineId;
            if (!blockId || !lineId) continue; // generated run 无 provenance
            const key = `${blockId}|${lineId}`;
            let entry = index.get(key);
            if (!entry) {
              entry = { textBoxId: object.id, paragraphIds: new Set<string>() };
              index.set(key, entry);
            }
            entry.paragraphIds.add(paragraph.id);
          }
        }
      }
    }
  };

  indexRuns(document);
  // F3B-6.28-B：origin 只补缺失的 key（after 优先，绝不覆盖）
  if (originDocument) indexRuns(originDocument);

  const layoutCache = new Map<string, ReturnType<typeof layoutTextBox> | null>();

  const getLayout = (textBoxId: string) => {
    if (layoutCache.has(textBoxId)) return layoutCache.get(textBoxId) ?? null;
    let result: ReturnType<typeof layoutTextBox> | null = null;
    try {
      result = layoutTextBox(document, textBoxId, metricsByTextBox?.get(textBoxId) ?? metrics);
    } catch {
      result = null; // fail-open：布局失败不阻断 reconciliation
    }
    layoutCache.set(textBoxId, result);
    return result;
  };

  return (blockId: string, lineId: string): BBox | undefined => {
    const entry = index.get(`${blockId}|${lineId}`);
    if (!entry) return undefined;
    const result = getLayout(entry.textBoxId);
    if (!result) return undefined;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let found = false;

    for (const paragraph of result.layout.paragraphs ?? []) {
      if (!entry.paragraphIds.has(paragraph.paragraphId)) continue;
      for (const line of paragraph.lines ?? []) {
        const box = line.box;
        if (!box) continue;
        found = true;
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
      }
    }

    if (!found) return undefined;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };
}
