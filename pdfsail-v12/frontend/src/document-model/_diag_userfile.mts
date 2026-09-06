import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } from "pdf-lib";
import { inflateSync, deflateSync } from "node:zlib";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
console.log("文件大小:", bytes.length);
const pdf = await PDFDocument.load(bytes);
const pages = pdf.getPages();
console.log("页数:", pages.length);

function unenc(buf: Uint8Array): Uint8Array {
  if (buf[0] === 0x78) { try { return inflateSync(buf); } catch { return buf; } }
  return buf;
}

for (let pi = 0; pi < Math.min(pages.length, 2); pi++) {
  const page = pages[pi];
  const node: any = (page as any).node;
  const res = node.Resources();
  const fontRes = res?.lookup(PDFName.of("Font"), PDFDict);
  console.log(`\n=== page ${pi + 1} ===`);
  console.log("page 级 /Font 条目:", fontRes ? fontRes.keys().map((k: PDFName) => "/" + k.asString()).join(", ") : "(无)");

  const contents = node.Contents();
  let streams: any[] = [];
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) streams.push(contents.lookup(i));
  else streams.push(contents);
  console.log("Contents 是数组? 长度:", streams.length);

  for (let i = 0; i < streams.length; i++) {
    const s: any = streams[i];
    const raw = s.getContents ? s.getContents() : null;
    const dec = raw ? unenc(raw) : null;
    const head = dec ? dec.slice(0, 200).toString("latin1").replace(/\n/g, "⏎") : "";
    const tail = dec ? dec.slice(-400).toString("latin1").replace(/\n/g, "⏎") : "";
    console.log(`\n--- stream ${i} (size=${dec ? dec.length : "?"}) ---`);
    console.log("HEAD:", head.slice(0, 160));
    if (i === streams.length - 1) console.log("TAIL:", tail);
  }
}
