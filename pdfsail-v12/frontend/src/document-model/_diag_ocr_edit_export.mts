/**
 * _diag_ocr_edit_export — 诊断：OCR 文档（无原生文本层）编辑后导出是否包含新文本。
 *
 * 场景：
 *   A. 单行 block：mutateLineText 编辑 → 导出
 *   B. 段落 block（多行）：模拟 PDFEditor.commitBlockTextToDocument 的行拆分逻辑 → 导出
 *
 * 验证点：导出 PDF 是否含新文本（"2027" / "04 dia"）。
 */
import fs from "node:fs";
import { mutateLineText } from "./document-mutation";
import { exportEditableDocument } from "./export-renderer";
import type {
  EditableDocument,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
} from "./types";

const ORIG =
  "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784590595078-uyi5ct4hd.pdf";

const renderScale = 1.5;
const cssScale = 1;
const pageWidthCss = 1861 * renderScale * cssScale;
const pageHeightCss = 2631.4 * renderScale * cssScale;

const style: EditableStyle = {
  fontFamily: "Helvetica, Arial, sans-serif",
  fontSize: 18,
  fontWeight: 400,
  fontStyle: "normal",
  color: "#000000",
  lineHeight: 22,
};

function buildLine(id: string, text: string, x0: number, y0: number): EditableLine {
  const glyphs: EditableGlyph[] = [];
  let x = x0;
  for (const ch of text) {
    const w = ch === " " ? 5 : 9;
    glyphs.push({
      char: ch,
      originalChar: ch,
      bbox: { x, y: y0, width: w, height: 18 },
      originalBBox: { x, y: y0, width: w, height: 18 },
      styleRef: 0,
      modified: false,
      transform: [1, 0, 0, 1, 0, 0],
      baseline: y0 + 14,
    });
    x += w;
  }
  return {
    id,
    source: "vector",
    bbox: { x: x0, y: y0, width: x - x0, height: 18 },
    baseline: y0 + 14,
    glyphs,
    style: { ...style },
  };
}

function buildDoc(lines: EditableLine[]): EditableDocument {
  const block = {
    id: "ocr_block_1",
    type: "text",
    bbox: {
      x: Math.min(...lines.map((l) => l.bbox.x)),
      y: Math.min(...lines.map((l) => l.bbox.y)),
      width: Math.max(...lines.map((l) => l.bbox.x + l.bbox.width)) - Math.min(...lines.map((l) => l.bbox.x)),
      height: Math.max(...lines.map((l) => l.bbox.y + l.bbox.height)) - Math.min(...lines.map((l) => l.bbox.y)),
    },
    source: "ocr",
    lines,
    layoutMode: "reconstruct",
    regionType: "paragraph",
  } as EditableBlock;
  return {
    pages: [{ index: 1, width: pageWidthCss, height: pageHeightCss, blocks: [block] }],
    styles: [style],
    metadata: { fileName: "diag.pdf", pageCount: 1, createdAt: Date.now() },
    runtime: { renderScale, cssScale, pageMetrics: [{ width: 1861, height: 2631.4 }] },
  };
}

/**
 * PDFEditor.commitBlockTextToDocument 的行拆分逻辑（与本诊断保持同源）。
 */
function splitParagraphToLines(target: any, text: string): string[] {
  const lineTexts: string[] = target.lines.map((l: any) =>
    (l.glyphs ?? []).map((g: any) => g.char).join("")
  );
  const byNewline = text.split("\n");
  if (byNewline.length === target.lines.length) return byNewline;
  const total = lineTexts.reduce((s: number, t: string) => s + t.length, 0);
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < lineTexts.length - 1; i++) {
    const take = total > 0 ? Math.round((text.length * lineTexts[i].length) / total) : 0;
    out.push(text.slice(pos, pos + take));
    pos += take;
  }
  out.push(text.slice(pos));
  return out;
}

async function extractText(bytes: Uint8Array): Promise<string> {
  const mod: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await mod.getDocument({ data: bytes.slice(), useSystemFonts: true, isEvalSupported: false }).promise;
  let all = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    all += (tc.items as any[]).map((i) => i.str ?? "").join("");
  }
  return all;
}

/** 去掉逐字符渲染插入的空格后比较（导出是逐 glyph 绘制，字符间有空格） */
const squash = (s: string) => s.replace(/\s+/g, "");

async function runCase(
  label: string,
  lines: EditableLine[],
  apply: (doc: EditableDocument) => EditableDocument
) {
  const origBytes = new Uint8Array(fs.readFileSync(ORIG));
  const doc = buildDoc(lines);
  const edited = apply(doc);
  const outBytes = await exportEditableDocument(edited, origBytes);
  const outText = await extractText(outBytes);
  const flat = squash(outText);
  console.log(
    `[${label}] size=${outBytes.length} has2027=${flat.includes("2027")} has2026=${flat.includes("2026")} ` +
      `has04dia=${flat.includes("04dia(s)")} has02dia=${flat.includes("02dia(s)")}`
  );
  const editedBlock = edited.pages[0].blocks[0] as EditableBlock;
  for (const l of editedBlock.lines) {
    console.log(`   line: "${l.glyphs.map((g) => g.char).join("")}"`);
  }
}

async function main() {
  const L1 =
    "Atesto que JENNIFER MARTINS DE OLIVEIRA necessita de 02 dia(s) de afastamento do trabalho, a partir de 03/04/2026, para tratamento de saúde.";
  const L1_NEW =
    "Atesto que JENNIFER MARTINS DE OLIVEIRA necessita de 04 dia(s) de afastamento do trabalho, a partir de 03/04/2027, para tratamento de saúde.";

  // ── 场景 A：单行 block ──
  await runCase("A-单行", [buildLine("ocr_init_l0", L1, 200, 800)], (doc) => {
    const r = mutateLineText(doc, "ocr_block_1", "ocr_init_l0", L1_NEW);
    return r.document;
  });

  // ── 场景 B：段落 block（2 行），用户在 Portal 编辑整段（无换行） ──
  const P1 = "Atesto que JENNIFER MARTINS DE OLIVEIRA necessita de 02 dia(s) de afastamento do";
  const P2 = "trabalho, a partir de 03/04/2026, para tratamento de saúde.";
  const P_NEW =
    "Atesto que JENNIFER MARTINS DE OLIVEIRA necessita de 04 dia(s) de afastamento do trabalho, a partir de 03/04/2027, para tratamento de saúde.";
  await runCase(
    "B-段落2行",
    [buildLine("ocr_init_l0", P1, 200, 800), buildLine("ocr_init_l1", P2, 200, 826)],
    (doc) => {
      const block: any = doc.pages[0].blocks[0];
      const newLines = splitParagraphToLines(block, P_NEW);
      let next = doc;
      for (let i = 0; i < block.lines.length; i++) {
        const r = mutateLineText(next, "ocr_block_1", block.lines[i].id, newLines[i] ?? "");
        next = r.document;
      }
      return next;
    }
  );
}

main().catch((e) => {
  console.error("DIAG FAILED:", e);
  process.exit(1);
});
