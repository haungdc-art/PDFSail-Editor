import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } from "pdf-lib";
import { inflateSync } from "node:zlib";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
const pdf = await PDFDocument.load(bytes);
const ctx: any = (pdf as any).context;
const page = pdf.getPages()[0];
const node: any = (page as any).node;

const fontRes = node.Resources().lookup(PDFName.of("Font"), PDFDict);
for (const key of fontRes.keys()) {
  const fref = fontRes.lookup(key) as any;
  const obj = ctx.lookup(fref) as any;
  const subtype = obj.lookup(PDFName.of("Subtype"))?.asString?.();
  const baseFont = obj.lookup(PDFName.of("BaseFont"))?.asString?.();
  const fd = obj.lookup(PDFName.of("FontDescriptor")) || (() => {
    const df = obj.lookup(PDFName.of("DescendantFonts")) as any;
    if (df instanceof PDFArray && df.size() > 0) return df.lookup(0).lookup(PDFName.of("FontDescriptor"));
    return null;
  })();
  let fontFile = "NONE!";
  if (fd) for (const fn of ["FontFile", "FontFile2", "FontFile3"]) {
    const ff = fd.lookup(PDFName.of(fn));
    if (ff) fontFile = fn + ":" + (ff instanceof PDFRef ? "#" + ff.objectNumber : "?");
  }
  console.log(`/${key.asString()} -> ref=#${fref.objectNumber} Subtype=${subtype} BaseFont=${baseFont} FontFile=${fontFile}`);
}

const contents = node.Contents();
const arr = contents instanceof PDFArray ? contents : null;
const s1 = arr ? arr.lookup(1) : contents;
const raw1 = s1.getContents();
const dec1 = raw1[0] === 0x78 ? inflateSync(raw1) : raw1;
const fontsUsed = [...new Set([...dec1.toString("latin1").matchAll(/\/(F\w+)\s+(\d+)\s+Tf/g)].map((m) => m[1]))];
console.log("\n表格流(stream1)使用的字体名:", fontsUsed.join(", "));
