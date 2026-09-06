import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { buildFontProvenanceMap, collectFontResources } from "./pdf-font-provenance";

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

  const pdfLibDoc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, throwOnInvalidObject: false });
  const pdf = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const page = await pdf.getPage(1);
  const tc = await page.getTextContent();
  await page.getOperatorList();

  console.log("══ PDF-LIB side resources ══");
  const res = collectFontResources(pdfLibDoc, 0);
  for (const [k, v] of res) {
    console.log(`  ${k} obj#${v.objectNumber} subtype=${v.subtype} fontName=${v.fontName ?? "?"} bbox=${JSON.stringify(v.bbox)} charProcCount=${v.charProcCount}`);
  }

  console.log("══ pdf.js side (via commonObjs.get) ══");
  const commonObjs = (pdf as any)._transport.commonObjs;
  const fontNames = Array.from(new Set((tc.items as any[]).map((it) => it.fontName)));
  for (const ln of fontNames) {
    let rec: any;
    try { rec = commonObjs.get(ln); } catch (e) { console.log(`  ${ln} -> get threw: ${(e as Error).message}`); continue; }
    if (!rec) { console.log(`  ${ln} -> undefined`); continue; }
    const dict: any = rec.dict;
    const objId: any = dict?.objId ?? dict?.ref;
    const objNum = objId && typeof objId === "object" ? (objId.num ?? objId.number) : undefined;
    let cpc: any = undefined;
    try { cpc = rec.charProcOperatorList ? (rec.charProcOperatorList.size ?? Object.keys(rec.charProcOperatorList).length) : (rec.charProcOperatorLists ? Object.keys(rec.charProcOperatorLists).length : undefined); } catch {}
    const toUniSize = rec.toUnicode ? (rec.toUnicode.size ?? 0) : 0;
    console.log(`  ${ln} name=${rec.name ?? "?"} objId.num=${objNum} bbox=${JSON.stringify(rec.bbox)} charProcCount=${cpc} toUnicodeSize=${toUniSize} subtype=${rec.subtype ?? rec.type ?? "?"}`);
  }

  const prov = buildFontProvenanceMap(pdfLibDoc, pdf, 0);
  console.log("══ buildFontProvenanceMap result ══");
  console.log(`  size=${prov.size}`);
  for (const [k, v] of prov) {
    const id: any = (v as any).identity ?? (v as any).fontIdentity;
    console.log(`  ${k} -> fontRef=${id?.fontRef ?? "?"} subtype=${id?.subtype ?? "?"} isType3=${(v as any).isType3} charCodeToUnicodeSize=${id?.unicodeToCharCode?.size ?? 0} pdfCharCodeSize=${(v as any).pdfCharCode?.size ?? 0}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
