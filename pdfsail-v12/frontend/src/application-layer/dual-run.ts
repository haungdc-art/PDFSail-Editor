/**
 * Dual Run 验证 — 旧 RenderCommand vs 新 RenderCommand（from LayoutResult）
 *
 * Sprint36 · TD-003（LayoutResult）· Commit 4（Dual Run）
 *
 * 目标：
 *   - Layout Engine 同时输出旧 RenderCommand 与新 LayoutResult。
 *   - Renderer 完全不动（默认仍走旧路径）。
 *   - RenderCommandDiff 全 PASS 后，才进入 Commit 5（Renderer 切换）。
 *
 * Commit 4C：开发期开关 ENABLE_LAYOUT_DUAL_RUN
 *   - 开启：跑 Dual Run Diff，console/report。
 *   - 关闭：完全没有任何性能损耗（直接短路返回）。
 */

import { renderDocumentToCommands } from "../document-model/document-renderer";
import { extractFactsSnapshot } from "../document-model/extract-facts-snapshot";
import { extractLayoutResult } from "../document-model/extract-layout-result";
import { buildRenderCommands } from "../document-model/layout-result-adapter";
import {
  compare,
  formatDiffResult,
  type DiffResult,
} from "../document-model/layout/RenderCommandDiff";
import type { EditableDocument } from "../document-model/types";

/**
 * Commit 4C：开发期开关。
 * 默认关闭（生产零开销）。开启方式：ENABLE_LAYOUT_DUAL_RUN === "true"。
 */
export function isDualRunEnabled(): boolean {
  if (typeof globalThis !== "undefined") {
    const env = (globalThis as any).process?.env?.ENABLE_LAYOUT_DUAL_RUN;
    if (env) return env === "true";
    // 浏览器 window 上的调试开关
    const w = globalThis as any;
    if (w.__ENABLE_LAYOUT_DUAL_RUN !== undefined) return !!w.__ENABLE_LAYOUT_DUAL_RUN;
  }
  return false;
}

/**
 * 运行 Dual Run 一致性验证。
 * 若开关关闭，返回 null（零开销）；开启则返回 DiffResult。
 */
export function runDualRunDiff(
  doc: EditableDocument,
  opts?: { force?: boolean }
): DiffResult | null {
  if (!(opts?.force ?? false) && !isDualRunEnabled()) return null;

  const oldCommands = renderDocumentToCommands(doc);
  const facts = extractFactsSnapshot(doc);
  const layout = extractLayoutResult(doc);
  const newCommands = buildRenderCommands(facts, layout);
  return compare(oldCommands, newCommands);
}

/** 便捷：输出固定格式的 Dual Run 验证摘要（Commit 4D） */
export function dualRunSummary(
  doc: EditableDocument,
  opts?: { force?: boolean }
): string | null {
  const r = runDualRunDiff(doc, opts);
  if (r === null) return null;
  return formatDiffResult(r);
}

/** 便捷：记录到 console（Commit 4C 的 report 落地） */
export function reportDualRun(doc: EditableDocument, force = false): void {
  if (!(force || isDualRunEnabled())) return;
  const summary = dualRunSummary(doc, { force: true });
  if (summary === null) return;
  if (typeof console !== "undefined") {
    if (summary.startsWith("Layout Diff PASS")) {
      console.log(`%c${summary}`, "color:#22c55e;font-weight:bold;");
    } else {
      console.warn(`%c${summary}`, "color:#ef4444;font-weight:bold;");
    }
  }
}
