/**
 * M7.8-020-PROD — Font Resolution
 *
 * 将 PDF 字体解析统一为一层，供 EditableTextNode 消费。
 * EditableTextNode 只消费 resolved font，不负责判断 PDF 字体来源。
 *
 *   嵌入式   → Font Data Bridge（隔离 namespace FontFace，见 fontDataBridge.ensurePdfFontFace）
 *   系统替换 → PDF.js systemFontInfo.css 中的真实系统字体 family
 *   无字体   → 受控 fallback 字体栈（web-safe）
 *
 * 字节获取：app 现运行中的 worker 是 min（无 GetFontData），因此内嵌字节经由
 * PATCHED 非 min worker 重开的 patchedDoc 取得（openPatchedDoc，已验证）。
 * patchedDoc 按 documentId 缓存，整份 PDF 仅重开一次。
 */

import {
  openPatchedDoc,
  requestFontData,
  ensurePdfFontFace,
  ensurePageFonts,
} from "./fontDataBridge";

export type FontSource = "embedded" | "system" | "fallback" | "unknown";

export interface FontCoverage {
  method: "cmap" | "heuristic" | "none" | "error";
  full: boolean;
  missingChars?: string[];
}

export interface FontResolution {
  source: FontSource;
  pdfFontId?: string;
  pdfFontName?: string;
  /** 可直接用于 CSS font-family 的隔离/真实 family 名 */
  editableFontFamily?: string;
  fontFaceLoaded?: boolean;
  /** PDF.js 报告给画布的 fallback 字体族名（诊断用，确认画布实际所用字体） */
  fallbackName?: string;
  /** PDF.js meta.name（PDF 原始字体名） */
  metaName?: string;
  /** fallback/system 字体建议的字重（优先来自 PDF.js font meta） */
  weight?: number;
  /** fallback/system 字体建议的字形 */
  style?: "normal" | "italic";
  /** M7.8-021 阶段：仅检测，不重建（此处先留占位） */
  coverage?: FontCoverage;
}

// ── documentId：每 PDF 文档稳定唯一（用于 namespace 隔离，避免 PDF 切换污染） ──
const docIdMap = new WeakMap<object, string>();
function documentIdOf(doc: any): string {
  let id = docIdMap.get(doc);
  if (!id) {
    const rand =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    id = `doc_${rand}`;
    docIdMap.set(doc, id);
  }
  return id;
}

// ── 缓存：patchedDoc 与已解析结果（按 documentId 隔离） ──
const patchedDocCache = new Map<string, any>();
const resolutionCache = new Map<string, Map<string, FontResolution>>();

// fallback 字体族：直接用 PDF.js 在画布上渲染时所用的通用字体族名（fallbackName，
// 通常是 "sans-serif" / "serif" / "monospace"），让浏览器选到与画布完全相同的默认字体，
// 避免用 system-ui 等首选项导致字形宽度/字重与画布不一致（表现为“变宽 + 颜色加深”）。
function fallbackFamilyFor(fallbackName?: string): string {
  if (fallbackName === "monospace") return "monospace";
  if (fallbackName === "serif") return "serif";
  if (fallbackName && fallbackName !== "sans-serif") {
    // 非标准 generic 名也直接透传，浏览器按同规则解析，最大化贴近画布。
    return fallbackName;
  }
  return "sans-serif";
}

/** 从 meta/name 提取 fallback/system 字体的建议字重/字形 */
function inferWeightStyle(
  meta: any,
  rawName?: string,
): { weight?: number; style?: "normal" | "italic" } {
  const lower = (rawName || meta?.name || "").toLowerCase();
  let weight: number | undefined;
  let style: "normal" | "italic" | undefined;

  if (typeof meta?.bold === "boolean") {
    weight = meta.bold ? 700 : 400;
  } else if (meta?.weight) {
    weight = Number(meta.weight);
  } else {
    if (lower.includes("bold")) weight = 700;
    else if (lower.includes("black")) weight = 900;
    else if (lower.includes("heavy")) weight = 800;
    else if (lower.includes("light")) weight = 300;
    else if (lower.includes("thin")) weight = 200;
    else if (lower.includes("medium")) weight = 500;
  }

  if (typeof meta?.italic === "boolean") {
    style = meta.italic ? "italic" : "normal";
  } else if (lower.includes("italic") || lower.includes("oblique")) {
    style = "italic";
  }

  return { weight, style };
}

/** 从 app doc 的 commonObjs 取字体元数据（fallbackName / systemFontInfo / name 在主线保留，仅 data 被置空）。 */
function getFontMeta(doc: any, fontId: string) {
  try {
    const obj = doc?._transport?.commonObjs?.get?.(fontId);
    return obj || null;
  } catch {
    return null;
  }
}

async function getPatchedDoc(appDoc: any): Promise<any> {
  const id = documentIdOf(appDoc);
  let pd = patchedDocCache.get(id);
  if (pd) return pd;
  pd = await openPatchedDoc(appDoc);
  patchedDocCache.set(id, pd);
  return pd;
}

