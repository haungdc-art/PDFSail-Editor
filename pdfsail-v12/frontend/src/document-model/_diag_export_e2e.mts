/**
 * @diagnostic 端到端导出验证：模拟编辑表格 PDF，导出并检查编辑行的绘制路径。
 */
import { readFileSync, writeFileSync } from "node:fs";
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

// 捕获导出日志，判断编辑行走哪条路径
const capturedLogs: string[] = [];
const origLog = console.log.bind(console);
console.log = (...args: any[]) => {
  capturedLogs.push(args.map(String).join(" "));
  origLog(...args);
};

import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument } from "./export-renderer";
import { mapNewTextToOriginalGlyphs } from "./glyph-mapping";

function lineTextOf(line: any): string {
  return (line.glyphs ?? []).map((g: any) => g.char ?? g.originalChar ?? "").join("");
}

async function main() {
  const pdfPath = process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
  const abs = resolve(pdfPath);
  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);

  origLog(`载入 ${abs}`);
  const doc = await parsePdfToEditableDocument(bytes, "diag.pdf");

  // 找到 Bidens 行，用真实的 mutateLineText 路径把它改成 "4 Bidens f r"
  const block = doc.pages[0].blocks.find((b: any) =>
    b.lines.some((l: any) => lineTextOf(l).includes("Bidens"))
  ) as any;
  const lineIdx = block.lines.findIndex((l: any) => lineTextOf(l).includes("Bidens"));
  const line = block.lines[lineIdx];
  const oldText = lineTextOf(line);
  origLog(`\n原行: "${oldText}"`);

  const newText = oldText.slice(0, 9) + "f r"; // 69 -> f r
  origLog(`新行: "${newText}"`);

  const styleRef = line.glyphs[0]?.styleRef ?? 0;
  const style = block.styles?.[styleRef] ?? doc.styles?.[styleRef] ?? {};
  const res = mapNewTextToOriginalGlyphs(line.glyphs, newText, style, styleRef, { start: 9, end: 10 });
  line.glyphs = res.newGlyphs;
  line.edited = true;

  origLog(`\n编辑后 glyph 布局:`);
  res.newGlyphs.forEach((g: any, i: number) => {
    origLog(`  [${i}] "${g.char}" x=${g.bbox.x.toFixed(2)} w=${g.bbox.width.toFixed(2)} modified=${g.modified}`);
  });

  capturedLogs.length = 0;
  const outBytes = await exportEditableDocument(doc, bytes);
  writeFileSync(resolve("../../_diag_export_e2e_out.pdf"), outBytes);
  origLog(`\n### 导出完成: ${outBytes.length} bytes`);

  origLog(`\n### 编辑行相关日志:`);
  for (const l of capturedLogs) {
    if (/l6|NATIVE_REPLAY|PDFdraw|DrawGlyph|Bidens|EDITED_LINE|R3\]/.test(l)) {
      origLog("  " + l.replace(/%c/, "").replace(/color:[^"']*/g, ""));
    }
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
