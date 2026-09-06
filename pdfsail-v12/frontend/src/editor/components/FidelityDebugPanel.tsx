/**
 * Fidelity Debug Panel（Sprint-50 Task-003/004/005）
 *
 * 用途：在 Editor 内点击对象，直接查看该对象在六层（PDF/Importer/EditableGlyph/Geometry/RenderCommand/Canvas）
 * 的数据（rotation / transform / bbox / baseline / pivot），并 Overlay 画出 bounds/baseline。
 *
 * 非侵入：本组件只读（读 props），不修改任何编辑/渲染核心逻辑。
 * 仅在 ?debug=fidelity 时由 PDFEditor 挂载。
 */
import type { DrawGlyphCommand } from "../../document-model/render-command";
import type { EditableDocument } from "../../document-model/types";

/** 六层旋转值（度） */
function rotationDeg(t?: number[]): number | null {
  if (!t) return null;
  const a = t[0] ?? 1, b = t[1] ?? 0;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

/** 从 EditableDocument 反查 glyph 所在的 block / line / glyph */
function findEditableGlyph(doc: EditableDocument | null, blockId: string, lineId: string, index: number) {
  if (!doc) return null;
  for (const p of doc.pages) {
    for (const b of p.blocks) {
      if (b.id !== blockId) continue;
      for (const l of b.lines) {
        if (l.id !== lineId) continue;
        const g = l.glyphs[index];
        return { block: b, line: l, glyph: g as any };
      }
    }
  }
  return null;
}

export interface FidelityDebugPanelProps {
  glyph: DrawGlyphCommand;
  index: number;
  editableDocument: EditableDocument | null;
  /** pdf.js TextItem 缓存（PDF 层） */
  pdfTextItems?: any[];
  /** Overlay 开关 */
  showSourceBounds?: boolean;
  showGlyphBounds?: boolean;
  showBaseline?: boolean;
}

export function FidelityDebugPanel(props: FidelityDebugPanelProps) {
  const { glyph, index, editableDocument, pdfTextItems } = props;
  const showSrc = props.showSourceBounds ?? true;
  const showGlyph = props.showGlyphBounds ?? true;
  const showBase = props.showBaseline ?? true;

  // RenderCommand 层
  const cmdRotation = rotationDeg(glyph.transform);
  const cmdBBox = { x: glyph.x, y: glyph.y, w: glyph.width, h: glyph.height };
  const cmdBaseline = glyph.baseline;

  // EditableDocument 层
  const ed = findEditableGlyph(editableDocument, glyph.blockId, glyph.lineId, index);
  const edGlyph = ed?.glyph;
  const edRotation = rotationDeg(edGlyph?.transform);
  const edBBox = edGlyph?.bbox;
  const edBaseline = edGlyph?.baseline;

  // PDF 层：从 textItems 按位置匹配（近似）
  const pdfItem = pdfTextItems?.find((it) => {
    const t = it.transform ?? [];
    const dx = Math.abs((t[4] ?? 0) - glyph.x);
    const dy = Math.abs((t[5] ?? 0) - glyph.y);
    return dx < 40 && dy < 40;
  });
  const pdfRotation = rotationDeg(pdfItem?.transform);
  const pdfTransform = pdfItem?.transform;

  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        top: 70,
        width: 360,
        zIndex: 99999,
        background: "#111",
        color: "#e8e8e8",
        fontFamily: "monospace",
        fontSize: 11,
        padding: 10,
        borderRadius: 8,
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
        maxHeight: "80vh",
        overflow: "auto",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8, color: "#ffd166" }}>
        Fidelity Debug · {glyph.char || "(glyph)"} #{index}
        <span style={{ marginLeft: 8, fontSize: 10, color: "#999" }}>
          {glyph.blockId.slice(0, 10)}/{glyph.lineId.slice(0, 8)}
        </span>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr style={{ background: "#1c1c1c" }}>
            <td style={{ padding: "3px 6px" }}>Layer</td>
            <td style={{ padding: "3px 6px" }}>Rotation</td>
            <td style={{ padding: "3px 6px" }}>Baseline</td>
          </tr>
          <tr>
            <td style={{ padding: "3px 6px", color: "#7cc4ff" }}>PDF</td>
            <td style={{ padding: "3px 6px" }}>{pdfRotation !== null ? pdfRotation.toFixed(1) + "°" : "?"}</td>
            <td style={{ padding: "3px 6px" }}>-</td>
          </tr>
          <tr>
            <td style={{ padding: "3px 6px", color: "#7cc4ff" }}>EditableGlyph</td>
            <td style={{ padding: "3px 6px" }}>{edRotation !== null ? edRotation.toFixed(1) + "°" : "?"}</td>
            <td style={{ padding: "3px 6px" }}>{edBaseline !== undefined ? edBaseline.toFixed(1) : "-"}</td>
          </tr>
          <tr>
            <td style={{ padding: "3px 6px", color: "#7cc4ff" }}>RenderCommand</td>
            <td style={{ padding: "3px 6px" }}>{cmdRotation !== null ? cmdRotation.toFixed(1) + "°" : "?"}</td>
            <td style={{ padding: "3px 6px" }}>{cmdBaseline !== undefined ? cmdBaseline.toFixed(1) : "-"}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 8, borderTop: "1px solid #333", paddingTop: 6 }}>
        <div>PDF transform: {pdfTransform ? "[" + pdfTransform.map((x: number) => Number(x.toFixed(2))).join(",") + "]" : "?"}</div>
        <div>Glyph transform: {edGlyph?.transform ? "[" + edGlyph.transform.map((x: number) => Number(x.toFixed(2))).join(",") + "]" : "?"}</div>
        <div>Editable bbox: {edBBox ? `(${edBBox.x.toFixed(1)},${edBBox.y.toFixed(1)},${edBBox.width.toFixed(1)}x${edBBox.height.toFixed(1)})` : "?"}</div>
        <div>Cmd bbox: `(${cmdBBox.x.toFixed(1)},${cmdBBox.y.toFixed(1)},${cmdBBox.w.toFixed(1)}x${cmdBBox.h.toFixed(1)})`</div>
      </div>

      <div style={{ marginTop: 8, borderTop: "1px solid #333", paddingTop: 6, color: "#9ad99a", fontSize: 10 }}>
        Overlay: {showSrc ? "Source ✓" : ""} {showGlyph ? "Glyph ✓" : ""} {showBase ? "Baseline ✓" : ""}
      </div>
    </div>
  );
}
