import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const b = fs.readFileSync(ORIG);
const pdf = await PDFDocument.load(b);
const recs = resolvePageShowTextWithXObjects(pdf, 0) as any[];
console.error("records count =", recs.length);
console.error("keys of rec[0] =", Object.keys(recs[0]));
// 找含 79 或 YULM 的 record
const hit = recs.find(r => JSON.stringify(r).includes("79") || JSON.stringify(r).includes("YULM"));
console.error("sample hit =", hit ? JSON.stringify(hit).slice(0, 300) : "NONE");
// 打印所有出现的字段值样例
for (const r of recs.slice(0, 3)) {
  console.error("rec:", "operatorText=", JSON.stringify(r.operatorText), "text=", JSON.stringify((r as any).text), "op=", r.op, "streamObjRef=", r.streamObjRef);
}
