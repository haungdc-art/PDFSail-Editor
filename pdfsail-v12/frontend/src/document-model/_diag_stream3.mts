import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFDict } from "pdf-lib";
import { inflateSync } from "node:zlib";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
const pdf = await PDFDocument.load(bytes);
const page = pdf.getPages()[0];
const node: any = (page as any).node;
const contents = node.Contents();
const arr = contents instanceof PDFArray ? contents : null;
const last = arr ? arr.lookup(arr.size() - 1) : contents;
const raw = last.getContents();
const dec = raw[0] === 0x78 ? inflateSync(raw) : raw;
writeFileSync("d:/TRAE/pdfsail-v12/_diag_user_stream3.txt", dec.toString("latin1"));
console.log("stream3 字节数:", dec.length);

// 统计 q / Q 平衡（顶层）
let q = 0, Q = 0;
const txt = dec.toString("latin1");
for (const m of txt.matchAll(/\b[qQ]\b/g)) { if (m[0] === "q") q++; else Q++; }
console.log("顶层 q 数:", q, "Q 数:", Q);
// 列出所有 BT/ET 与 rg/RG 顺序
const ops = txt.match(/\b(BT|ET|rg|RG|cm|Tm|Tf|Tj|q|Q)\b/g) || [];
console.log("算子序列(前80):", ops.slice(0, 80).join(" "));
