// M7.8-019 Font Data Bridge —— 最小字体字节桥接（复用 pdf.js worker 已解析的字体，不重造 FontFile2/3）
// 只读/接入逻辑集中在此文件；不修改 EditableTextNode / SegmentBuilder / CoordinateMapper。
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

export interface FontDataResult {
  fontId: string;
  name?: string;
  loadedName?: string;
  mimetype?: string;
  data?: ArrayBuffer;
  error?: string;
}

const fontFaceCache = new Map<string, FontFace>();

/** 主线程 → worker 请求字体字节（worker 端 GetFontData handler，pdf.worker.mjs）。 */
export async function requestFontData(
  doc: PDFDocumentProxy,
  fontId: string
): Promise<FontDataResult> {
  const transport: any = (doc as any)._transport;
  const mh = transport?.messageHandler;
  if (!mh || typeof mh.sendWithPromise !== "function") {
    throw new Error("messageHandler.sendWithPromise unavailable on transport");
  }
  return mh.sendWithPromise("GetFontData", { fontId });
}

/** 取字节 → 主线程 new FontFace → document.fonts → load。返回可用于 CSS 的隔离 family 名。 */
export async function ensurePdfFontFace(
  doc: PDFDocumentProxy,
  documentId: string,
  fontId: string
): Promise<string> {
  const family = `__pdfsail_pdf_font_${documentId}_${fontId}`;
  const cached = fontFaceCache.get(family);
  if (cached && cached.status === "loaded") return family;

  const res = await requestFontData(doc, fontId);
  if (!res || res.error || !res.data || res.data.byteLength === 0) {
    throw new Error(`GetFontData failed for ${fontId}: ${res?.error || "no-data"}`);
  }
  const fontFace = new FontFace(family, res.data);
  document.fonts.add(fontFace);
  await fontFace.load();
  // M7.8-020-PROD：必须等到字体在 document.fonts 里完全激活，再让 segment 渲染。
  // 否则 EditableTextNode 的 useMemo 用 measureText 测的是 fallback 字体，
  // 不同 PDF fallback 字体的 ascent 不同，导致 overlay 随机上移/下移。
  await document.fonts.ready;
  fontFaceCache.set(family, fontFace);
  return family;
}

/**
 * 用 PATCHED 非 min worker 重开同一 PDF，返回 patchedDoc。
 * 用途：app 现运行中的 worker 是 min（无 GetFontData），需临时切到已 patch 的非 min worker
 * 创建第二个 doc 来取字体字节；创建完成后立即恢复全局 workerSrc，不影响 app 现有 worker。
 */
export async function openPatchedDoc(appDoc: PDFDocumentProxy): Promise<PDFDocumentProxy> {
  const bytes = await appDoc.getData();
  const savedWorkerSrc = pdfjsLib.GlobalWorkerOptions.workerSrc;
  const patchedWorkerSrc =
    new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString() +
    "?m78=" +
    Date.now();
  pdfjsLib.GlobalWorkerOptions.workerSrc = patchedWorkerSrc;
  let patchedDoc: any;
  try {
    patchedDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } finally {
    pdfjsLib.GlobalWorkerOptions.workerSrc = savedWorkerSrc;
  }

  // 填满 worker 的 fontCache（含内嵌字体字节），否则后续 GetFontData 取不到数据。
  // 关键：getOperatorList 仅加载字体对象；真正把 font.data 字节解码进 fontCache 需要一次真实 render。
  // 因此先把所有页 getOperatorList，再对每页做极小 scale 的离屏 render（字体解码不依赖 render 尺寸）。
  try {
    const numPages = patchedDoc.numPages;
    for (let p = 1; p <= numPages; p++) {
      const pg = await patchedDoc.getPage(p);
      await pg.getOperatorList();
      const vp = pg.getViewport({ scale: 0.1 });
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.ceil(vp.width));
      c.height = Math.max(1, Math.ceil(vp.height));
      const ctx = c.getContext("2d");
      if (ctx) {
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      }
      pg.cleanup?.();
    }
  } catch (e) {
    console.warn("[M7.8-019][WARN] evaluate all pages failed (fontCache may be incomplete)", {
      error: String(e),
    });
  }

  return patchedDoc as PDFDocumentProxy;
}

/**
 * 精确渲染某页（pageIndex 0 基）以强制 worker 把该页字体的字节（font.data）解码进 fontCache。
 * 仅渲染单页，避免“渲染所有页”时首页字体偶发未进缓存的问题；render 用极小 scale 离屏 canvas。
 */
export async function ensurePageFonts(patchedDoc: any, pageIndex: number): Promise<void> {
  try {
    const pg = await patchedDoc.getPage(pageIndex + 1);
    await pg.getOperatorList();
    const vp = pg.getViewport({ scale: 0.1 });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(vp.width));
    c.height = Math.max(1, Math.ceil(vp.height));
    const ctx = c.getContext("2d");
    if (ctx) {
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    }
    pg.cleanup?.();
  } catch (e) {
    console.warn("[M7.8-019][WARN] ensurePageFonts failed", { pageIndex, error: String(e) });
  }
}

/**
 * 包裹 doc._transport.commonObjs.resolve，在字体对象（带 loadedName）被解析时捕获其 id。
 * 注意：PDFObjects 的内部存储是私有字段 #objs，无法枚举，只能拦截 resolve；
 * 且主线程在 resolve 字体时会把 font.data 置空（见 pdf.mjs:12729），所以主线程无字节，
 * 真正取字节要靠 worker 端 GetFontData。
 */
