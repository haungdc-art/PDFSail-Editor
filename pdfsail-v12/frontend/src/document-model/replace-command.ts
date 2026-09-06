/**
 * ReplaceCommand — 替换能力 Command（Task-011C · ReplaceCommand Registration）
 *
 * 实现 011C 的四步中的 ① 与 ③ ④：
 *   ① ReplaceCommand 类
 *   ③ Command.execute() —— 消费 CurrentSelection + payload，走 mutateLineText
 *   ④ mutateLineText()  —— 区间替换 → 整行替换 → 写回 Runtime
 *
 * 职责（区间替换语义）：
 *   selection 描述选中区间 [startGlyphIndex, endGlyphIndex]（endGlyphIndex 含）。
 *   Command 从 runtime 读 document → 找到 line → 读 line 全文 →
 *   把 [start, end+1) 区间替换成 payload.text → 得到新整行 →
 *   mutateLineText(doc, blockId, lineId, newLineText) → runtime.apply(result)。
 *
 * 依赖：只依赖构造时注入的 EditorRuntime。不知道 Provider / Store / React。
 * Contract 一行不改：execute(selection, payload) 签名保持不变。
 * 不修改 CurrentSelection（保持纯 Selection，不增加 lineText）。
 */
import type { DocumentSelection } from "./document-selection";
import type { CapabilityCommand } from "./edit-capability";
import { mutateLineText } from "./document-mutation";
import type { EditorRuntime } from "./editor-runtime";

export class ReplaceCommand implements CapabilityCommand {
  constructor(private readonly runtime: EditorRuntime) {}

  async execute(selection: DocumentSelection, payload?: Record<string, unknown>): Promise<void> {
    // payload.text：替换后的文本（Toolbar 传入；无则为空串 = 删除）
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

    // ── M4-FIX-004: 非法 range 防御 guard（第二道安全保险）──
    // 正常情况下（单行 CurrentSelection）start <= end。
    // 若未来任何路径制造了 start > end（如跨行 selection 被错误压缩），
    // 直接中止 mutation，绝不写坏 PDF（P0：禁止 silent data corruption）。
    // 只增加 abort 判断，不改变 range 语义，不做截断/交换/取 min-max。
    if (selection.startGlyphIndex > selection.endGlyphIndex) return;

    // 读 line 全文
    const lineText = line.glyphs.map((g) => g.char).join("");

    // 区间替换：[start, end+1) 换成 newText（endGlyphIndex 含）
    const start = Math.max(0, selection.startGlyphIndex);
    const end = Math.min(line.glyphs.length - 1, selection.endGlyphIndex);
    const newLineText = lineText.slice(0, start) + newText + lineText.slice(end + 1);

    // M4-FIX-005: 传入 range（原选区 glyph 区间 [start, end]）→ mutation 只重建该区间，
    //             未选中 prefix/suffix 保持原对象与原几何（消除整行按新 index 重锚定的几何漂移）。
    const result = mutateLineText(doc, selection.blockId, selection.lineId, newLineText, { start, end });
    if (result.mutated) {
      this.runtime.apply(result);
    }
  }
}
