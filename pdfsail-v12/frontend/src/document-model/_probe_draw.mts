import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const bytes = fs.readFileSync(ORIG);

async function main() {
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(0);
  const helv = await pdf.embedFont("Helvetica");
  // draw a known string at a known spot
  page.drawText("TEST79123", { x: 100, y: 500, size: 10, font: helv });
  const out = await pdf.save();
  console.error("saved len", out.length, "contains TEST79123 bytes:", Buffer.from(out).toString("latin1").includes("TEST79123"));

  // Now extract with pdfjs
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const pdfjs = await getDocument({ data: new Uint8Array(out), isEvalSupported: false }).promise;
  const p = await pdfjs.getPage(1);
  const tc = await p.getTextContent();
  let all = "";
  for (const it of tc.items as any[]) if (typeof it.str === "string") all += it.str + " | ";
  console.error("pdfjs extracted:", all.slice(0, 300));
  console.error("contains TEST79123 in extraction:", all.includes("TEST79123"));
  await pdfjs.destroy();
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
