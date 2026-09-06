/**
 * 浏览器端 fs 占位实现
 *
 * 背景：fontkit@1.9.0 未提供 browser 入口（package.json 的 exports 只有
 * import/require），Vite 只能选 ESM 构建 `dist/module.mjs`，而它顶层写了
 * `import { readFileSync, readFile } from "fs"`。浏览器构建下 "fs" 会被
 * 外部化成 `__vite-browser-external`（没有任何具名导出），rollup 随即报：
 *   "readFileSync" is not exported by "__vite-browser-external"
 * 导致 `npm run build` 直接失败。
 *
 * 本项目对 fontkit 的唯一用法是 `pdf.registerFontkit(fontkit)`（见
 * document-model/export-renderer.ts），pdf-lib 内部只调用
 * `fontkit.create(buffer)` 解析字体二进制，不会走到 `openSync/readFileSync`
 * 这条依赖真实文件系统的路径。因此这里只需让符号存在即可，真正被调用时
 * 抛错比静默返回空更安全（能立刻暴露误用）。
 *
 * 注意：仅通过 vite.config.ts 里 `find: /^fs$/` 的 alias 生效，
 * 只匹配裸模块名 "fs"，不影响 "fs/promises"、"node:fs" 等其它 specifier。
 */

export function readFileSync(): never {
  throw new Error("[fs shim] readFileSync is not available in the browser");
}

export function readFile(): never {
  throw new Error("[fs shim] readFile is not available in the browser");
}

export default { readFileSync, readFile };
