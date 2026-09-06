/**
 * builder-equivalence.test.ts — Builder Equivalence Golden Test（Sprint-120 · Phase 2 · Task-2）
 *
 * ADR-045 · Phase 2 Builder Integration 的 Regression Lock。
 *
 * 验证（PM Task-2 退出条件 3）：
 *   旧链：Builder → EditablePage
 *   ==
 *   新链：Builder → Page（createPage）→ Compat（domPageToEditablePage）→ EditablePage
 *
 * 输出完全等价（行为、数据结构、渲染结果一致）。
 * 这是整个 Sprint-120 的 **Regression Lock**：证明 Builder 内部重构不改变 Consumer 看到的输出。
 *
 * 等价性判定：新链与旧链产出的 EditablePage（index/width/height/blocks）深度一致。
 * 覆盖：
 *   - PDF 风格 blocks（正文/footer/stamp，含真实 glyph）
 *   - OCR 风格 blocks（materializeBlock 后的 regionType + transform）
 *   - 空页（无 block）
 *   - stamp（不可编辑，归 BaseLayer）等价性
 */
import type { EditableBlock, EditablePage } from "../types";
import { createPage } from "./page-builder";
import { domPageToEditablePage } from "./editable-page-compat";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 深比较 EditablePage（blocks 逐个字段） */
function sameBlock(a: EditableBlock, b: EditableBlock): boolean {
  if (a.id !== b.id) return false;
  if (a.type !== b.type) return false;
  if (a.regionType !== b.regionType) return false;
  if (a.source !== b.source) return false;
  if (a.bbox.x !== b.bbox.x || a.bbox.y !== b.bbox.y || a.bbox.width !== b.bbox.width || a.bbox.height !== b.bbox.height) return false;
  if (a.lines.length !== b.lines.length) return false;
  for (let i = 0; i < a.lines.length; i++) {
    if (a.lines[i].id !== b.lines[i].id) return false;
    if (a.lines[i].glyphs.length !== b.lines[i].glyphs.length) return false;
    for (let j = 0; j < a.lines[i].glyphs.length; j++) {
      const ga = a.lines[i].glyphs[j];
      const gb = b.lines[i].glyphs[j];
      if (ga.char !== gb.char || ga.styleRef !== gb.styleRef) return false;
      if (ga.bbox.x !== gb.bbox.x || ga.bbox.y !== gb.bbox.y) return false;
      if (ga.transform && gb.transform && ga.transform.join(",") !== gb.transform.join(",")) return false;
    }
  }
  return true;
}

function samePage(a: EditablePage, b: EditablePage): boolean {
  if (a.index !== b.index || a.width !== b.width || a.height !== b.height) return false;
  if (a.blocks.length !== b.blocks.length) return false;
  for (let i = 0; i < a.blocks.length; i++) {
    if (!sameBlock(a.blocks[i], b.blocks[i])) return false;
  }
  return true;
}

/** 旧链：Builder 直接产出 EditablePage */
function oldChain(metadata: { index: number; width: number; height: number }, blocks: EditableBlock[]): EditablePage {
  return { index: metadata.index, width: metadata.width, height: metadata.height, blocks };
}

/** 新链：Builder → createPage → domPageToEditablePage */
function newChain(metadata: { index: number; width: number; height: number }, blocks: EditableBlock[]): EditablePage {
  const page = createPage({ metadata, blocks });
  return domPageToEditablePage(page, blocks);
}

/** PDF 风格 blocks */
function makePdfBlocks(): EditableBlock[] {
  return [
    {
      id: "b-body",
      type: "text",
      regionType: "paragraph",
      bbox: { x: 40, y: 100, width: 500, height: 100 },
      source: "pdf_native",
      originalBounds: { x: 40, y: 100, width: 500, height: 100 },
      lines: [
        { id: "l-body", bbox: { x: 40, y: 100, width: 500, height: 20 }, glyphs: [
          { char: "H", bbox: { x: 40, y: 100, width: 12, height: 12 }, styleRef: 0, modified: false },
          { char: "i", bbox: { x: 52, y: 100, width: 6, height: 12 }, styleRef: 0, modified: false },
        ], source: "vector", style: {} },
      ],
    },
    {
      id: "b-footer",
      type: "text",
      regionType: "footer",
      bbox: { x: 40, y: 810, width: 400, height: 20 },
      source: "pdf_native",
      originalBounds: { x: 40, y: 810, width: 400, height: 20 },
      lines: [
        { id: "l-footer", bbox: { x: 40, y: 810, width: 400, height: 20 }, glyphs: [
          { char: "P", bbox: { x: 40, y: 810, width: 10, height: 12 }, styleRef: 0, modified: false },
          { char: "1", bbox: { x: 50, y: 810, width: 8, height: 12 }, styleRef: 0, modified: false },
        ], source: "vector", style: {} },
      ],
    },
    {
      id: "b-stamp",
      type: "text",
      regionType: "stamp",
      bbox: { x: 20, y: 300, width: 80, height: 80 },
      source: "pdf_native",
      originalBounds: { x: 20, y: 300, width: 80, height: 80 },
      lines: [
        { id: "l-stamp", bbox: { x: 20, y: 300, width: 80, height: 80 }, glyphs: [
          { char: "X", bbox: { x: 20, y: 300, width: 80, height: 80 }, styleRef: 0, modified: false },
        ], source: "vector", style: {} },
      ],
    },
  ];
}

