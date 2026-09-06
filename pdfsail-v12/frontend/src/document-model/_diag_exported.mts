/**
 * @diagnostic 解析【导出后的 PDF】，读回文本项的真实 Tm，定位编辑行实际落点。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`diag: unsupported <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
(pdfjs as any).GlobalWorkerOptions.workerSrc = "";

async function main() {
  const pdfPath = process.argv[2];
  const needle = process.argv[3] || "268282";
  const abs = resolve(pdfPath);
  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);
  const doc = await (pdfjs as any).getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const ctm = vp.transform; // [a,b,c,d,e,f] device = m * user
    // 页面 CTM：device-y 翻转映射到 user 空间；pdf.js 的 text item.transform 是 user 空间矩阵
    for (const item of tc.items as any[]) {
      const str = "str" in item ? item.str : (item as any).str ?? "";
      if (str.includes(needle)) {
        const t = item.transform; // [a,b,c,d,e,f]
        const tmY = t[5];
        // device y of baseline origin: f' = ctm[3]*e + ctm[5]*f? use full matrix
        const devX = ctm[0] * t[4] + ctm[2] * t[5] + ctm[4];
        const devY = ctm[1] * t[4] + ctm[3] * t[5] + ctm[5];
        console.log(`page=${p} str="${str}" Tm=[${t.join(",")}]`);
        console.log(`   TmY(user)=${tmY}  deviceY(baseline)=${devY.toFixed(2)}  viewH=${vp.height} ctm=${JSON.stringify(ctm)}`);
        console.log(`   => 若 user TmY==${tmY} 且页面无额外+792 CTM，则等价于“exported Y=${tmY}pt”`);
      }
    }
  }
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
