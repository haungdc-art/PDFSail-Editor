/**
 * ocr-utils.ts — GLM-OCR 客户端工具函数
 *
 * 使用智谱 GLM-OCR 模型（通过后端 /api/ocr/page 代理调用）实现高精度文档 OCR，
 * 替代原开源 Tesseract.js 方案。
 *
 * 实现：
 *   1. detectScannedPdf: 判断 PDF 是否为扫描件（无文本层，仍用 pdfjs 客户端检测）
 *   2. runPageOCR: 单页 OCR → 文本块（canvas-pixel space at scale=1.5）
 *   3. runFullOcr: 多页 OCR + 进度回调
 *
 * 坐标系约定：
 *   - 渲染 PDF 时使用 scale = 1.5（与 PDFEditor.tsx 一致）
 *   - 将渲染后的 canvas PNG 发送到后端 GLM-OCR 代理
 *   - GLM-OCR 返回 bbox_2d（归一化坐标），转换为 canvas-pixel space at scale=1.5
 *   - 编辑器加载时只需 × cssScale（canvas.clientWidth / canvas.width）即可得到 CSS 显示坐标
 */

import * as pdfjsLib from "pdfjs-dist";
import type { OcrTextBlock } from "./ocr-storage";
import { buildGeometryForBlocks } from "./geometry-pipeline";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/** OCR 渲染时的视口缩放（2.0 提供更高分辨率，改善 GLM-OCR 文本检测率） */
const RENDER_SCALE = 2.0;
/** 编辑器 canvas 渲染缩放（PDFEditor.tsx 的 scale=1.5，OCR 坐标需转换到此尺度） */
const EDITOR_SCALE = 1.5;

export interface ScanDetectionResult {
  isScanned: boolean;
  pages: number;
  /** 平均每页文本字符数 */
  avgCharsPerPage: number;
}

/**
 * 判断 PDF 是否为扫描件。
 * 判定规则：抽取前 3 页（或全部页数，取较小值），若所有抽样页的 textContent 字符总数 < 阈值，则视为扫描件。
 */
export async function detectScannedPdf(
  buf: ArrayBuffer
): Promise<ScanDetectionResult> {
  const pdf = await pdfjsLib.getDocument({
    data: buf.slice(0),
    cMapUrl: "/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/standard_fonts/",
  }).promise;

  const pages = pdf.numPages;
  const samplePages = Math.min(3, pages);
  let totalChars = 0;
  // 扫描件判定的唯一标准：抽样页是否存在原生文本层。
  // 与编辑器渲染路径的 hasNativeText 判定一致（PDFEditor.tsx）——
  // 只要 PDF 有原生文本（无论多短），就是可原生编辑的文本 PDF，不应路由去 OCR。
  // 旧实现用 avgCharsPerPage < 50 的字符阈值，导致短文本原生 PDF（如 20 字符表单）
  // 被误判为扫描件 → 用户被拦在编辑器门外（编辑入口链路断裂的根因）。
  let hasNativeText = false;

  for (let p = 1; p <= samplePages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const chars = tc.items.reduce((sum: number, it: any) => sum + (it.str?.length || 0), 0);
    totalChars += chars;
    if (tc.items.some((it: any) => it.str?.trim?.())) hasNativeText = true;
  }

  await pdf.destroy();

  const avgCharsPerPage = samplePages > 0 ? totalChars / samplePages : 0;
  // 有原生文本 → 非扫描件（可原生编辑）；无任何文本 → 扫描件（需 OCR）。
  const isScanned = !hasNativeText;

  return { isScanned, pages, avgCharsPerPage };
}

/**
 * 渲染 PDF 指定页到 canvas（scale=1.5，与编辑器一致）
 */