export function installFontCapture(doc: any): string[] {
  const co = doc?._transport?.commonObjs;
  const ids: string[] = [];
  if (co && typeof co.resolve === "function") {
    const orig = co.resolve.bind(co);
    co.resolve = (id: string, data: any) => {
      if (data && typeof data.loadedName === "string") ids.push(id);
      return orig(id, data);
    };
  }
  return ids;
}

/**
 * Phase A 验证：用 PATCHED 非 min worker 重新打开同一 PDF，
 * 证明 worker font.data → bridge → 主线程 FontFace.load → document.fonts，
 * 且 bridge 后 PDF Canvas 渲染像素不变（worker 字体未被 detach）。
 */
export async function verifyFontBridge(opts: { documentId?: string } = {}) {
  const appDoc = (window as any).__pdfDoc as PDFDocumentProxy | undefined;
  if (!appDoc) {
    console.log("[M7.8-019][BLOCKED] window.__pdfDoc missing");
    return;
  }
  const documentId = opts.documentId || "m78-019";

  // 复用同一 PDF 字节，用 PATCHED 非 min worker 开一个新 doc（避免触碰 app 现运行中的 min worker）。
  const patchedDoc = await openPatchedDoc(appDoc);

  // 在渲染前包裹 resolve，捕获字体 common obj id
  const capturedFontIds = installFontCapture(patchedDoc);

  try {
    const page = await patchedDoc.getPage(1);
    const viewport = page.getViewport({ scale: 2 });

    const c1 = document.createElement("canvas");
    c1.width = viewport.width;
    c1.height = viewport.height;
    const x1 = c1.getContext("2d")!;
    await page.render({ canvasContext: x1, viewport } as any).promise;
    const baseline = x1.getImageData(0, 0, c1.width, c1.height).data;

    // 评估所有页面以填满 worker 的 fontCache（含内嵌字体的字节）。
    // 首页捕获到的字体可能全是系统替换字体（无 data），内嵌字体通常在其它页。
    try {
      const numPages = patchedDoc.numPages;
      for (let p = 1; p <= numPages; p++) {
        const pg = await patchedDoc.getPage(p);
        await pg.getOperatorList();
        pg.cleanup?.();
      }
    } catch (e) {
      console.log("[M7.8-019][WARN] evaluate all pages failed", { error: String(e) });
    }

    // 优先在已捕获（页面用到的）字体里找一个有内嵌字节的；
    // 若都是系统/标准字体（无 data），则向 worker 请求任意有内嵌数据的字体（"*"）。
    let fontId: string | null = null;
    let res: any = null;
    for (const id of capturedFontIds) {
      try {
        const r = await requestFontData(patchedDoc, id);
        if (r && r.data && r.data.byteLength > 0) {
          fontId = id;
          res = r;
          break;
        }
      } catch {
        /* 该字体无内嵌数据，继续尝试下一个 */
      }
    }
    if (!fontId) {
      try {
        res = await requestFontData(patchedDoc, "*");
        if (res && res.data && res.data.byteLength > 0) fontId = res.fontId || "*";
      } catch (e) {
        console.log("[M7.8-019][BLOCKED] no embedded font available", {
          captured: capturedFontIds,
          error: String(e),
        });
        return;
      }
    }
    if (!fontId || !res || !res.data || res.data.byteLength === 0) {
      console.log("[M7.8-019][BLOCKED] no embedded font data", {
        captured: capturedFontIds,
        res,
      });
      return;
    }

    const dataAvailable = true;
    const byteLength = res.data.byteLength;

    let fontFaceCreated = false;
    let fontFaceLoaded = false;
    let family = "";
    let fontFaceError: string | null = null;
    try {
      family = await ensurePdfFontFace(patchedDoc, documentId, fontId);
      fontFaceCreated = true;
      const ff = [...document.fonts].find((f) => f.family === family);
      fontFaceLoaded = !!ff && ff.status === "loaded";
    } catch (e) {
      fontFaceError = String(e);
    }

    const c2 = document.createElement("canvas");
    c2.width = viewport.width;
    c2.height = viewport.height;
    const x2 = c2.getContext("2d")!;
    await page.render({ canvasContext: x2, viewport } as any).promise;
    const after = x2.getImageData(0, 0, c2.width, c2.height).data;
    let diff = 0;
    for (let i = 0; i < baseline.length; i += 4) {
      if (
        Math.abs(baseline[i] - after[i]) > 8 ||
        Math.abs(baseline[i + 1] - after[i + 1]) > 8 ||
        Math.abs(baseline[i + 2] - after[i + 2]) > 8
      )
        diff++;
    }
    const pdfCanvasStillWorks = diff === 0;
    const documentFontAvailable = [...document.fonts].some((f) => f.family === family);

    console.log(
      "[M7.8-019][FONT_DATA_BRIDGE]",
      JSON.stringify(
        {
          fontId,
          pdfFontName: res?.name,
          mimetype: res?.mimetype,
          dataAvailable,
          byteLength,
          transferSuccess: dataAvailable,
          fontFaceCreated,
          fontFaceLoaded,
          documentFontAvailable,
          pdfCanvasStillWorks,
          diffPixels: diff,
          fontFaceError,
        },
        null,
        2
      )
    );
  } finally {
    patchedDoc.destroy();
  }
}
