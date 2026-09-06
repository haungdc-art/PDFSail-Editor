import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream } from "pdf-lib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument, EditableLine } from "./types";
import type { Segment } from "../editor-engine/types";

GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const _log = console.log.bind(console);
const SUPPRESS = /\[?(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|SignatureRotationTrace|M7\.8-022A|NATIVE_DISABLED|M7\.8-035|M7\.8-036|M7\.8-037|provenance|Provenance|009B-2a)/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };

// 复刻 segmentEditBinding.findLineBySource
function findLineBySource(doc: EditableDocument, blockId: string, lineId: string): EditableLine | undefined {
  for (const page of doc.pages) {
    const block = page.blocks.find((b) => b.id === blockId);
    if (block) return block.lines.find((l) => l.id === lineId);
  }
  return undefined;
}

async function getTextContent(pageIndex1Based: number) {
  const pdfjs = await getDocument({ data: new Uint8Array(fs.readFileSync(ORIG).buffer.slice(0)), isEvalSupported: false }).promise;
  const page = await pdfjs.getPage(pageIndex1Based);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1.5 });
  await pdfjs.destroy();
  return { tc, vp };
}

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf)) as EditableDocument;

  // ============================================================
  // PART 1 — P1：page 1（EditableDocument page.index=1）YULM 行
  //   验证：Segment edit → mutation 成功，但 strip 因 operatorId 缺口失败
  // ============================================================
  _log("\n########## PART 1 — P1 (page.index=1) YULM 行 strip 缺口 ##########");
  const p1 = doc.pages.find((p) => p.index === 1)!;
  const yulmLine = p1.blocks[0].lines.find((l) => l.glyphs.map((g) => g.char).join("").includes("0001-79"))!;
  const lineText = yulmLine.glyphs.map((g) => g.char).join("");
  _log(`  line.id=${yulmLine.id} glyphs=${yulmLine.glyphs.length}`);
  _log(`  text="${lineText.slice(0, 60)}..."`);
  // 真实子区间编辑：把 "79" 改成 "79123"（变长 +3，正是用户描述的 case）
  const cnpjIdx = lineText.indexOf("0001-79");
  const s = cnpjIdx + "0001-".length; // "7" 的 glyph 下标
  _log(`  "/0001-79" 起点 glyph 下标 s=${s}`);
  const seg: Segment = {
    id: "seg_sim", text: "79123", originalText: "79",
    source: { blockId: "pdf_p1_block0", lineId: "pdf_pdf_p1_block0_l" + p1.blocks[0].lines.indexOf(yulmLine), startGlyphIndex: s, endGlyphIndex: s + 1 },
  } as any;
  const updated = applySegmentEditsToDocument(doc, [seg]) as EditableDocument;
  const upLine = updated.pages.find((p) => p.index === 1)!.blocks[0].lines.find((l) => l.id === yulmLine.id)!;
  const upText = upLine.glyphs.map((g) => g.char).join("");
  _log(`  mutation 后文本="${upText.slice(0, 60)}..."`);
  const modGlyphs = upLine.glyphs.filter((g: any) => g.modified);
  _log(`  modified glyphs 数=${modGlyphs.length}`);
  _log(`  modified glyphs 明细: ${modGlyphs.map((g: any) => `${JSON.stringify(g.char)} opId=${g.operatorId ?? "UNDEF"}`).join(", ")}`);
  const modWithOpId = modGlyphs.filter((g: any) => !!g.operatorId);
  _log(`  → 带 operatorId 的 modified glyphs = ${modWithOpId.length}  (strip 只收这些)`);

  // 复刻 stripReplacedTextOperators 的 opId 收集逻辑（不依赖导出函数本身）
  const opIds = new Set<string>();
  for (const page of updated.pages) for (const b of page.blocks) for (const l of b.lines) for (const g of l.glyphs) {
    const gg = g as any; if (gg.modified && gg.operatorId) opIds.add(gg.operatorId);
  }
  _log(`  strip 会收集的 operatorId 数=${opIds.size} -> ${[...opIds].join(",") || "(空 => 原 operator 永不被剥, 原文残留)"}`);

  // ============================================================
  // PART 2 — P2/P3：复刻生产 Segment 构建路径，测试 findLineBySource
  // ============================================================
  for (const pIdx of [2, 3]) {
    _log(`\n########## PART 2 — P${pIdx} (page.index=${pIdx}) Segment 解析 ##########`);
    const target = doc.pages.find((p) => p.index === pIdx)!;
    const blockId = target.blocks[0].id;
    _log(`  EditableDocument blockId=${blockId} 实际 EditableLine 数=${target.blocks[0].lines.length}`);
    _log(`  实际 EditableLine.id 清单: ${target.blocks[0].lines.map((l) => l.id).join(", ")}`);

    const { tc, vp } = await getTextContent(pIdx);
    const glyphs = extractGlyphs(tc as any);
    const lines = groupIntoLines(glyphs);
    _log(`  extractGlyphs+groupIntoLines 产生 LineGroup 数=${lines.length}`);
    const mapper = new CoordinateMapperImpl({
      viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1,
      originXDevice: vp.transform[4], originYDevice: vp.transform[5],
    } as any);
    const fontAnalyzer = new FontAnalyzerImpl();
    const built = buildSegments(lines, mapper, fontAnalyzer, pIdx, undefined) as Segment[];
    const withSource = built.filter((s) => (s as any).source);
    _log(`  构建 Segment 数=${built.length}，带 source 的=${withSource.length}`);
    let resolved = 0, unresolved = 0;
    const examples: string[] = [];
    for (const s of withSource) {
      const src = (s as any).source;
      const hit = findLineBySource(doc, src.blockId, src.lineId);
      if (hit) resolved++; else { unresolved++; if (examples.length < 6) examples.push(`seg.source.lineId=${src.lineId} (文本片="${s.text.slice(0, 18)}")`); }
    }
    _log(`  → findLineBySource 命中=${resolved} / 未命中=${unresolved}`);
    for (const e of examples) _log(`     未命中: ${e}`);

    // 复现“存储 source 与导出时 EditableDocument 发散”的两种典型情形：
    // (A) 创建 segment 时用 0-based page（blockId 写成 pdf_p${pIdx-1}_block0）→ 命中到错误页/或 undefined
    // (B) 行被重新分组（lineIdx 偏移 +N）→ 该 lineId 不存在 → undefined
    const probe = withSource[Math.min(3, withSource.length - 1)] as any;
    const ps = probe.source;
    const wrongBase = findLineBySource(doc, `pdf_p${pIdx - 1}_block0`, `pdf_pdf_p${pIdx - 1}_block0_l${ps.lineId.split("_l")[1]}`);
    _log(`  [发散A: 0-based blockId] seg 落到 pdf_p${pIdx - 1}_block0 → ${wrongBase ? "命中(但属错误页!)" : "undefined(整组被跳过)"}`);
    const offIdx = Number(ps.lineId.split("_l")[1]) + 5;
    const wrongLine = findLineBySource(doc, ps.blockId, `pdf_${ps.blockId}_l${offIdx}`);
    _log(`  [发散B: lineIdx+5 重分组] lineId=..._l${offIdx} → ${wrongLine ? "命中(错误行)" : "undefined(整组被跳过)"}`);
    _log(`  ⇒ 任一发散都会让 applySegmentEditsToDocument 的 findLineBySource 返回 undefined → break → 该页编辑整组丢弃 → 导出=原文`);
  }
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
