/**
 * @diagnostic 直接对 cur 调 extractShowTextRecords，打印 "4"/"Bidens"/"69" 候选的 byteStart。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { extractShowTextRecords, makeFontDictResolver } from "./content-stream-resolver";

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function main() {
  const path = resolve(process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf");
  const pdf = await PDFDocument.load(pdfToBytes(path), { updateMetadata: false });
  const page = pdf.getPage(0) as any;
  const contents = page.node.Contents?.();
  const raw = decodePDFRawStream({ dict: (contents as PDFRawStream).dict, contents: (contents as PDFRawStream).asUint8Array() }).getBytes();
  const cur = Buffer.from(raw).toString("latin1");

  const pageRes = (page.node.Resources?.() as any) ?? undefined;
  const resolveFontDict = makeFontDictResolver(pdf as any, pageRes);
  const localRecords = extractShowTextRecords(cur, "embedded", 0, { resolveFontDict, doc: pdf as any });

  const want = ["4", "Bidens", "69"];
  for (const w of want) {
    const cands = localRecords.filter((r: any) => (r.unicodeText ?? r.operatorText ?? "") === w);
    console.log(`\n文本="${w}" 候选数=${cands.length}`);
    for (const c of cands) {
      console.log(`  byteStart=${c.byteStart} byteEnd=${c.byteEnd} cur[@bs]=${JSON.stringify(cur[c.byteStart])} slice=${JSON.stringify(cur.slice(c.byteStart, c.byteEnd))}`);
    }
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
