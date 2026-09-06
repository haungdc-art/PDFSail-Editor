/**
 * DeleteCommand — 删除能力 Command（Task-012A）
 *
 * 复制 ReplaceCommand 模式（Architecture Stable，机械执行）。
 * 删除语义 = 把 selection 选中区间 [startGlyphIndex, endGlyphIndex]（含）替换为空串。
 *
 * 职责：
 *   selection 描述选中区间 → 读 line 全文 → 删掉 [start, end+1) 区间 → 得新整行 →
 *   mutateLineText(doc, blockId, lineId, newLineText) → runtime.apply(result)。
 *
 * 依赖：只依赖构造时注入的 EditorRuntime。不知道 Provider / Store / React。
 * Contract 不变：execute(selection, payload)。
 * 不修改 CurrentSelection / EditTool / Registry / Runtime / Provider / Toolbar。
 */
import type { DocumentSelection } from "./document-selection";
import type { CapabilityCommand } from "./edit-capability";
import { mutateLineText } from "./document-mutation";
import type { EditorRuntime } from "./editor-runtime";

export class DeleteCommand implements CapabilityCommand {
  constructor(private readonly runtime: EditorRuntime) {}

  async execute(selection: DocumentSelection, _payload?: Record<string, unknown>): Promise<void> {
    // Delete 语义：无选中（caret / isEmpty）则无删除。
    // 防御性检查，不依赖 EditTool 的短路（Command 自治、健壮）。
    if (selection.isEmpty) return;

    const doc = this.runtime.getDocument();
    if (!doc) return;

    // 定位 block / line
    const block = doc.pages
      .flatMap((p) => p.blocks)
      .find((b) => b.id === selection.blockId);
    if (!block) return;

    const line = block.lines.find((l) => l.id === selection.lineId);
    if (!line) return;

    // 读 line 全文
    const lineText = line.glyphs.map((g) => g.char).join("");

    // 删除区间：[start, end+1) 置空（endGlyphIndex 含）
    const start = Math.max(0, selection.startGlyphIndex);
    const end = Math.min(line.glyphs.length - 1, selection.endGlyphIndex);

    // ── M4-FIX-006 (A): P0 Safety Guard ──
    // 跨行非法 selection 会压缩成 start>end 的非法 range；必须在 slice() 前中止，
    // 绝不写坏 PDF（与 M4-FIX-004 对 ReplaceCommand 的防护一致）。
    if (start > end) return;

    const newLineText = lineText.slice(0, start) + lineText.slice(end + 1);

    // M4-FIX-006 (B): 接入 precise-range mutation（复用 M4-FIX-005 已验证的 range 机制），
    //                 使未删除的 prefix/suffix 保持原几何，避免整行重锚定漂移。
    const result = mutateLineText(doc, selection.blockId, selection.lineId, newLineText, { start, end });
    if (result.mutated) {
      this.runtime.apply(result);
    }
  }
}
