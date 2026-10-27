/**
 * editor/legacy/blocks-adapter.ts — EDITOR-CORE-005
 *
 *   editor/types  docBlocks（Block[] / TextBlock[]）  →  EditorDocument
 *
 * ── 映射策略 ────────────────────────────────────────────────────────
 * docBlocks 是 **UI 层块模型**（src/editor/types.ts），一个 TextBlock → 一个 TextBox；
 * TextBlock.text 内的 "\n" 切成多个 Paragraph（与 createParagraph 的段落语义一致）。
 *
 * ── provenance ──────────────────────────────────────────────────────
 * docBlocks **不携带任何 PDF provenance**：没有 blockId / lineId / glyph 索引。
 * 因此 run / TextBox 的 source 一律标 `{ kind: "user" }`，
 * 绝不伪造 PDF 字段冒充原文（§24）。
 *
 * ── 未建模类型 ──────────────────────────────────────────────────────
 * 签名 / 遮盖 / 高亮 / 批注块在 Editor Core F3B-6.24-B3 阶段尚未建模
 * （§7：不为满足目录结构而造空抽象）。这些块被**跳过并计数**，
 * 通过 ImportResult.skipped / warnings 显式暴露，不做静默丢弃。
 * 图片块（ImageBlock）已在 F3B-6.24-B3 建模为 ImageObject(assetRef)。
 */

import type { Block, ImageBlock, TextBlock } from "../types";
import type { TextSourceBinding } from "../core/document/types";
import {
  ingestImageDataUrl,
  materializeImport,
  splitParagraphs,
  toTextStyle,
  type ImportBoxDraft,
  type ImportImageDraft,
  type ImportOptions,
  type ImportResult,
} from "./common";

/** docBlocks 无 PDF provenance → 统一标记 user（不是 generated，也不是 pdf-native） */
const USER_SOURCE: TextSourceBinding = { kind: "user" };

export function blocksToEditorDocument(
  blocks: Block[],
  options: ImportOptions = {}
): ImportResult {
  const warnings: string[] = [];
  const boxes: ImportBoxDraft[] = [];
  const images: ImportImageDraft[] = [];
  const assets: ImportResult["assets"] = [];

  let unmodeled = 0;
  const unmodeledTypes = new Map<string, number>();
  let withOriginalBounds = 0;

  for (const block of blocks) {
    if (block.type === "image") {
      // F3B-6.24-B3：图片块 → ImageObject(assetRef)。
      // src 经确认恒为 dataURL（PDFEditor 经 FileReader.readAsDataURL 写入），同步解码。
      const asset = ingestImageDataUrl((block as ImageBlock).src);
      if (asset) {
        assets.push(asset);
        images.push({
          x: block.x,
          y: block.y,
          width: block.w,
          height: block.h,
          rotation: 0,
          assetRef: asset.id,
        });
      } else {
        // 解码失败（非 dataURL / 非法 base64）→ 计入 unmodeled，不静默丢弃
        unmodeled += 1;
        unmodeledTypes.set("image(undecodable)", (unmodeledTypes.get("image(undecodable)") ?? 0) + 1);
      }
      continue;
    }
    if (block.type !== "text") {
      // signature / redact / highlight / comment 等：Editor Core 暂未建模，显式计数（非静默丢弃）
      unmodeled += 1;
      unmodeledTypes.set(block.type, (unmodeledTypes.get(block.type) ?? 0) + 1);
      continue;
    }
    const text = block as TextBlock;
    if (text.originalBounds) withOriginalBounds += 1;

    const style = toTextStyle(
      {
        fontFamily: text.fontFamily,
        fontSize: text.fontSize,
        color: text.color,
      },
      options
    );

    boxes.push({
      x: text.x,
      y: text.y,
      width: text.w,
      height: text.h,
      rotation: 0,
      source: USER_SOURCE,
      paragraphs: splitParagraphs(text.text ?? "").map((line) => ({
        runs: [{ text: line, style, source: USER_SOURCE }],
      })),
    });
  }

  warnings.push(
    "docBlocks 不携带 PDF provenance：所有 run 标记 source.kind=\"user\"（未伪造 blockId/lineId/glyphIndex）"
  );
  if (unmodeled > 0) {
    const detail = [...unmodeledTypes.entries()].map(([t, n]) => `${t}×${n}`).join(", ");
    warnings.push(`跳过 ${unmodeled} 个未建模块类型：${detail}（Editor Core 暂未建模，非静默丢弃）`);
  }
  if (withOriginalBounds > 0) {
    warnings.push(
      `${withOriginalBounds} 个块带 originalBounds（OCR 遮盖区域）；Editor Core 暂未建模该字段`
    );
  }

  return materializeImport(
    [
      {
        index: options.pageIndex ?? 1,
        width: options.pageWidth ?? 0,
        height: options.pageHeight ?? 0,
        boxes,
        images,
      },
    ],
    options,
    warnings,
    unmodeled, // 未建模块类型计入 skipped（显式计数，不静默丢弃）
    assets
  );
}
