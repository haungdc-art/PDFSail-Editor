/**
 * ocr-core-object-draft.ts — Manual OCR → Core Migration · Step 2b（Draft Vocabulary Convergence）
 *
 * 终点：**NormalizedOcrDraft → ImportPageDraft[] → materializeImport() → EditorDocument**。
 *
 * Step 2b.6 收敛（用户决策）：
 *   - 不再保留旧的平行类型；OCR 2b 阶段完全复用 Legacy/Import 词汇
 *     （ImportPageDraft / ImportBoxDraft / ImportParagraphDraft / ImportRunDraft）。
 *   - 不再直接构造真实 Core 对象（createTextBox 等）；改为产出 Import* draft，
 *     由 materializeImport 统一落成 EditorDocument（与 ocr-adapter.ts 生产路径同源）。
 *   - 这是 Step 2b 的全部交付：一个纯函数把 canonical `NormalizedOcrDraft` 映射成
 *     `ImportPageDraft[]`，由 Step 2c 命令负责把页面对象插入 EditorDocument。
 *
 * 路径 X' 原则（不变）：OCR 只增加 Core Objects，不重新定义 Pages。
 *   - 本模块只产出 ImportPageDraft[]（页面 index 1-based 随对象携带，不创建 EditorPage）。
 *   - materializeImport 负责拼装 EditorPage / EditorDocument。
 *
 * 红线（受 Step 2b 任务约束）：
 *   - 不碰 Command / History / markMutationOwner / exportOwnershipRef / docBlocks /
 *     setBlocks / OCR UI / PDFEditor / runInlineOCR / 任何 handler。
 *   - 不改 materializeImport、不改 EditorDocument runtime、不改生产 OCR adapter。
 *   - 不创建新的 materializer：normalizedOcrDraftToEditorDocument 仅是 materializeImport 的组合封装。
 *
 * 依赖方向：binding 层可安全 import `../legacy`（adapter 词汇）与 `../core/document`（纯工厂）。
 */

import type {
  ImportBoxDraft,
  ImportPageDraft,
  ImportParagraphDraft,
  ImportResult,
  ImportRunDraft,
  TextSourceBinding,
  TextStyle,
} from "../legacy/common";
import { materializeImport } from "../legacy/common";
import { createTextStyle } from "../core/document/factory";
import type { NormalizedOcrDraft, NormalizedOcrDraftItem } from "./ocr-import-draft";

/** Step 2b 结果集合：ImportPageDraft[]（draft 中间态，不是 EditorDocument）。 */
export interface OcrImportPagesResult {
  pages: ImportPageDraft[];
  skipped: number;
  warnings: string[];
}

export interface OcrImportContext {
  /** 可选：覆盖 TextStyle 默认值（caller 提供，不含 id）。 */
  defaultStyle?: Partial<TextStyle>;
}

/**
 * 1 个 NormalizedOcrDraftItem → 1 个 ImportBoxDraft
 * = 1 TextBox = 1 Paragraph = 1 TextRun（单 run）。
 *
 * provenance：
 *   - TextSourceBinding.kind === "ocr" 是 Core 合法值（TextSourceKind 含 "ocr"）。
 *   - blockId 取确定性 OCR id（item.id），作为下游 Sidecar / export 的稳定身份键。
 *   - Import* draft 不携带 id（id 由 materializeImport 统一分配），因此不生成
 *     确定性的 `para_` / `run_` 前缀 id（Step 2b.6 规则 #3）。
 *   - alignment 显式 "left"（Import* 缺省亦为 left，此处显式声明，避免歧义）。
 *   - rotation 恒 0（NormalizedOcrDraftItem.rotation: 0）；transform 不写（无 OCR 旋转矩阵）。
 */
function itemToBox(item: NormalizedOcrDraftItem, context: OcrImportContext): ImportBoxDraft {
  const source: TextSourceBinding = { kind: "ocr", blockId: item.id };
  const style = createTextStyle({ fontSize: item.fontSize, ...context.defaultStyle });
  const run: ImportRunDraft = { text: item.text, style, source };
  const paragraph: ImportParagraphDraft = { runs: [run], alignment: "left" };
  return {
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    rotation: 0,
    source,
    paragraphs: [paragraph],
  };
}

/** 几何/文本防御性守卫：非有限 / 非正尺寸 → 跳过（与 §4 越界守卫同源，fail-safe）。 */
function isItemRenderable(item: NormalizedOcrDraftItem): boolean {
  const finite = [item.x, item.y, item.width, item.height, item.rotation].every(
    (v) => typeof v === "number" && Number.isFinite(v)
  );
  return finite && item.width > 0 && item.height > 0;
}

/**
 * 纯映射：NormalizedOcrDraft → OcrImportPagesResult（ImportPageDraft[]）。
 *
 * - 每个 item → 1 个 ImportBoxDraft，按 item.page 分组成 ImportPageDraft[]。
 * - geometry 原样进入 Canvas Space（TextBoxObject 坐标系 = Page Canvas Space，
 *   左上/y-down/px，与 OCR draft 一致，无需缩放/翻转）。
 * - 空文本 / 不可渲染几何 → 防御性 skip（NormalizedOcrDraft 不应含此类，但契约层显式拒绝）。
 * - 确定性 + 幂等：Import* draft 不含 id（id 由 materializeImport 统一分配），
 *   故同 draft + 同 context ⇒ 逐字节相同的 draft 结构。
 */
export function normalizedOcrDraftToCoreObjects(
  draft: NormalizedOcrDraft,
  context: OcrImportContext = {}
): OcrImportPagesResult {
  const warnings: string[] = [];
  let skipped = 0;

  const pageMap = new Map<number, ImportBoxDraft[]>();
  for (const item of draft.items) {
    if (item.text.length === 0) {
      skipped += 1;
      warnings.push("1 个空文本 OCR item 被跳过（不应出现在 NormalizedOcrDraft 中）");
      continue;
    }
    if (!isItemRenderable(item)) {
      skipped += 1;
      warnings.push("1 个不可渲染几何 OCR item 被跳过（非有限 / 非正尺寸）");
      continue;
    }
    const box = itemToBox(item, context);
    const list = pageMap.get(item.page);
    if (list) list.push(box);
    else pageMap.set(item.page, [box]);
  }

  const pages: ImportPageDraft[] = [...pageMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, boxes]) => ({ index, width: 0, height: 0, boxes }));

  return { pages, skipped, warnings };
}

/**
 * 完整的 Step 2b → materialize 收敛：NormalizedOcrDraft → EditorDocument。
 *
 * 仅是 materializeImport 的组合封装（非新 materializer）：先产出 ImportPageDraft[]，
 * 再把可选页面尺寸写入每页，最后交给 materializeImport 落成 EditorDocument。
 * 这是 OCR Draft → Core 的唯一路径（与生产 ocr-adapter.ts 同源）。
 */
export function normalizedOcrDraftToEditorDocument(
  draft: NormalizedOcrDraft,
  options: { pageWidth?: number; pageHeight?: number; documentId?: string } = {},
  context: OcrImportContext = {}
): ImportResult {
  const { pages, skipped, warnings } = normalizedOcrDraftToCoreObjects(draft, context);
  for (const page of pages) {
    if (options.pageWidth !== undefined) page.width = options.pageWidth;
    if (options.pageHeight !== undefined) page.height = options.pageHeight;
  }
  return materializeImport(pages, options, warnings, skipped);
}
