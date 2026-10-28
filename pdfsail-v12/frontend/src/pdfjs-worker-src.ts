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

// ★ 2026-10-28（线上验收「Setting up fake worker failed: Failed to fetch dynamically
//   imported module」）：预热 worker 资源。worker chunk（≈1.3MB）此前在**首次打开 PDF**
//   时才被动态 import，若彼时到 CDN 的连接抖动（实测：同会话内 Google 广告域同报
//   ERR_CONNECTION_CLOSED），pdf.js 内部**无重试** ⇒ 单次抖动即整页失败。
//   这里在模块加载（编辑器 boot）时即发起低优先级 fetch：暖化 TCP/TLS 连接并促发
//   HTTP/2 流复用，把网络风险前置。失败静默（预热是尽力而为，真实失败由重试兜底）。
try {
  fetch(pdfjsWorkerMin, { priority: "low" } as RequestInit).catch(() => {});
} catch {}
