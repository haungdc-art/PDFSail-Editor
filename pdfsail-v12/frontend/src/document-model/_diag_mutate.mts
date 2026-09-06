/**
 * @diagnostic 复现行编辑：对 "1.057" 行做整行替换 "1.059"，
 * 检查 mutateLineText 是否保留 bbox.y / baseline（即 useOrigPos 是否生效）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

(globalThis as any).document = {
  createElement(tag: string) { if (tag === "canvas") return createCanvas(1, 1); throw new Error(`diag: <${tag}>`); },
  getElementsByTagName: () => [] as any,
  createElementNS: (_n: string, t: string) => (globalThis as any).document.createElement(t),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

import { parsePdfToEditableDocument } from "./pdf-importer";
import { mutateLineText } from "./document-mutation";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function lineTextOf(line: any): string {
  return (line.glyphs ?? []).map((g: any) => g.char ?? g.originalChar ?? g.text ?? "").join("");
}

async function main() {
  const pdfPath = process.argv[2];
  const abs = resolve(pdfPath);
  const bytes = new Uint8Array(readFileSync(abs).buffer, readFileSync(abs).byteOffset, readFileSync(abs).byteLength);
  console.log(`载入 ${abs}`);
  const doc = await parsePdfToEditableDocument(bytes, "diag.pdf");

  // 找 "1.057" 行
  let target: { page: any; block: any; line: any } | null = null;
  for (const page of doc.pages) for (const block of page.blocks) for (const line of block.lines) {
    if (lineTextOf(line).includes("1.057")) { target = { page, block, line }; break; }
  }
  if (!target) { console.log("未找到 1.057 行"); process.exit(1); }
  const { block, line } = target;
  console.log(`\n找到行 block=${block.id} line=${line.id}`);
  console.log(`  原文本="${lineTextOf(line)}"`);
  console.log(`  原 glyph[0]: bbox.y=${r(line.glyphs[0]?.bbox?.y)} h=${r(line.glyphs[0]?.bbox?.height)} baseline=${r(line.glyphs[0]?.baseline)}`);

  // 整行替换：1.057 -> 1.059
  const newText = lineTextOf(line).replace("1.057", "1.059");
  console.log(`  新文本="${newText}"`);

  const res = mutateLineText(doc, block.id, line.id, newText);
  console.log(`  mutated=${res.mutated}`);

  // 找到结果文档中对应行
  const doc2 = res.document;
  let out: any = null;
  for (const page of doc2.pages) for (const b of page.blocks) if (b.id === block.id) for (const l of b.lines) if (l.id === line.id) out = l;
  if (!out) { console.log("结果行未找到"); process.exit(1); }
  console.log(`\n=== 替换后 glyph 几何 ===`);
  out.glyphs.forEach((g: any, i: number) => {
    const b = g.bbox ?? {};
    console.log(`  [${i}] ch=${JSON.stringify(g.char)} bbox.y=${r(b.y)} h=${r(b.height)} baseline=${r(g.baseline)} modified=${g.modified}`);
  });
  const ob = line.glyphs[0]?.bbox ?? {};
  const nb = out.glyphs[0]?.bbox ?? {};
  console.log(`\n=== 对比 glyph[0] ===`);
  console.log(`  原 bbox.y=${r(ob.y)} baseline=${r(line.glyphs[0]?.baseline)}`);
  console.log(`  新 bbox.y=${r(nb.y)} baseline=${r(out.glyphs[0]?.baseline)}`);
  console.log(`  Δbbox.y=${r((nb.y ?? 0) - (ob.y ?? 0))}  Δbaseline=${r((out.glyphs[0]?.baseline ?? 0) - (line.glyphs[0]?.baseline ?? 0))}`);
}
function r(n: any) { return typeof n === "number" ? Math.round(n * 1000) / 1000 : n; }
main().catch((e) => { console.error("异常:", e); process.exit(1); });
