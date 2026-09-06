/**
 * @diagnostic 验证：从原始流字节读取→替换→set Contents→save 是否持久。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function main() {
  const path = resolve(process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf");
  const bytes = pdfToBytes(path);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = pdf.getPage(0) as any;

  const contents = page.node.Contents?.();
  const rawBytes = decodePDFRawStream({ dict: (contents as PDFRawStream).dict, contents: (contents as PDFRawStream).asUint8Array() }).getBytes();
  let text = Buffer.from(rawBytes).toString("latin1");
  console.log("原始含 (4) Tj:", text.includes("(4) Tj"), "len:", text.length);
  text = text.replace("(4) Tj", "() Tj");
  const newBytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) newBytes[i] = text.charCodeAt(i) & 0xff;
  const newStream = pdf.context.stream(newBytes);
  page.node.set(PDFName.of("Contents"), newStream);
  console.log("已 set Contents 为新 stream");

  const out = await pdf.save();
  const pdf2 = await PDFDocument.load(out, { updateMetadata: false });
  const page2 = pdf2.getPage(0) as any;
  const c2 = page2.node.Contents?.();
  const raw2 = decodePDFRawStream({ dict: (c2 as PDFRawStream).dict, contents: (c2 as PDFRawStream).asUint8Array() }).getBytes();
  const text2 = Buffer.from(raw2).toString("latin1");
  console.log("保存后含 (4) Tj:", text2.includes("(4) Tj"));
  console.log("保存后 #15 区:", JSON.stringify(text2.slice(4085, 4110)));
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