/** OCR 风格 blocks（含 transform） */
function makeOcrBlocks(): EditableBlock[] {
  return [
    {
      id: "ocr-sig",
      type: "text",
      regionType: "signature",
      bbox: { x: 400, y: 600, width: 150, height: 80 },
      source: "ocr",
      originalBounds: { x: 400, y: 600, width: 150, height: 80 },
      lines: [
        { id: "ocr_sig_l0", bbox: { x: 400, y: 600, width: 150, height: 20 }, glyphs: [
          { char: "J", bbox: { x: 400, y: 600, width: 20, height: 16 }, styleRef: 1, modified: false, transform: [0.7, 0.7, -0.7, 0.7, 0, 0] },
          { char: "W", bbox: { x: 425, y: 600, width: 25, height: 16 }, styleRef: 1, modified: false, transform: [0.7, 0.7, -0.7, 0.7, 0, 0] },
        ], source: "vector", style: {} },
      ],
    },
    {
      id: "ocr-title",
      type: "text",
      regionType: "paragraph",
      bbox: { x: 40, y: 50, width: 500, height: 40 },
      source: "ocr",
      originalBounds: { x: 40, y: 50, width: 500, height: 40 },
      lines: [
        { id: "ocr_t_l0", bbox: { x: 40, y: 50, width: 500, height: 20 }, glyphs: [
          { char: "I", bbox: { x: 40, y: 50, width: 10, height: 14 }, styleRef: 2, modified: false },
          { char: "N", bbox: { x: 52, y: 50, width: 15, height: 14 }, styleRef: 2, modified: false },
        ], source: "vector", style: {} },
      ],
    },
  ];
}

function testPdfEquivalence(): void {
  console.group("① PDF 风格：旧链 == 新链（正文/footer/stamp）");
  const metadata = { index: 1, width: 595, height: 842 };
  const blocks = makePdfBlocks();
  const oldE = oldChain(metadata, blocks);
  const newE = newChain(metadata, blocks);
  assert(samePage(oldE, newE), "EditablePage 完全等价（含 stamp 顺序/内容）");
  assert(oldE.blocks.length === 3 && newE.blocks.length === 3, "3 个 block 全部保留");
  assert(newE.blocks[2].id === "b-stamp", "stamp 在 EditablePage.blocks（等价性，非被剔除）");
  console.groupEnd();
}

function testOcrEquivalence(): void {
  console.group("② OCR 风格：旧链 == 新链（signature transform + title）");
  const metadata = { index: 2, width: 595, height: 842 };
  const blocks = makeOcrBlocks();
  const oldE = oldChain(metadata, blocks);
  const newE = newChain(metadata, blocks);
  assert(samePage(oldE, newE), "OCR EditablePage 完全等价（含 transform）");
  const sig = newE.blocks.find((b) => b.id === "ocr-sig");
  assert(!!sig && sig.lines[0].glyphs[0].transform?.join(",") === "0.7,0.7,-0.7,0.7,0,0", "signature transform 保留（等价）");
  console.groupEnd();
}

function testEmptyPageEquivalence(): void {
  console.group("③ 空页：旧链 == 新链（无 block）");
  const metadata = { index: 3, width: 595, height: 842 };
  const oldE = oldChain(metadata, []);
  const newE = newChain(metadata, []);
  assert(samePage(oldE, newE), "空页 EditablePage 完全等价");
  assert(newE.blocks.length === 0, "空页 blocks=[]（合法 Data）");
  console.groupEnd();
}

function testPdfFallbackNotInEditable(): void {
  console.group("④ PdfFallback 不进 EditablePage（等价性 + Builder Contract）");
  const metadata = { index: 1, width: 595, height: 842 };
  const blocks = makePdfBlocks();
  const page = createPage({ metadata, blocks });
  // Page 的 BaseLayer 含 PdfFallback（Builder Contract）
  assert(page.layers.base.some((o) => o.type === "PdfFallback"), "Page.BaseLayer 含 PdfFallback（结构）");
  // 但 compat 后 EditablePage.blocks 不含 PdfFallback（无 sourceId，非原始 block）
  const editablePage = domPageToEditablePage(page, blocks);
  assert(editablePage.blocks.length === blocks.length, "EditablePage.blocks 只含原始 block，无 PdfFallback");
  assert(!editablePage.blocks.some((b) => b.id.includes("pdf-fallback")), "PdfFallback 不是 EditableBlock，不进 EditablePage");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Builder Equivalence Golden Test (Sprint-120 · Phase 2 · Task-2) ──", "font-weight:bold;color:#8b5cf6;");
  testPdfEquivalence();
  testOcrEquivalence();
  testEmptyPageEquivalence();
  testPdfFallbackNotInEditable();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("builder-equivalence.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
