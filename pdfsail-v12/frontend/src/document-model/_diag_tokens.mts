/**
 * @diagnostic 直接 tokenize 内容流，打印所有 Tj 算子的 literal token start/end，
 * 与字符实际位置对比，定位 byteStart 偏移根因。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { tokenizeContentStream } from "./content-stream-resolver";

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function main() {
  const path = resolve(process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf");
  const pdf = await PDFDocument.load(pdfToBytes(path), { updateMetadata: false });
  const page = pdf.getPage(0) as any;
  const contents = page.node.Contents?.();
  let text: string;
  if (contents instanceof PDFRawStream) {
    text = Buffer.from(decodePDFRawStream({ dict: contents.dict, contents: contents.asUint8Array() }).getBytes()).toString("latin1");
  } else {
    console.log("非直接流对象"); return;
  }
  console.log(`内容流长度: ${text.length}`);

  const tokens = tokenizeContentStream(text);
  let seq = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if ((tok.kind === "literal" || tok.kind === "hex") && tokens[i + 1]?.kind === "op" && tokens[i + 1].value === "Tj") {
      const slice = text.slice(tok.start, tokens[i + 1].end);
      console.log(`  Tj#${seq}: literal.start=${tok.start} literal.end=${tok.end} opEnd=${tokens[i+1].end} slice=${JSON.stringify(slice)}`);
      seq++;
    }
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
