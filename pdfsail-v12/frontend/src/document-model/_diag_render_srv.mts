import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const FONT_DIR = "d:/TRAE/pdfsail-v12/node_modules/pdfjs-dist/standard_fonts";
const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);

const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent((req.url || "/").split("?")[0]));
  const fp = join(FONT_DIR, p);
  if (!fp.startsWith(FONT_DIR) || !existsSync(fp) || statSync(fp).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  const data = readFileSync(fp);
  const mime = extname(fp) === ".ttf" ? "font/ttf" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, "Access-Control-Allow-Origin": "*" });
  res.end(data);
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/`;

const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: base, useSystemFonts: false, isEvalSupported: false }).promise;
const page = await doc.getPage(1);
try {
  const ops = await page.getOperatorList();
  const fn = ops.fnArray;
  let show = 0, bt = 0, et = 0;
  for (const f of fn) { if (f === 56 || f === 57) show++; if (f === 28) bt++; if (f === 29) et++; }
  console.log("getOperatorList: total=", fn.length, "ShowText=", show, "BT=", bt, "ET=", et);
  // 渲染到 canvas 验证（用 pdf.js 自带，不需要外部 canvas）
  const viewport = page.getViewport({ scale: 1.5 });
  const canvasOps = await page.getOperatorList();
  console.log("viewport:", Math.round(viewport.width), "x", Math.round(viewport.height));
} catch (e) {
  console.log("getOperatorList error:", e);
}
server.close();
