// pdf.js v4 ESM worker 在 Vite 开发服务器下，用
//   new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)
// 无法解析裸模块说明符，会产生形如
//   http://localhost:5173/node_modules/pdfjs-dist/build/pdf.worker.min.mjs
// 的无效 URL，导致浏览器报
//   "Failed to fetch dynamically imported module"
// 进而 "Setting up fake worker failed"，PDF 无法打开。
//
// 用 Vite 的 ?url 资源后缀让构建器正确解析并托管该文件即可修复
// （dev 与 build 均生效）。两个 worker 文件均为自包含 bundle（无相对 import），
// 直接以静态资源方式托管即可。
import pdfjsWorkerMin from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// 非压缩版（scripts/patch-pdfjs-worker.mjs 已注入 GetFontData handler），
// 供 Font Data Bridge 临时切换到该 worker 取回内嵌字体字节。
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

export const PDFJS_WORKER_SRC = pdfjsWorkerMin;
export const PDFJS_WORKER_SRC_UNCOMPRESSED = pdfjsWorker;
