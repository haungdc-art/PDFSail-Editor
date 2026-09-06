import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects, type TextShowRecord } from "./content-stream-resolver";
import type { EditableGlyph } from "./types";

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? { getContext: () => ({ measureText: () => ({ width: 5 }), font: "" }) } : ({ getContext: () => null } as any)) };
}

function allGlyphs(doc: any): EditableGlyph[] {
  const out: EditableGlyph[] = [];
  for (const page of doc.pages) for (const b of page.blocks) for (const l of b.lines) for (const g of l.glyphs) out.push(g);
  return out;
}

async function main() {
  const pdfPath = process.argv[2];
  const bytes = fs.readFileSync(pdfPath);
  const pdfLibDoc = await PDFDocument.load(bytes);
  const doc = await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdfLibDoc);
  const recs = resolvePageShowTextWithXObjects(pdfLibDoc, 0) as TextShowRecord[];
  console.log(`总算子数 = ${recs.length}`);
  const byOp: Record<string, number> = {};
  const bySub: Record<string, number> = {};
  let withTU = 0, withUni = 0, withCharCodes = 0;
  for (const r of recs) {
    byOp[r.op] = (byOp[r.op] ?? 0) + 1;
    bySub[(r as any).subtype ?? "(无)"] = (bySub[(r as any).subtype] ?? 0) + 1;
    if ((r as any).hasToUnicode) withTU++;
    if (r.unicodeText) withUni++;
    if (r.charCodes) withCharCodes++;
  }
  console.log("op 分布:", JSON.stringify(byOp));
  console.log("字体 subtype 分布:", JSON.stringify(bySub));
  console.log(`hasToUnicode=${withTU}, 有unicodeText=${withUni}, 有charCodes=${withCharCodes}`);
  // 列出前 12 个算子摘要
  console.log("\n前 12 算子：");
  for (let i = 0; i < Math.min(12, recs.length); i++) {
    const r = recs[i];
    console.log(`  #${i} op=${r.op} sub=${(r as any).subtype} isForm=${(r as any).isFormXObject} hasTU=${(r as any).hasToUnicode} uni=${JSON.stringify(r.unicodeText)} opId=${r.operatorId}`);
  }
  // 无 provenance 的 glyph 对应的 operatorId 集合
  const glyphs = allGlyphs(doc);
  const noProv = glyphs.filter((g) => !g.operatorId);
  console.log(`\n无 operatorId 的 glyph 数 = ${noProv.length}`);
  // 孤儿算子 = 没有任何 glyph 引用其 operatorId
  const referenced = new Set(noProv.length >= 0 ? glyphs.filter((g) => g.operatorId).map((g) => g.operatorId) : []);
  console.log("孤儿算子（无 glyph 引用）：");
  let orphanN = 0;
  for (const r of recs) {
    if (referenced.has(r.operatorId)) continue;
    orphanN++;
    console.log(`  opId=${r.operatorId} op=${r.op} sub=${(r as any).subtype} isForm=${(r as any).isFormXObject} hasTU=${(r as any).hasToUnicode} uni=${JSON.stringify(r.unicodeText)} charCodes=${r.charCodes ? "有(" + r.charCodes.length + ")" : "null"}`);
  }
  console.log(`孤儿算子总数 = ${orphanN}`);
  // 验证：G 中是否包含某孤儿算子的 unicodeText
  const G = glyphs.map((g) => g.char ?? "").join("");
  console.log(`\nG 长度 = ${G.length}`);
  for (const r of recs) {
    if (referenced.has(r.operatorId)) continue;
    const u = r.unicodeText ?? "";
    const idx = G.indexOf(u);
    console.log(`  孤儿"${u.slice(0, 20)}" 在 G 中 indexOf = ${idx}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
