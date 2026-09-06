/**
 * patch-pdfjs-worker.mjs — 为 pdf.js worker 注入 GetFontData handler
 *
 * 为什么需要它：
 *   pdf.js 官方 worker 没有 GetFontData 这个 action，而本项目的 Font Data
 *   Bridge（frontend/src/editor/fontDataBridge.ts）依赖它从 worker 侧取回
 *   内嵌字体的字节，进而在主线程 new FontFace 注册字体，编辑态才能用原始
 *   字体测量与渲染。
 *
 *   此前这个补丁是手工直接改 node_modules 里的 pdf.worker.mjs，没有纳入
 *   版本控制。本地开发因此正常，但 CI/CD（Render）执行全新 npm install 后
 *   拿到的是未打补丁的官方 worker，浏览器随即报：
 *     Uncaught Error: Unknown action from worker: GetFontData
 *   编辑态直接不可用。
 *
 * 做法：
 *   作为 postinstall 自动执行，幂等（已含 GetFontData 则跳过）。
 *   锚点选 handler.on("Cleanup", ...) —— 它在 pdf.js 4.x worker 中稳定存在。
 *   锚点找不到时以非零码退出并明确报错，避免静默放过导致线上事故。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER = path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs");

const MARKER = 'handler.on("GetFontData"';
const ANCHOR = 'handler.on("Cleanup", function (data) {';

const PATCH = `    // [M7.8-019] Font Data Bridge: 主线程请求 worker 已解析的字体字节（复用 pdf.js 解析，不重造 FontFile）

    handler.on("GetFontData", function (data) {
      const cache =
        (pdfManager.catalog && pdfManager.catalog.fontCache) ||
        pdfManager.fontCache || null;
      if (!cache || typeof cache[Symbol.iterator] !== "function") {
        return { fontId: data.fontId, error: "no-font-cache" };
      }
      return Promise.all(cache).then(
        function (fonts) {
          const withData = fonts.filter((f) => f && f.font && f.font.data);
          let target = null;
          if (data.fontId === "*") {
            target = withData[0] || null;
          } else {
            // 先按 loadedName 匹配；跨 doc 实例 loadedName 不稳定，退化到 PDF 字体名（name）匹配
            target =
              fonts.find((f) => f && f.loadedName === data.fontId) ||
              fonts.find((f) => f && f.font && f.font.name === data.fontId) ||
              null;
          }
          if (!target) {
            return {
              fontId: data.fontId,
              error: withData.length ? "not-found" : "no-embedded-fonts",
              total: fonts.length,
              withFont: fonts.filter((f) => f && f.font).length,
              withData: withData.length,
              sample: fonts.slice(0, 5).map((f) => ({
                loadedName: f && f.loadedName,
                hasFont: !!(f && f.font),
                hasFontData: !!(f && f.font && f.font.data),
                fontDataType: f && f.font && f.font.data ? f.font.data.constructor.name : null,
                fontHasFile: !!(f && f.font && f.font.file),
                fontMimetype: f && f.font ? f.font.mimetype : null
              }))
            };
          }
          const fontObj = target.font;
          if (!fontObj.data) {
            return { fontId: target.loadedName, error: "no-data" };
          }
          // 复制一份再回传：绝不 detach worker 自身字体数据，PDF Canvas 渲染不受影响
          const copy = fontObj.data.slice();
          return {
            fontId: target.loadedName,
            name: fontObj.name,
            loadedName: target.loadedName,
            mimetype: fontObj.mimetype,
            data: copy
          };
        },
        function (reason) {
          return { fontId: data.fontId, error: String(reason) };
        }
      );
    });

`;

if (!existsSync(WORKER)) {
  console.warn(`[patch-pdfjs] pdf.worker.mjs not found at ${WORKER}, skipping.`);
  process.exit(0);
}

const src = readFileSync(WORKER, "utf8");

if (src.includes(MARKER)) {
  console.log("[patch-pdfjs] GetFontData handler already present, skip.");
  process.exit(0);
}

const at = src.indexOf(ANCHOR);
if (at === -1) {
  console.error(
    "[patch-pdfjs] FAILED: anchor not found. pdf.js version may have changed — " +
      "please re-check the worker's handler registration block and update this script."
  );
  process.exit(1);
}

writeFileSync(WORKER, src.slice(0, at) + PATCH + src.slice(at), "utf8");
console.log("[patch-pdfjs] GetFontData handler injected into pdf.worker.mjs");
