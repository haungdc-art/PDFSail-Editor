/**
 * useOCR — Commit 3 / Feature 1
 *
 * OCR 业务能力：识别整页 OCR + 区域框选 OCR。
 * 从 PDFEditor.tsx L184-369 提取。
 *
 * 纯工具函数（runInlineOCR / mergeTextRects / upscaleImageNN）放模块级，
 * hook 只暴露 action：handleOCR / handleOCRRegion。
 *
 * Ref 由 PDFEditorInner 持有并注入（Canvas 冻结区）：
 *   canvasRef / cssScaleRef
 */

import { useEditor } from "../core/EditorProvider";
import type { RefObject } from "react";
import { captureDocBlocksWriteGuard, guardedDocBlocksUpdate } from "../binding/docBlocksWriteGuard";
import Tesseract from "tesseract.js";
import type { TextBlock } from "../types";
import type { OcrImportRawBlock } from "../binding/ocr-import-draft";

// ── 模块级纯工具函数 ──

async function runInlineOCR(image: string, page: number, cssScale: number, psm?: number): Promise<TextBlock[]> {
  const scale = 2;
  const img = await upscaleImageNN(image, scale);
  const res = await Tesseract.recognize(img, "chi_sim+eng", {
    logger: () => {},
    ...(psm ? { tessedit_pageseg_mode: String(psm) } : {}),
  });

  const words = (res.data.words as any[])
    .filter((w) => w.text?.trim())
    .filter((w) => (w.confidence ?? 0) > 35)
    .filter((w) => {
      const wW = w.bbox.x1 - w.bbox.x0;
      const wH = w.bbox.y1 - w.bbox.y0;
      const ratio = Math.max(wW, wH) / Math.max(Math.min(wW, wH), 1);
      return wW > 3 && wH > 3 && ratio < 15;
    });

  const sorted = [...words].sort((a, b) => {
    if (Math.abs(a.bbox.y0 - b.bbox.y0) < 12) return a.bbox.x0 - b.bbox.x0;
    return a.bbox.y0 - b.bbox.y0;
  });

  const groups: any[][] = [];
  let current: any[] = [];
  for (const w of sorted) {
    if (!current.length) { current = [w]; continue; }
    const last = current[current.length - 1];
    const sameLine = Math.abs(w.bbox.y0 - last.bbox.y0) < 12;
    const closeX = w.bbox.x0 - last.bbox.x1 < 30; // upscale px => 15 CSS px
    if (sameLine && closeX) current.push(w);
    else { groups.push(current); current = [w]; }
  }
  if (current.length) groups.push(current);

  return groups.map((g) => {
    const x0 = g[0].bbox.x0;
    const y0 = Math.min(...g.map((w) => w.bbox.y0));
    const x1 = g[g.length - 1].bbox.x1;
    const y1 = Math.max(...g.map((w) => w.bbox.y1));
    // 使用每组中所有 word 高度的中位数，避免个别 word 错位导致 fontSize 忽大忽小
    const heights = g.map((w) => w.bbox.y1 - w.bbox.y0).sort((a: number, b: number) => a - b);
    const medianH = heights.length % 2 === 0
      ? (heights[heights.length / 2 - 1] + heights[heights.length / 2]) / 2
      : heights[Math.floor(heights.length / 2)];
    const h = Math.max(medianH / scale, 1);
    const fontSize = Math.max(h * 0.85 * cssScale, 8);
    return {
      id: crypto.randomUUID(),
      type: "text" as const,
      page,
      x: (x0 / scale) * cssScale,
      y: (y0 / scale) * cssScale,
      w: ((x1 - x0) / scale) * cssScale,
      h: ((y1 - y0) / scale) * cssScale,
      text: g.map((w) => w.text).join(""),
      fontSize,
    } as TextBlock;
  });
}

/**
 * runInlineOCRWords — Step 2a.5 边界：返回 **word-level** 原始 OCR（`OcrImportRawBlock[]`），
 * 保留 confidence，不做行级分组，page 原样透传（1-based，见 useDocument.ts:33）。
 *
 * 与 `runInlineOCR`（行级分组、丢弃 confidence）平行。本函数供 canonical normalization
 * （`binding/ocr-import-draft.ts`）在 Step 2b 接入前获得词级原始数据。当前 W3/W4 生产路径
 * 仍走 `runInlineOCR`（UI / 导出 / Core 语义不变）；本函数仅为归一化接入预留真实边界，
 * 不改动既有行为、不触碰 Command / EditorDocument / History / Export。
 */
