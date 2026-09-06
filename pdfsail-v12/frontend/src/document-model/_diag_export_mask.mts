/**
 * @diagnostic 验证 export-renderer 对表格编辑行生成的 mask 命令。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`diag: unsupported element <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

import { parsePdfToEditableDocument } from "./pdf-importer";
import { renderDocumentToExportCommands } from "./export-renderer";
import type { ExportContext } from "./export-renderer";

function lineTextOf(line: any): string {
  return (line.glyphs ?? []).map((g: any) => g.char ?? g.originalChar ?? "").join("");
}

async function main() {
  const pdfPath = process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
  const abs = resolve(pdfPath);
  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);

  console.log(`载入 ${abs}`);
  const doc = await parsePdfToEditableDocument(bytes, "diag.pdf");

  // 模拟编辑 "Bidens" 行：把 69 改成 f r
  const bidensLine = doc.pages[0].blocks[0].lines.find((l: any) => lineTextOf(l).includes("Bidens"));
  if (bidensLine) {
    const glyphs = bidensLine.glyphs as any[];
    // 把 69（indices 9,10）替换为 f r
    glyphs[9].char = "f";
    glyphs[9].modified = true;
    glyphs[10].char = "r";
    glyphs[10].modified = true;
    // 中间插入一个空格 glyph
    const spaceGlyph = { ...glyphs[9], char: " ", modified: true, operatorId: undefined, operatorCharIndex: undefined };
    glyphs.splice(10, 0, spaceGlyph);
  }

  const ctx: ExportContext = {
    renderScale: 1.5,
    cssScale: 1,
    pageHeightPt: doc.pages[0].height,
    pageTopPt: doc.pages[0].height,
  };

  const commands = renderDocumentToExportCommands(doc, ctx, undefined, undefined);
  const maskCmds = commands.filter((c: any) => c.type === "drawLine" && c.purpose === "mask" && c.blockId?.includes("block0"));
  console.log(`\n### Bidens 行编辑后的 mask 命令（${maskCmds.length} 个）`);
  for (const c of maskCmds) {
    console.log(`  lineIdx=${c.lineIndex} x=${c.x.toFixed(2)} y=${c.y.toFixed(2)} w=${c.width.toFixed(2)} h=${c.height.toFixed(2)}`);
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