async function renderPageToCanvas(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNum: number
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** GLM-OCR layout_details 中单个 region 的结构 */
interface GlmOcrRegion {
  index?: number;
  label?: string;
  bbox_2d?: [number, number, number, number];
  content?: string;
  /** OCR provider 返回的旋转角度（度，可选） */
  angle?: number;
}

/** 后端 /api/ocr/page 返回的 GLM-OCR 响应结构 */
interface GlmOcrResponse {
  layout_details?: GlmOcrRegion[][];
  md_results?: string | string[];
  data_info?: {
    num_pages?: number;
    pages?: { width: number; height: number }[];
  };
  error?: string | { code?: number; message?: string };
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * 将 GLM-OCR 的 bbox_2d 转换为 canvas-pixel space at scale=1.5。
 * bbox_2d 格式：[x1, y1, x2, y2]
 *
 * 实测智谱官方 API（open.bigmodel.cn）返回的是基于输入图片的绝对像素坐标
 * （因为发送给 API 的就是 canvas 渲染的 PNG，所以直接就是 canvas-pixel space at scale=1.5）。
 * 兼容处理：若所有值 ≤ 1，则按 0-1 归一化（某些 API 版本可能返回归一化坐标）。
 */
function bboxToCanvasPx(
  bbox: [number, number, number, number],
  canvasW: number,
  canvasH: number
): { x: number; y: number; w: number; h: number } {
  const [x1, y1, x2, y2] = bbox;
  const maxVal = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2));
  // 若所有值 ≤ 1，按 0-1 归一化（兼容某些 API 版本）
  if (maxVal <= 1) {
    return {
      x: x1 * canvasW,
      y: y1 * canvasH,
      w: (x2 - x1) * canvasW,
      h: (y2 - y1) * canvasH,
    };
  }
  // 否则视为绝对像素坐标（基于输入图片，即 canvas 渲染图，直接对应 scale=1.5 canvas px）
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * 清理 GLM-OCR content 中的 markdown 和 HTML 标记，返回纯文本。
 * 例如："## 标题" → "标题"，"**加粗**" → "加粗"，"<table><tr><td>单元格</td></tr></table>" → "单元格"
 */
function cleanMarkdownContent(text: string): string {
  let s = text.trim();
  // 先处理 HTML 标签（GLM-OCR 的 md_results 中表格等用 HTML 表示）
  // 1. 将 <br> 转为换行
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // 2. 将 </td>、</th> 转为制表符（保留表格单元格分隔）
  s = s.replace(/<\/t[dh]>/gi, "\t");
  // 3. 将 </tr>、</li>、</p> 转为换行
  s = s.replace(/<\/(tr|li|p|div|h[1-6])>/gi, "\n");
  // 4. 剥离所有剩余 HTML 标签
  s = s.replace(/<[^>]+>/g, "");
  // 5. 去除 HTML 实体
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  // 去除标题前缀（##、###、#）
  s = s.replace(/^#{1,6}\s*/, "");
  // 去除加粗/斜体标记
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  s = s.replace(/\*(.+?)\*/g, "$1");
  s = s.replace(/_(.+?)_/g, "$1");
  // 去除行内代码标记
  s = s.replace(/`(.+?)`/g, "$1");
  // 去除 Markdown 表格分隔符（|）
  s = s.replace(/^\|.*\|$/gm, (line) => line.replace(/\|/g, " ").trim());
  // 清理多余制表符和行尾空白
  s = s.replace(/[ \t]+$/gm, "");
  return s.trim();
}

/**
 * 调用后端 GLM-OCR 代理，对单张图片执行 OCR。
 */
async function callGlmOcr(
  imageDataUrl: string,
  pageNum: number,
  fileName?: string
): Promise<GlmOcrResponse> {
  const resp = await fetch("/api/ocr/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl, page: pageNum, fileName }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    // 解析后端返回的结构化错误，提取 ocrErrorCode 供前端国际化
    let ocrErrorCode: number | undefined;
    try {
      const parsed = JSON.parse(errText);
      ocrErrorCode = parsed?.ocrErrorCode;
    } catch { /* 非 JSON，忽略 */ }
    const err = new Error(`GLM-OCR proxy failed: ${resp.status}`);
    (err as any).ocrErrorCode = ocrErrorCode;
    throw err;
  }

  const data = (await resp.json()) as GlmOcrResponse;

  // 智谱错误响应格式：{ code, message } 或 { error }
  if (data.error) {
    const msg =
      typeof data.error === "string"
        ? data.error
        : data.error.message || "GLM-OCR unknown error";
    throw new Error(msg);
  }

  return data;
}

/**
 * 单页 OCR：渲染 → 调用后端 GLM-OCR → 解析 layout_details 为文本块
 * 输出坐标在 canvas-pixel space at scale=1.5（与编辑器 docBlocks 的存储约定一致，
 * 但未乘以 cssScale；编辑器加载时会乘以 cssScale 转为 CSS 显示坐标）。
 */
export async function runPageOCR(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  _language = "eng"
): Promise<OcrTextBlock[]> {
  // 1. 渲染 PDF 页为 canvas（scale=1.5）
  const canvas = await renderPageToCanvas(pdf, pageNum);
  const canvasW = canvas.width;
  const canvasH = canvas.height;

  // 2. 转 data URL，发送到后端 GLM-OCR 代理
  // 使用 JPEG 格式（扫描件体积远小于 PNG），并确保 ≤9MB（GLM-OCR 限制 10MB）
  let imageDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const MAX_BYTES = 9 * 1024 * 1024; // 9MB（留余量，GLM-OCR 限制 10MB）
  // W2-1：记录实际发送给 GLM 的图片尺寸（默认原始 canvas 尺寸）
  let sentW = canvas.width;
  let sentH = canvas.height;
  // base64 data URL 体积 ≈ rawBytes × 1.37
  if (imageDataUrl.length * 0.75 > MAX_BYTES) {
    // 超限：逐步降低分辨率重试
    let scale = 0.8;
    while (scale > 0.3) {
      const w = Math.round(canvas.width * scale);
      const h = Math.round(canvas.height * scale);
      const small = document.createElement("canvas");
      small.width = w;
      small.height = h;
      const sctx = small.getContext("2d")!;
      sctx.drawImage(canvas, 0, 0, w, h);
      imageDataUrl = small.toDataURL("image/jpeg", 0.88);
      // W2-1：记录实际发送尺寸（GLM 返回的 bbox 基于此尺寸）
      sentW = w;
      sentH = h;
      if (imageDataUrl.length * 0.75 <= MAX_BYTES) break;
      scale -= 0.15;
    }
  }
  const ocrResult = await callGlmOcr(imageDataUrl, pageNum);
  const pageUsage = ocrResult.usage;

  // 3. 解析 layout_details → OcrTextBlock[]
  //    layout_details 是二维数组：外层=页，内层=region。单页调用取第一页。
  const regions = ocrResult.layout_details?.[0] || [];

  // ── 使用 md_results 修复被截断的 region content ──
  // GLM-OCR 的 layout_details 中 region.content 可能被截断（只含第一行），
  // 但 md_results 包含完整文本。用 md_results 补全截断的 content。
  if (ocrResult.md_results) {
    const mdText = Array.isArray(ocrResult.md_results)
      ? ocrResult.md_results.join("\n")
      : ocrResult.md_results;
    // 将 md_results 按空行分割为文本块，过滤图片引用
    const mdBlocks = mdText
      .split(/\n\n+/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith("![]("));

    for (const region of regions) {
      const rawContent = (region.content || "").trim();
      if (!rawContent) continue;
      const cleanedRaw = cleanMarkdownContent(rawContent).trim();
      // 在 mdBlocks 中查找以 region content 为前缀的文本块
      for (const mdBlock of mdBlocks) {
        const cleanedMd = cleanMarkdownContent(mdBlock).trim();
        if (cleanedMd.startsWith(cleanedRaw) && cleanedMd.length > cleanedRaw.length + 5) {
          // 找到更长的版本，用完整文本替换截断的 content
          region.content = cleanedMd;
          break;
        }
      }
    }
  }

  const blocks: OcrTextBlock[] = [];
  for (const region of regions) {
    const rawContent = (region.content || "").trim();
    if (!rawContent) continue;
    // 跳过纯图片区域（无文本内容）
    if (region.label === "figure" || region.label === "image") continue;

    if (!region.bbox_2d || region.bbox_2d.length !== 4) continue;

    const content = cleanMarkdownContent(rawContent);
    if (!content) continue;

    // W2-1：用实际发送给 GLM 的图片尺寸换算（避免降采样后坐标偏移）
    const px = bboxToCanvasPx(region.bbox_2d, sentW, sentH);
    // 过滤异常 bbox（尺寸为 0 或过大）
    if (px.w < 1 || px.h < 1) continue;

    const h = Math.max(px.h, 1);

    // 估算文本行数：GLM-OCR 的 bbox 可能覆盖多行文本
    // 1. 先按换行符分割
    const textLines = content.split('\n').filter(l => l.trim().length > 0);
    let lineCount = Math.max(1, textLines.length);
    // 2. 无换行符的 block 先标记 lineCount=1，后面用中位数高度二次估算

    // 单行高度 = bbox 总高度 / 行数；fontSize ≈ 单行高度 × 0.85
    const singleLineHeight = h / lineCount;

    blocks.push({
      id: crypto.randomUUID(),
      page: pageNum,
      x: px.x,
      y: px.y,
      w: px.w,
      h,
      text: content,
      fontSize: singleLineHeight * 0.85,
      // 保留 GLM-OCR 的区域 label，用于区域分类（Signature/Table/Stamp/Footer 等）
      label: region.label,
      // 临时存储行数，用于后续归一化
      _lineCount: lineCount,
      // 临时存储 OCR provider angle（用于 geometry 检测）
      _providerAngle: region.angle,
      // 临时存储 OCR canvas (scale=2.0) 坐标系的 bbox（用于 image crop）
      _ocrCanvasBbox: { x: px.x, y: px.y, w: px.w, h },
    } as OcrTextBlock & { _lineCount: number; _providerAngle?: number; _ocrCanvasBbox: { x: number; y: number; w: number; h: number } });
    // Task-W2-3C Trace-1：打印 OCR 输出入参，闭合"region.angle → _providerAngle"证据链
    console.log(
      `[SignatureRotationTrace] Stage:OCR region.id:${region.id} ` +
        `label:${JSON.stringify(region.label)} text:${JSON.stringify(content.slice(0, 30))} ` +
        `region.angle:${JSON.stringify(region.angle)} _providerAngle:${JSON.stringify(region.angle)}`,
    );
  }

  // ── 坐标尺度转换：OCR 渲染 scale=2.0 → 编辑器 scale=1.5 ──
  // GLM-OCR 返回的 bbox 是归一化坐标 [0,1000]，bboxToCanvasPx 转为 OCR canvas 像素（scale=2.0）。
  // 编辑器 canvas 使用 scale=1.5，需要转换以确保 block 位置对齐。
  if (RENDER_SCALE !== EDITOR_SCALE) {
    const ratio = EDITOR_SCALE / RENDER_SCALE; // 0.75
    for (const b of blocks) {
      b.x *= ratio;
      b.y *= ratio;
      b.w *= ratio;
      b.h *= ratio;
    }
  }

  // ── 二次行数估算：用有换行符的 block 的单行高度中位数作为参考 ──
  // 对于无换行符但 bbox 高度过大的 block，估算其行数
  if (blocks.length > 0) {
    // 收集有显式换行符的 block 的单行高度（这些是可靠的参考）
    const refHeights = blocks
      .filter(b => {
        const lc = (b as any)._lineCount || 1;
        return lc > 1; // 有换行符的多行 block
      })
      .map(b => {
        const lc = (b as any)._lineCount || 1;
        return b.h / lc;
      });

    // 如果没有多行 block 作参考，用所有 block 高度的下四分位数（最矮的，接近单行）
    let refLineHeight: number;
    if (refHeights.length > 0) {
      refHeights.sort((a, b) => a - b);
      refLineHeight = refHeights[Math.floor(refHeights.length / 2)];
    } else {
      const allH = blocks.map(b => b.h).sort((a, b) => a - b);
      refLineHeight = allH[Math.floor(allH.length * 0.25)] || 30;
    }

    for (const b of blocks) {
      const lc = (b as any)._lineCount || 1;
      if (lc === 1 && b.h > refLineHeight * 1.8) {
        // 高度超过单行参考值的 1.8 倍 → 多行
        const estLc = Math.max(1, Math.round(b.h / refLineHeight));
        (b as any)._lineCount = estLc;
      }
    }
  }

  // ── 页面级字号归一化 ──
  // GLM-OCR 的 bbox 高度不一致（有的偏高、有的偏低），导致 fontSize 差异巨大。
  // 用所有 block 的单行高度中位数作为基准，将异常值 clamp 到合理范围。
  if (blocks.length > 0) {
    const singleHeights = blocks.map(b => {
      const lc = (b as any)._lineCount || 1;
      return b.h / lc;
    });
    const sorted = [...singleHeights].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 20;

    for (const b of blocks) {
      const lc = (b as any)._lineCount || 1;
      const singleH = b.h / lc;
      // 紧缩 clamp 范围 [0.75×median, 1.25×median]：字号差异控制在 ±25% 内
      let clampedH: number;
      if (singleH > median * 1.25) {
        clampedH = median * 1.25;
      } else if (singleH < median * 0.75) {
        clampedH = median * 0.75;
      } else {
        clampedH = singleH;
      }
      b.fontSize = Math.max(Math.min(clampedH * 0.85, 64), 8);
      const oldH = b.h;
      // 关键修复：永远不让 block 高度小于原始 OCR bbox 高度
      // 白色遮盖必须覆盖全部原文，否则原文会露出
      const normalizedH = clampedH * lc;
      b.h = Math.max(normalizedH, oldH); // ← 不缩减高度！
      delete (b as any)._lineCount; // 清理临时字段
    }
  }

  // ── Geometry Pipeline（P0-010 Commit 1）──
  // 职责拆分：几何检测从 runPageOCR 抽离到 geometry-pipeline.ts。
  // 行为与重构前一致（Geometry Analyzer 仅做 Enrichment，不决定 regionType）。
  buildGeometryForBlocks(blocks, canvas);

  return { blocks, usage: pageUsage };
}

export interface OcrUsage {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface OcrProgress {
  stage: "preparing" | "recognizing" | "creating";
  currentPage: number;
  totalPages: number;
}

/**
 * 多页 OCR + 进度回调
 * 流程：preparing（加载 PDF）→ recognizing（逐页 OCR）→ creating（保存结果）
 */
export async function runFullOcr(
  buf: ArrayBuffer,
  taskId: string,
  onProgress: (p: OcrProgress) => void,
  saveBlocks: (taskId: string, blocks: OcrTextBlock[]) => Promise<void>,
  onUsage?: (usage: OcrUsage) => void
): Promise<OcrTextBlock[]> {
  // Stage 1: Preparing
  onProgress({ stage: "preparing", currentPage: 0, totalPages: 0 });
  const pdf = await pdfjsLib.getDocument({
    data: buf.slice(0),
    cMapUrl: "/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/standard_fonts/",
  }).promise;
  const totalPages = pdf.numPages;
  onProgress({ stage: "preparing", currentPage: 0, totalPages });

  // Token 用量汇总
  const totalUsage: OcrUsage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };

  // Stage 2: Recognizing — 逐页 OCR（GLM-OCR）
  const allBlocks: OcrTextBlock[] = [];
  for (let p = 1; p <= totalPages; p++) {
    onProgress({ stage: "recognizing", currentPage: p, totalPages });
    const { blocks, usage } = await runPageOCR(pdf, p, "eng");
    allBlocks.push(...blocks);
    if (usage) {
      totalUsage.total_tokens += usage.total_tokens || 0;
      totalUsage.prompt_tokens += usage.prompt_tokens || 0;
      totalUsage.completion_tokens += usage.completion_tokens || 0;
    }
  }

  // Stage 3: Creating — 保存结果
  onProgress({ stage: "creating", currentPage: totalPages, totalPages });
  await saveBlocks(taskId, allBlocks);

  // 回调通知用量
  if (onUsage && totalUsage.total_tokens > 0) {
    onUsage(totalUsage);
  }

  await pdf.destroy();
  return allBlocks;
}
