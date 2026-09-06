// M7.8-048-DIAG: 状态链追踪 + 证据采集（READ-ONLY，不修改 production code）
// 复现 useExport.ts:119 的导出边界：
//   const docForExport = allEditSegs.length ? applySegmentEditsToDocument(doc, allEditSegs) : doc;
// 用真实的 applySegmentEditsToDocument / mutateLineText 跑两个 store 的流转，
// 定位 05（第一次修改）在哪一个边界消失。
import "./_env_doc.mts";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { mutateLineText } from "./document-mutation";
import type { EditableDocument, Segment } from "../editor-engine/types";

const BLOCK = "pdf_p1_block0";
const LINE = "pdf_p1_block0_l0";
const ORIG = "02/2026".split(""); // ['0','2','/','2','0','2','6']

function mkDoc(text: string): EditableDocument {
  const glyphs = text.split("").map((ch, i) => ({
    char: ch,
    originalChar: ch,
    bbox: { x: i * 10, y: 0, width: 10, height: 10 },
    styleRef: 0,
    modified: false,
  }));
  return {
    pages: [
      {
        index: 1,
        width: 100,
        height: 100,
        blocks: [
          {
            id: BLOCK,
            type: "text",
            x: 0,
            y: 0,
            width: 70,
            height: 10,
            lines: [
              {
                id: LINE,
                source: "vector" as const,
                bbox: { x: 0, y: 0, width: 70, height: 10 },
                glyphs,
                style: {},
              },
            ],
          },
        ],
      },
    ],
    styles: [{}],
    metadata: { fileName: "x", pageCount: 1, createdAt: 0, renderScale: 1.5, cssScale: 1 },
  };
}

function lineText(doc: EditableDocument): string {
  return doc.pages[0].blocks[0].lines[0].glyphs.map((g: any) => g.char).join("");
}

// 模拟导出边界（与 useExport.ts:119 同构）
function exportBoundary(doc: EditableDocument, allEditSegs: Segment[]): EditableDocument {
  return allEditSegs.length ? applySegmentEditsToDocument(doc, allEditSegs) : doc;
}

function seg(text: string, originalText: string, start: number, end: number): Segment {
  return {
    id: `${LINE}_${originalText}`,
    text,
    originalText,
    pdfX: 0, pdfY: 0, pdfW: 10, pdfH: 10,
    cssX: 0, cssY: 0, cssW: 10, cssH: 10, cssBaseline: 0,
    font: { family: "s", size: 10, color: [0, 0, 0] } as any,
    lineId: LINE,
    source: { blockId: BLOCK, lineId: LINE, startGlyphIndex: start, endGlyphIndex: end },
  } as Segment;
}

console.log("==== M7.8-048-DIAG ====");

// ── 场景 A：纯 inline（两次都走 onTextEditSave → mutateLineText → editableDocumentRef）──
console.log("\n[A] 纯 inline（两改都进 editableDocumentRef）");
let a = mkDoc("02/2026");
console.log("  初始:", lineText(a));
a = mutateLineText(a, BLOCK, LINE, "05/2026", { start: 0, end: 1 }).document; // Edit#1 02→05
console.log("  Edit#1 后 doc:", lineText(a));
a = mutateLineText(a, BLOCK, LINE, "05/2027", { start: 3, end: 6 }).document; // Edit#2 2026→2027
console.log("  Edit#2 后 doc:", lineText(a));
console.log("  导出(allEditSegs=[]):", lineText(exportBoundary(a, []))); // 期望 05/2027 → 两者都在

// ── 场景 B：doc 在两改之间被「重建为原始」(inline store 被覆盖)，且 Edit#1 从未进入 segments ──
console.log("\n[B] inline store 在两改之间被重建为原始（Edit#1 只在 doc，未镜像到 segments）");
let b = mkDoc("02/2026");
b = mutateLineText(b, BLOCK, LINE, "05/2026", { start: 0, end: 1 }).document; // Edit#1 → doc="05/2026"
console.log("  Edit#1 后 doc:", lineText(b));
// 模拟某次 rebuild 把 editableDocumentRef.current 重置回原始 glyphs（覆盖 doc 中的 05）
const bReset = mkDoc("02/2026");
console.log("  * 模拟 doc 被重建为原始:", lineText(bReset));
b = mutateLineText(bReset, BLOCK, LINE, "02/2027", { start: 3, end: 6 }).document; // Edit#2 → doc="02/2027"
console.log("  Edit#2 后 doc:", lineText(b));
// 导出：allEditSegs 只有 Edit#2（Edit#1 从未进 segments）
const segsB = [seg("2027", "2026", 3, 6)];
console.log("  导出(allEditSegs=[Edit#2]):", lineText(exportBoundary(b, segsB)), "  <-- 05 是否还在？");

// ── 场景 C：两改都进 segments（segment 路径）──
console.log("\n[C] 纯 segment 路径（两改都进 segments/editedSegmentsRef）");
const segsC = [seg("05", "02", 0, 1), seg("2027", "2026", 3, 6)]; // Edit#1 + Edit#2
const c = mkDoc("02/2026");
console.log("  导出(allEditSegs=[E1,E2], doc=原始):", lineText(exportBoundary(c, segsC))); // 期望 05/2027

// ── 场景 D：Edit#1=inline(doc)，Edit#2=segment ──
console.log("\n[D] Edit#1=inline(doc)，Edit#2=segment（混合）");
let d = mkDoc("02/2026");
d = mutateLineText(d, BLOCK, LINE, "05/2026", { start: 0, end: 1 }).document; // Edit#1 → doc
console.log("  Edit#1 后 doc:", lineText(d));
const segsD = [seg("2027", "2026", 3, 6)]; // Edit#2 只进 segment
console.log("  导出(allEditSegs=[Edit#2], doc 含 Edit#1):", lineText(exportBoundary(d, segsD))); // 期望 05/2027（doc 提供 05）

console.log("\n==== END ====");