async function runInlineOCRWords(
  image: string,
  page: number,
  cssScale: number,
  psm?: number
): Promise<OcrImportRawBlock[]> {
  const scale = 2;
  const img = await upscaleImageNN(image, scale);
  const res = await Tesseract.recognize(img, "chi_sim+eng", {
    logger: () => {},
    ...(psm ? { tessedit_pageseg_mode: String(psm) } : {}),
  });

  const words = (res.data.words as any[])
    .filter((w) => w.text?.trim())
    .filter((w) => (w.confidence ?? 0) > 35)
    .filter((w) => {
      const wW = w.bbox.x1 - w.bbox.x0;
      const wH = w.bbox.y1 - w.bbox.y0;
      const ratio = Math.max(wW, wH) / Math.max(Math.min(wW, wH), 1);
      return wW > 3 && wH > 3 && ratio < 15;
    });

  return words.map((w) => {
    const wW = w.bbox.x1 - w.bbox.x0;
    const wH = w.bbox.y1 - w.bbox.y0;
    const fontSize = Math.max((wH / scale) * 0.85 * cssScale, 8);
    return {
      text: w.text,
      x: (w.bbox.x0 / scale) * cssScale,
      y: (w.bbox.y0 / scale) * cssScale,
      w: (wW / scale) * cssScale,
      h: (wH / scale) * cssScale,
      fontSize,
      page,
      confidence: w.confidence,
    } as OcrImportRawBlock;
  });
}

function mergeTextRects(items: { x: number; y: number; w: number; h: number }[], yThresh = 12, xGap = 20) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) < yThresh) return a.x - b.x;
    return a.y - b.y;
  });
  const groups: typeof items[] = [];
  let current: typeof items = [];
  for (const it of sorted) {
    if (!current.length) { current = [it]; continue; }
    const last = current[current.length - 1];
    const sameLine = Math.abs(it.y - last.y) < yThresh;
    const closeX = it.x - (last.x + last.w) < xGap;
    if (sameLine && closeX) current.push(it);
    else { groups.push(current); current = [it]; }
  }
  if (current.length) groups.push(current);
  return groups.map((g) => ({
    l: Math.min(...g.map((i) => i.x)),
    r: Math.max(...g.map((i) => i.x + i.w)),
    t: Math.min(...g.map((i) => i.y)),
    b: Math.max(...g.map((i) => i.y + i.h)),
  }));
}