async function resolveOne(
  appDoc: any,
  patched: any,
  docId: string,
  fontId: string,
): Promise<FontResolution> {
  const meta = getFontMeta(appDoc, fontId);

  // 1) 系统替换字体 → 真实系统字体 family（画布实际所用，零桥接）
  if (meta?.systemFontInfo?.css) {
    const ws = inferWeightStyle(meta, meta?.name);
    return {
      source: "system",
      pdfFontId: fontId,
      pdfFontName: meta.name,
      editableFontFamily: meta.systemFontInfo.css,
      fontFaceLoaded: true,
      weight: ws.weight,
      style: ws.style,
      fallbackName: meta?.fallbackName,
      metaName: meta?.name,
    };
  }

  // 2) 内嵌字体 → Bridge 注册隔离 namespace FontFace（await load，保证 fontReady）
  // 用稳定的 PDF 字体名（meta.name）查询 patched doc：app/patched 两个 doc 实例各自生成的
  // loadedName 不一致（如 app=g_d0_f1 而 patched=g_d1_f1），但 PDF 字体名稳定，可跨实例匹配。
  try {
    const queryId = meta?.name || fontId;
    let fr = await requestFontData(patched, queryId);
    // M7.8-034：PDF 字体名匹配失败时，退而按 app 侧的 fontId（loadedName）再试一次。
    // 部分 PDF 的 font.name 与 worker 侧 fontCache 记录不一致（尤其子集 CID 字体），
    // 而 app/patched 两个 doc 的 loadedName 在单文档内往往恰好同源。
    if (!fr?.data?.byteLength && fontId && fontId !== queryId) {
      try {
        const alt = await requestFontData(patched, fontId);
        if (alt?.data?.byteLength) fr = alt;
      } catch {
        /* 保持原 fr 用于诊断 */
      }
    }
    if (fr?.data && fr.data.byteLength) {
      // 用 patched doc 的真实 loadedName 注册 bridge（CSS family 安全，且能命中 GetFontData）
      const family = await ensurePdfFontFace(patched, docId, fr.loadedName!);
      return {
        source: "embedded",
        pdfFontId: fontId,
        pdfFontName: meta?.name || (fr as any).name,
        editableFontFamily: family,
        fontFaceLoaded: true,
      };
    }
    // M7.8-034：取不到字节时**必须**留痕，否则 embedded 恒为 0 且无从定位。
    // worker 侧 GetFontData 在 miss 时会回传 error/withData/sample 诊断字段。
    console.warn(`[M7.8-034][FONT_DATA_EMPTY] fontId=${fontId} queryId=${queryId}`, {
      error: (fr as any)?.error,
      total: (fr as any)?.total,
      withFont: (fr as any)?.withFont,
      withData: (fr as any)?.withData,
      sample: (fr as any)?.sample,
      metaName: meta?.name,
      fallbackName: meta?.fallbackName,
      systemFontInfo: !!meta?.systemFontInfo,
    });
  } catch (e) {
    console.warn(`[M7.8-020-PROD] embedded bytes fetch failed for ${fontId}:`, e);
  }

  // 3) 兜底：受控 fallback 栈，同时给出建议字重/字形
  const ws = inferWeightStyle(meta, meta?.name);
  return {
    source: "fallback",
    pdfFontId: fontId,
    pdfFontName: meta?.name,
    editableFontFamily: fallbackFamilyFor(meta?.fallbackName),
    fontFaceLoaded: true,
    weight: ws.weight,
    style: ws.style,
    fallbackName: meta?.fallbackName,
    metaName: meta?.name,
  };
}

/**
 * 解析当前文档用到的全部字体，返回 Map<fontId, FontResolution>。
 * 已解析的 fontId 会按 documentId 缓存，重复调用（翻页）不重复开 patchedDoc。
 */
export async function resolveDocumentFonts(
  appDoc: any,
  fontIds: string[],
): Promise<Map<string, FontResolution>> {
  const docId = documentIdOf(appDoc);
  const existing = resolutionCache.get(docId) || new Map<string, FontResolution>();
  const fresh = fontIds.filter((fid) => fid && !existing.has(fid));
  if (fresh.length === 0) return existing;

  const patched = await getPatchedDoc(appDoc);
  // 精确渲染当前页（从 fontId 解析页索引 g_d{P}_f{F} → P），确保该页字体字节进 worker fontCache。
  // 否则 GetFontData 按 loadedName 匹配会 not-found（首页字体偶发不进“渲染所有页”的缓存）。
  const pageIdx = new Set<number>();
  for (const fid of fresh) {
    const m = /^g_d(\d+)_f\d+$/.exec(fid);
    if (m) pageIdx.add(parseInt(m[1], 10));
  }
  for (const pi of pageIdx) {
    await ensurePageFonts(patched, pi);
  }
  for (const fid of fresh) {
    existing.set(fid, await resolveOne(appDoc, patched, docId, fid));
  }
  resolutionCache.set(docId, existing);

  const summary = { embedded: 0, system: 0, fallback: 0, unknown: 0 };
  for (const r of existing.values()) summary[r.source]++;
  console.log(
    "[M7.8-020-PROD][RESOLVE]",
    JSON.stringify({ docId, requested: fontIds.length, cached: existing.size, ...summary })
  );
  return existing;
}

/** 文档卸载时清理：销毁 patchedDoc + 清除解析缓存（FontFace 由 fontFaceCache 自行管理生命周期）。 */
export function unloadDocumentFonts(appDoc: any): void {
  const id = docIdMap.get(appDoc);
  if (!id) return;
  const pd = patchedDocCache.get(id);
  if (pd) {
    try {
      pd.destroy();
    } catch {
      /* noop */
    }
    patchedDocCache.delete(id);
  }
  resolutionCache.delete(id);
  docIdMap.delete(appDoc);
}
