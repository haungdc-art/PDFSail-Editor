import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } from "pdf-lib";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
const pdf = await PDFDocument.load(bytes);
const ctx: any = (pdf as any).context;
const page = pdf.getPages()[0];
const node: any = (page as any).node;

const pageFonts = node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
const pageF3raw = pageFonts?.get?.(PDFName.of("F3+0")); // 原始引用（不 deref）
console.log("page 级 /F3+0 raw ref:", pageF3raw instanceof PDFRef ? "#" + pageF3raw.objectNumber : String(pageF3raw));

const contents = node.Contents();
const arr = contents instanceof PDFArray ? contents : null;
const n = arr ? arr.size() : 1;
for (let i = 0; i < n; i++) {
  try {
    const s: any = arr.lookup(i);
    const dict = s.dict;
    const sub = dict?.get?.(PDFName.of("Subtype"))?.asString?.() ?? "(none)";
    const formRes = dict?.get?.(PDFName.of("Resources"));
    let info = `stream ${i}: Subtype=${sub}`;
    if (formRes) {
      const fr = formRes.lookup?.(PDFName.of("Font"), PDFDict);
      if (fr) {
        const parts = [...fr.keys()].map((k: PDFName) => {
          const r = fr.get(k);
          return `/${k.asString()}=${r instanceof PDFRef ? "#" + r.objectNumber : "?"}`;
        });
        info += ` Form/Font={${parts.join(", ")}}`;
      }
    }
    console.log(info);
  } catch (e) {
    console.log(`stream ${i}: ERROR`, e);
  }
}
