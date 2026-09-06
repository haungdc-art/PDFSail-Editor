import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { parsePdfToEditableDocument } from "./pdf-importer";

const _canvasCache: any[] = [];
(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") { const c = createCanvas(1, 1); _canvasCache.push(c); return c; }
    throw new Error(`diag: unsupported element <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
const STANDARD_FONT_DATA_URL = new URL("../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;

async function main() {
  const abs = resolve(process.argv[2]);
  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);
  const doc = await parsePdfToEditableDocument(bytes, "real.pdf");
  let idx = 0;
  for (let pi = 0; pi < doc.pages.length; pi++) {
    const page = doc.pages[pi];
    for (const block of page.blocks) {
      for (const line of block.lines) {
        const gs = line.glyphs ?? [];
        const fi = gs[0]?.fontIdentity;
        const sub = fi?.subtype ?? "?";
        const isT3 = fi?.isType3 ?? false;
        const base = fi?.baseFont ?? "?";
        const txt = gs.map((g: any) => g.char ?? g.originalChar ?? "").join("").slice(0, 60);
        console.log(`L${idx} p${pi} ${isT3 ? "TYPE3" : "     "} sub=${sub} base=${base} fi=${JSON.stringify(fi)} "${txt}"`);
        idx++;
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
