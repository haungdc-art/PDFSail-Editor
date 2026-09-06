import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } from "pdf-lib";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
const pdf = await PDFDocument.load(bytes);
const ctx: any = (pdf as any).context;
const page = pdf.getPages()[0];
const node: any = (page as any).node;
const fontRes = node.Resources().lookup(PDFName.of("Font"), PDFDict);

function dump(ref: any, depth = 0, maxDepth = 2) {
  const obj = ctx.lookup(ref);
  if (!obj) return "null";
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  if (obj instanceof PDFDict) {
    for (const k of obj.keys()) {
      const v = obj.lookup(k);
      const kname = k.asString();
      if (v instanceof PDFRef) lines.push(`${pad}/${kname} => #${v.objectNumber}`);
      else if (v instanceof PDFDict) lines.push(`${pad}/${kname} => [dict]` + (depth < maxDepth ? "\n" + dump(v, depth + 1, maxDepth) : ""));
      else if (v instanceof PDFArray) lines.push(`${pad}/${kname} => [array len=${v.size()}]`);
      else lines.push(`${pad}/${kname} => ${typeof v === "string" ? JSON.stringify(v) : v?.toString?.().slice(0, 40)}`);
    }
  }
  return lines.join("\n");
}

const f3ref = fontRes.lookup(PDFName.of("F3+0"));
console.log("=== page级 /F3+0 完整字典 ===");
console.log(dump(f3ref, 0, 3));