/** 最近邻放大 2x，保持原始像素不模糊 */
async function upscaleImageNN(dataUrl: string, scale: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ── Hook ──

interface UseOCRParams {
  canvasRef: RefObject<HTMLCanvasElement>;
  cssScaleRef: React.MutableRefObject<number>;
  /**
   * STEP-2c-C1：OCR raw `TextBlock[]` 产出后回调（PDFEditor 经此把 OCR 写入 Core）。
   *
   * 返回值语义（决定旧 `setBlocks` 是否回落）：
   *   · `true`  = Core 已认领并提交成功 ⇒ 调用方**不得**再走旧 `setBlocks`
   *               （否则 docBlocks 会同时存在旧随机 uuid 块与新 `ocr_<hash>` 投影 = duplicate）。
   *   · `false` / 未传 = Core 不可用（coreDocumentRef 为 null / session 不可建）或归一化为空
   *               ⇒ 调用方回落旧 `setBlocks`，OCR 不丢失。
   *
   * ★ Step 2c-C2-B：该 boolean 就是 **OCR 的 semantic ownership 契约** ——
   *   `true` ⇒ OCR 只走 Core（Core Command → Core History → Core Projection → Core Export），
   *           **禁止**再写 Legacy setBlocks（否则出现第二套 OCR identity / 第二次 semantic mutation）。
   *   `false` ⇒ Legacy fallback 继续存在（fail-closed，OCR 不丢失）。
   *   即：C2-B 删除的是「Core 已认领后的 Legacy bypass」，**不是**删除 fallback 本身。
   */
  onOcrResult?: (blocks: TextBlock[]) => boolean;
}

export function useOCR({ canvasRef, cssScaleRef, onOcrResult }: UseOCRParams) {
  const { page, textItems, setBlocks, ocrBusy, setOcrBusy } = useEditor();

  const handleOCR = async () => {
    if (!canvasRef.current || ocrBusy) return;
    setOcrBusy(true);
    try {
      const canvas = canvasRef.current;
      const s = cssScaleRef.current;

      const textRects = mergeTextRects(
        textItems.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h })),
        12,
        20
      ).map((r) => ({ l: r.l - 5, r: r.r + 5, t: r.t - 5, b: r.b + 5 }));

      const blocks = await runInlineOCR(canvas.toDataURL("image/png"), page, s);

      // 过滤：只要 OCR 块中心点落在文本区域内，或超过 50% 面积重叠，就判定为正文文本
      let filtered = blocks.filter((b) => {
        const bl = b.x, br = b.x + b.w;
        const bt = b.y, bb = b.y + b.h;
        const bArea = Math.max((br - bl) * (bb - bt), 1);
        const cx = (bl + br) / 2;
        const cy = (bt + bb) / 2;
        let totalOverlap = 0;
        let centerInside = false;
        for (const tr of textRects) {
          const il = Math.max(bl, tr.l);
          const ir = Math.min(br, tr.r);
          const it = Math.max(bt, tr.t);
          const ib = Math.min(bb, tr.b);
          if (il < ir && it < ib) {
            totalOverlap += (ir - il) * (ib - it);
          }
          if (cx >= tr.l && cx <= tr.r && cy >= tr.t && cy <= tr.b) {
            centerInside = true;
          }
        }
        // 中心在文本内 或 超过 50% 面积重叠 → 丢弃
        return !centerInside && totalOverlap / bArea < 0.5;
      });

      // 字号归一化：用全页中位数，把偏离太大的修正到 ±30% 内
      const sizes = filtered.map((b) => b.fontSize).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      if (sizes.length > 2) {
        const mid = Math.floor(sizes.length / 2);
        const median = sizes.length % 2 === 0
          ? (sizes[mid - 1] + sizes[mid]) / 2
          : sizes[mid];
        filtered = filtered.map((b) => ({
          ...b,
          fontSize: typeof b.fontSize === "number"
            ? Math.max(median * 0.7, Math.min(median * 1.3, b.fontSize))
            : b.fontSize,
        }));
      }

      // STEP-2c-C1：优先经生产 seam 写入 Core。
      // 仅当 Core 未认领（不可用 / 归一化为空 / commit 失败）时才回落旧 setBlocks —— 保证不产生 duplicate。
      const committedToCore = onOcrResult?.(filtered) === true;
      if (!committedToCore) {
        // B2-3：OCR owner = Core/W3 ⇒ Legacy OCR writer disabled（互斥）。
        // 同时携带 generation：若 OCR 异步期间发生 re-import / Page Op（世代已变），
        // 旧世代的 Legacy 直写被拒绝，由新世代重新派生，避免「看起来正常、内部已分叉」。
        const guard = captureDocBlocksWriteGuard();
        setBlocks((prev) => guardedDocBlocksUpdate(guard, prev, (p) => [...p, ...filtered]));
      }
    } catch (err) { console.error(err); }
    setOcrBusy(false);
  };

  const handleOCRRegion = async (x: number, y: number, w: number, h: number) => {
    if (!canvasRef.current || ocrBusy) return;
    if (w < 20 || h < 20) return;
    setOcrBusy(true);
    try {
      const canvas = canvasRef.current;
      const s = cssScaleRef.current;
      // CSS → canvas pixel for cropping
      const cx = x / s, cy = y / s, cw = w / s, ch = h / s;
      const offscreen = document.createElement("canvas");
      offscreen.width = cw;
      offscreen.height = ch;
      const ctx = offscreen.getContext("2d")!;
      ctx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
      const regionDataUrl = offscreen.toDataURL("image/png");
      const blocks = await runInlineOCR(regionDataUrl, page, s, 6); // PSM 6: single text block
      // Translate OCR coords (relative to region) → page CSS coords
      blocks.forEach((b) => { b.x += x; b.y += y; });
      // STEP-2c-C1：优先经生产 seam 写入 Core（与 W3 同契约，未认领才回落旧 setBlocks）。
      const committedToCore = onOcrResult?.(blocks) === true;
      if (!committedToCore) {
        // B2-3：同上 —— OCR owner 互斥 + generation 守卫。
        const guard = captureDocBlocksWriteGuard();
        setBlocks((prev) => guardedDocBlocksUpdate(guard, prev, (p) => [...p, ...blocks]));
      }
    } catch (err) { console.error(err); }
    setOcrBusy(false);
  };

  return { handleOCR, handleOCRRegion, ocrBusy };
}
