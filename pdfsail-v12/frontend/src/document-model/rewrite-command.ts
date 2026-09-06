/**
 * RewriteCommand — 改写能力 Command（Task-012B）
 *
 * Reference: ReplaceCommand（canonical implementation pattern，治理文档固化）。
 * 与 ReplaceCommand 结构一致，仅语义命名不同（Rewrite 表示"改写"）。
 *
 * Business Logic：用 payload.text（AI 润色/改写结果）替换 selection 选中区间。
 * AI 调用发生在上层（Toolbar legacy），Command 只负责区间替换，不做网络请求。
 *
 * 职责：
 *   selection 描述选中区间 [startGlyphIndex, endGlyphIndex]（含）→ 读 line 全文 →
 *   把 [start, end+1) 区间替换成 payload.text → 得新整行 →
 *   mutateLineText(doc, blockId, lineId, newLineText) → runtime.apply(result)。
 *
 * 依赖：只依赖构造时注入的 EditorRuntime。不知道 Provider / Store / React。
 * Contract 不变：execute(selection, payload)。不新增任何抽象 / Manager / Provider / Interface / Runtime / Dispatcher。
 */
import type { DocumentSelection } from "./document-selection";
import type { CapabilityCommand } from "./edit-capability";
import { mutateLineText } from "./document-mutation";
import type { EditorRuntime } from "./editor-runtime";

export class RewriteCommand implements CapabilityCommand {
  constructor(private readonly runtime: EditorRuntime) {}

  async execute(selection: DocumentSelection, payload?: Record<string, unknown>): Promise<void> {
    // payload.text：改写结果（Toolbar 经 AI 获得后传入）。无文本则为删除（与 Replace 语义一致）。
    const newText = payload?.text == null ? "" : String(payload.text);

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

    // 区间替换：[start, end+1) 换成 newText（endGlyphIndex 含）
    const start = Math.max(0, selection.startGlyphIndex);
    const end = Math.min(line.glyphs.length - 1, selection.endGlyphIndex);

    // ── M4-FIX-007 (A): P0 Safety Guard ──
    // 跨行非法 selection 会压缩成 start>end 的非法 range；必须在 slice() 前中止，
    // 绝不写坏 PDF（与 M4-FIX-004/006 对 Replace/Delete 的防护一致）。
    if (start > end) return;

    const newLineText = lineText.slice(0, start) + newText + lineText.slice(end + 1);

    // M4-FIX-007 (B): 接入 precise-range mutation（复用 M4-FIX-005/006 已验证的 range 机制），
    //                 使未改写的 prefix/suffix 保持原几何，避免整行重锚定漂移。
    const result = mutateLineText(doc, selection.blockId, selection.lineId, newLineText, { start, end });
    if (result.mutated) {
      this.runtime.apply(result);
    }
  }
}
