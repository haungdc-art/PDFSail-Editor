/**
 * F3B-6.2 — PDFEditor Debug Surface 统一门控
 *
 * 目的：把 PDFEditor.tsx 中「每次生产动作都会执行的 debug / 审计代码」默认关掉，
 *       **不改变任何 Document Ownership、mutation、export 行为**。
 *
 * 设计约束（F3B-6.2 红线）：
 *   · 这是一个 **flag 读取模块**，不是 document abstraction，不持有任何文档状态；
 *   · 默认 **全部关闭**；
 *   · 开启时保持原有行为（审计照旧执行、debug API 照旧注册）；
 *   · 关闭时对应代码块完全不执行。
 *
 * 启用方式（沿用 PDFEditor 既有的 `?debug=` URL 约定，见 isFidelityDebug）：
 *   ?debug=textaudit          → onTextEditSave 的像素/生命周期审计（≈2000 行）
 *   ?debug=perf               → 每秒性能采样（window.__glyphStats）
 *   ?debug=renderpatch        → glyphCommands 的 patch 诊断（含完整 dataURL）
 *   ?debug=audit              → Sprint34 审计簇 / layout debug 注册（预留）
 *   ?debug=all                → 全部
 *   ?debug=textaudit,perf     → 逗号分隔，可组合
 *
 * 也可在 console 预先设置：window.__pdfEditorDebug = "textaudit,perf"
 * （适合「想先开 flag 再做一次编辑」的场景，无需刷新页面）
 */

/** 可单独开启的调试作用域 */
export type DebugScope =
  | "textaudit"
  | "perf"
  | "renderpatch"
  | "audit"
  | "all";

const SCOPE_SEPARATOR = /[,\s]+/;

function readScopes(): Set<string> {
  if (typeof window === "undefined") return new Set();

  const fromWindow = (window as unknown as { __pdfEditorDebug?: unknown })
    .__pdfEditorDebug;
  let raw = "";
  if (typeof fromWindow === "string") {
    raw = fromWindow;
  } else if (Array.isArray(fromWindow)) {
    raw = fromWindow.join(",");
  }

  // 与既有 isFidelityDebug 一致：优先 URL 查询串 ?debug=xxx
  let fromUrl = "";
  try {
    fromUrl = new URLSearchParams(window.location.search).get("debug") ?? "";
  } catch {
    fromUrl = "";
  }

  const merged = `${raw},${fromUrl}`;
  const scopes = new Set<string>();
  for (const part of merged.split(SCOPE_SEPARATOR)) {
    const s = part.trim().toLowerCase();
    if (s) scopes.add(s);
  }
  return scopes;
}

/**
 * 判断某个调试作用域是否开启。**默认 false。**
 * `all` 为通配作用域。
 */
export function isDebugScopeEnabled(scope: DebugScope): boolean {
  const scopes = readScopes();
  return scopes.has(scope) || scopes.has("all");
}

/** onTextEditSave 内的像素 / 生命周期审计（M7.7-031 起，≈2000 行）。默认关闭。 */
export function isTextEditAuditEnabled(): boolean {
  return isDebugScopeEnabled("textaudit");
}

/** 每秒性能采样（Performance Monitor → window.__glyphStats）。默认关闭。 */
export function isPerfMonitorEnabled(): boolean {
  return isDebugScopeEnabled("perf");
}

/** glyphCommands 内 Sprint 26/27 patch 诊断（含完整 dataURL）。默认关闭。 */
export function isRenderPatchDebugEnabled(): boolean {
  return isDebugScopeEnabled("renderpatch");
}

/** Sprint34 审计簇 / Sprint33 layout debug 注册。默认关闭。 */
export function isAuditDebugEnabled(): boolean {
  return isDebugScopeEnabled("audit");
}
