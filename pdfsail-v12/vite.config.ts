import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    // fontkit 依赖 Node 的 Buffer/process，浏览器环境需 polyfill。
    // nodePolyfills 会可靠覆盖其内部 CJS require("buffer")，避免
    // Vite 把它外部化导致运行时 Buffer is not defined。
    // 注意不要在此 include "fs"：插件把 fs 解析成空 mock（无任何具名导出），
    // 反而会让 rollup 继续报 "readFileSync is not exported"。
    nodePolyfills({
      include: ["buffer", "process", "stream", "util", "events"],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "shared") },
      // fontkit 的 ESM 入口顶层 import "fs"，浏览器侧用占位实现接管，
      // 保证 readFileSync / readFile 符号存在（运行时不会真正被调用）。
      {
        find: /^fs$/,
        replacement: path.resolve(__dirname, "frontend/src/shims/fs-browser.ts"),
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
