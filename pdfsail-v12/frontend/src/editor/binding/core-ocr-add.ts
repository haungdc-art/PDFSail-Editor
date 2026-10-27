/**
 * B3-... — Add OCR TextBoxObjects → Core：把 2b 产出的 TextBoxObject 提交进 Core 的**唯一**命令入口。
 *
 * 责任边界（与 commitImageToCore 一致）：
 *   · 本模块**只**构造 `AddOcrTextBlocksCommand({ entries })` 并 `session.history.commit`。
 *   · 不碰 2b 构造逻辑 / 几何 / 归一化；那些由上游 producer（useOCR → 2a → 2b）完成。
 *   · 不持有 state；纯函数式入口便于单测与 producer 复用。
 *
 * Step 2b.6 收敛后的 producer seam（用户决策，Rev 0.7）：
 *   2b 输出 = `ImportPageDraft[]`（`normalizedOcrDraftToCoreObjects`），
 *   经 `materializeImport()` 落成 EditorDocument —— 这是 OCR Draft → Core Object 的唯一路径。
 *   `buildOcrTextBlocksInput` 把该产物抽取为 `AddOcrTextBlocksInput`（2c-B Command 输入）；
 *   `commitOcrDraftToCore` = build + 单次 commit 的组合封装。
 *
 * 注意：ownership 记账（markOwned / exportOwnershipRef / markMutationOwner /
 * noteCoreSessionChange）由 PDFEditor 编排层负责（与 Add Image 同 seam），本模块只提交命令。
 */

import type { CoreInputSession } from "./core-input-source";
import { AddOcrTextBlocksCommand } from "../core/commands";
import type {
  AddOcrTextBlockEntry,
  AddOcrTextBlocksInput,
} from "../core/commands/add-ocr-blocks";
import { normalizedOcrDraftToEditorDocument } from "./ocr-core-object-draft";
import type { NormalizedOcrDraft } from "./ocr-import-draft";

export function commitOcrBlocksToCore(session: CoreInputSession, input: AddOcrTextBlocksInput): void {
  session.history.commit(new AddOcrTextBlocksCommand(input));
}

/** buildOcrTextBlocksInput 的可选页尺寸（透传 materializeImport 前的 ImportPageDraft）。 */
export type OcrDraftMaterializeOptions = {
  pageWidth?: number;
  pageHeight?: number;
  documentId?: string;
};

/**
 * 2b.6 管线 → 2c-B Command 输入的桥接（纯函数，无副作用）：
 *
 *   NormalizedOcrDraft
 *     → normalizedOcrDraftToCoreObjects（ImportPageDraft[]）
 *     → materializeImport（EditorDocument，OCR Draft → Core Object 唯一路径）
 *     → 抽取每页 text objects → { entries: { pageIndex, object }[] }
 *
 * provenance（source.kind:"ocr" + blockId）与几何由 2b/materializeImport 原样携带，
 * 本函数不做任何坐标/身份改写；空 box 已在 2b/materializeImport 层被 skip，
 * 不会出现在 entries 中。
 */
export function buildOcrTextBlocksInput(
  draft: NormalizedOcrDraft,
  options: OcrDraftMaterializeOptions = {}
): AddOcrTextBlocksInput {
  const result = normalizedOcrDraftToEditorDocument(draft, options);
  const entries: AddOcrTextBlockEntry[] = [];
  for (const page of result.document.pages) {
    for (const obj of page.objects) {
      if (obj.type === "text") entries.push({ pageIndex: page.index, object: obj });
    }
  }
  return { entries };
}

/**
 * 组合封装：build + 单次 `history.commit`（恰好一个 EditorTransaction）。
 * ownership 记账仍归 PDFEditor 编排层。
 */
export function commitOcrDraftToCore(
  session: CoreInputSession,
  draft: NormalizedOcrDraft,
  options: OcrDraftMaterializeOptions = {}
): void {
  commitOcrBlocksToCore(session, buildOcrTextBlocksInput(draft, options));
}
