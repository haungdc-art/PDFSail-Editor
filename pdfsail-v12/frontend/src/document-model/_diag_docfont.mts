import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
const pdf = await PDFDocument.load(bytes);
const ctx: any = (pdf as any).context;

function hasFont(dict: any, label: string) {
  if (!dict) { console.log(label, ": 无 Resources"); return; }
  const f = dict.lookup(PDFName.of("Font"), PDFDict);
  if (!f) { console.log(label, ": 无 /Font"); return; }
  console.log(label, "/Font:", [...f.keys()].map((k: PDFName) => "/" + k.asString()).join(", "));
}

// 文档 catalog /Resources
const catalog = (pdf as any).catalog;
hasFont(catalog.lookup(PDFName.of("Resources"), PDFDict), "catalog(文档级)");
