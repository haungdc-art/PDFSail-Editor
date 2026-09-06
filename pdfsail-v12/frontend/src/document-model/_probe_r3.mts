import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument } from "./export-renderer";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const bytes = fs.readFileSync(ORIG);
console.log = () => {};

async function getItems(dataBytes: Uint8Array, pageIndex1Based: number) {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const pdfjs = await getDocument({ data: new Uint8Array(dataBytes), isEvalSupported: false }).promise;
  const page = await pdfjs.getPage(pageIndex1Based);
  const tc = await page.getTextContent();
  await pdfjs.destroy();
  return tc.items as any[];
}

async function main() {
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;
  const { tc, vp } = await (async () => {
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
    const pdfjs = await getDocument({ data: new Uint8Array(bytes.buffer.slice(0)), isEvalSupported: false }).promise;
    const page = await pdfjs.getPage(1);
    const t = await page.getTextContent();
    const v = page.getViewport({ scale: 1.5 });
    await pdfjs.destroy();
    return { tc: t, vp: v };
  })();
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
  const segs1 = buildSegments(lines, mapper, new FontAnalyzerImpl(), 1, undefined) as Segment[];
  const cnpjSegs = segs1.filter((s) => s.text.includes("0001-79"));
  const editSegs: Segment[] = cnpjSegs.map((seg) => {
    const t = seg.text;
    const idx = t.indexOf("0001-79");
    const s7 = idx + "0001-".length;
    const src = (seg as any).source;
    return { ...seg, id: seg.id + "_e", text: "79123", originalText: "79",
      source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex: s7, endGlyphIndex: s7 + 1 } } as any;
  });
  const updated = applySegmentEditsToDocument(doc, editSegs) as EditableDocument;
  const exported = await exportEditableDocument(updated, bytes as unknown as ArrayBuffer);

  console.error("=== EXPORTED R3 written to file ===");
  fs.writeFileSync("D:/TRAE/pdfsail-v12/_exp_r3.pdf", exported);
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const fileBytes = fs.readFileSync("D:/TRAE/pdfsail-v12/_exp_r3.pdf");
  const pdfjs = await getDocument({ data: new Uint8Array(fileBytes), isEvalSupported: false }).promise;
  const p = await pdfjs.getPage(1);
  const tc2 = await p.getTextContent();
  let all = "";
  for (const it of tc2.items as any[]) if (typeof it.str === "string") all += it.str + " | ";
  console.error("  FROM FILE pdfjs:", all.slice(0, 600));
  console.error("  has 79123:", all.includes("79123"), " has 0001:", all.includes("0001"));
  await pdfjs.destroy();
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
