/**
 * @diagnostic 检查 unicodeText 解码与顺序
 * 用法: npx tsx _diag_ytrace_11_align.mts <PDF>
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFName } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects, makeFontDictResolver, parseToUnicodeCMap } from "./content-stream-resolver";

(globalThis as any).document = { createElement(t: string) { return t === "canvas" ? createCanvas(1, 1) : ({} as any); } };

async function main() {
  const p = process.argv[2];
  if (!p || !existsSync(resolve(p))) { console.error("usage"); process.exit(2); }
  const abs = resolve(p);
  const raw = readFileSync(abs);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  const doc = await parsePdfToEditableDocument(bytes, "diag.pdf");
  const pdfLibDoc = await PDFDocument.load(new Uint8Array(Uint8Array.from(bytes).buffer), { ignoreEncryption: true, throwOnInvalidObject: false });
  const page = doc.pages[0];
  const records = resolvePageShowTextWithXObjects(pdfLibDoc, 0);

  const withUni = records.filter((r) => !!r.unicodeText).length;
  console.log(`算子总数=${records.length} 有 unicodeText=${withUni}`);
  console.log(`首个有 unicodeText 的算子: ${JSON.stringify((records.find((r) => r.unicodeText)?.unicodeText ?? "").slice(0, 40))}`);

  const opStream: string[] = [];
  for (const r of records) for (const ch of (r.unicodeText ?? "")) opStream.push(ch);
  console.log(`[A] opStream(unicodeText) 长度=${opStream.length}`);

  const glyphs: any[] = [];
  for (const b of page.blocks) for (const l of b.lines) for (const g of l.glyphs) glyphs.push(g);
  console.log(`[B] glyph 长度=${glyphs.length}`);
  const gc = glyphs.map((g) => (typeof g.char === "string" ? g.char : " "));
  console.log(`[C] glyph.char 前 40: ${JSON.stringify(gc.slice(0, 40).join(""))}`);
  console.log(`[C] opStream   前 40: ${JSON.stringify(opStream.slice(0, 40).join(""))}`);

  let first = -1;
  const min = Math.min(glyphs.length, opStream.length);
  for (let i = 0; i < min; i++) { if (gc[i] !== opStream[i]) { first = i; break; } }
  console.log(`首个 unicode 不匹配位置 i=${first}`);
  if (first >= 0) {
    console.log(`  glyph[${first - 3}..${first + 3}] = ${JSON.stringify(gc.slice(first - 3, first + 4).join(""))}`);
    console.log(`  op   [${first - 3}..${first + 3}] = ${JSON.stringify(opStream.slice(first - 3, first + 4).join(""))}`);
  }

  // ── 直接探针：首个算子的字体是否有 /ToUnicode，parser 返回什么 ──
  const page0 = pdfLibDoc.getPage(0) as any;
  const resDict = (page0.node.Resources?.() as any) ?? undefined;
  const resolver = makeFontDictResolver(pdfLibDoc, resDict);
  const firstRec = records.find((r) => r.fontResourceKey);
  if (firstRec) {
    const fd = resolver(firstRec.fontResourceKey);
    console.log(`\n[探针] 首个算子 fontResourceKey=${firstRec.fontResourceKey} fontDict=${fd ? "存在" : "缺失"}`);
    if (fd) {
      const tu = fd.get(PDFName.of("ToUnicode") as any);
      console.log(`  /ToUnicode 字段类型=${tu?.constructor?.name} toString=${String(tu).slice(0, 30)}`);
      const cmap = parseToUnicodeCMap(fd, pdfLibDoc);
      console.log(`  parseToUnicodeCMap 返回=${cmap ? "Map(" + cmap.size + ")" : "null"}`);
      if (cmap) {
        const sample = [...cmap.entries()].slice(0, 5);
        console.log(`  ToUnicode 样本: ${JSON.stringify(sample)}`);
      }
    }
  }
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
