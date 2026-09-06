/**
 * SignatureLayoutNormalizer V2 — Signature Region Splitter
 *
 * GLM OCR 将横向签名误识别为竖排文字：每个单词独占一行，bbox 窄高。
 * 此模块将其拆分为多个横向逻辑块（姓名 / 职称 / 注册号），并删除原始竖排块。
 *
 * 检测规则（任一满足即触发）：
 *   1. classifyRegion 返回 "signature"
 *   2. 页面底部 + 医生关键词（Dr./Dra./CRM 等）
 *   3. bbox 竖直形状：height > width * 2 且文本含换行符
 *
 * 拆分规则（按行类型分组）：
 *   A. 姓名块：Dr. 前缀 + 紧跟的连续人名
 *   B. 职称块：Médico / Médica / MD 等独立行
 *   C. CRM 块：CRM- 前缀 + 数字行
 *
 * 输出：
 *   多个独立横向 OcrTextBlock，原始竖排 block 被删除（通过 flatMap）。
 *
 * 管线约定：
 *   本模块作为独立 step 插入在 OCR 解析之后、EditableDocument 构建之前。
 *   调用方使用 flatMap 模式：旧 block 不进入下一步。
 */

import type { OcrTextBlock } from "../ocr/ocr-storage";
import { classifyRegion } from "./region-classifier";

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface SignatureNormalizeResult {
  /** 是否需要替换 */
  changed: boolean;
  /** 原始 block ID（changed=true 时标记旧 block 用于日志） */
  originalBlockId: string;
  /** 输出 blocks：changed=false 时 = [originalBlock]；changed=true 时 = 新的 horizontal blocks */
  blocks: OcrTextBlock[];
}

// ────────────────────────────────────────────────────────────────
// 检测关键词 / 模式
// ────────────────────────────────────────────────────────────────

const DOCTOR_PREFIX_RE = /^(dr|dra|doutor|doutora)\.?$/i;
const PROFESSION_RE = /^(m[eé]dico|m[eé]dica|md|m\.d\.)$/i;
const CRM_PREFIX_RE = /^crm/i;
const CRM_NUMBER_RE = /^\d{4,7}$/;

function hasDoctorKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return /dr\.|dra\.|doutor|doutora|crm|m[eé]dico|m[eé]dica/.test(lower);
}

function isBottomArea(y: number, pageHeight: number): boolean {
  return pageHeight > 0 && y > pageHeight * 0.7;
}

// ────────────────────────────────────────────────────────────────
// 检测逻辑
// ────────────────────────────────────────────────────────────────

function shouldSplit(block: OcrTextBlock, pageHeight: number): boolean {
  const textLines = block.text.split("\n").filter(l => l.trim().length > 0);
  if (textLines.length <= 1) return false;

  // Rule 1: GLM-OCR label / keyword → signature
  const regionType = classifyRegion(block, pageHeight);
  if (regionType === "signature") return true;

  // Rule 2: 页面底部 + 医生关键词
  if (isBottomArea(block.y, pageHeight) && hasDoctorKeyword(block.text)) {
    return true;
  }

  // Rule 3: 竖直形状 + 多行文本
  if (block.h > block.w * 2) return true;

  return false;
}

// ────────────────────────────────────────────────────────────────
// 行分类
// ────────────────────────────────────────────────────────────────

type LineType = "name" | "profession" | "crm_prefix" | "crm_number" | "unknown";

interface ClassifiedLine {
  text: string;
  type: LineType;
  lineIndex: number;
}

function classifyLine(text: string, prevType: LineType | null): LineType {
  const t = text.trim();
  if (!t) return "unknown";

  if (DOCTOR_PREFIX_RE.test(t)) return "name";
  if (PROFESSION_RE.test(t)) return "profession";
  if (CRM_PREFIX_RE.test(t)) return "crm_prefix";
  if (CRM_NUMBER_RE.test(t) && prevType === "crm_prefix") return "crm_number";
  if (CRM_NUMBER_RE.test(t)) return "crm_number";

  return "name";
}

// ────────────────────────────────────────────────────────────────
// 行分组
// ────────────────────────────────────────────────────────────────

interface LineGroup {
  lines: string[];
  lineIndices: number[];
  label: string;
}

function groupLines(lines: string[]): LineGroup[] {
  const classified: ClassifiedLine[] = [];
  let prevType: LineType | null = null;

  for (let i = 0; i < lines.length; i++) {
    const type = classifyLine(lines[i], prevType);
    classified.push({ text: lines[i].trim(), type, lineIndex: i });
    prevType = type;
  }

  const groups: LineGroup[] = [];
  let i = 0;

  while (i < classified.length) {
    const cur = classified[i];

    switch (cur.type) {
      case "name": {
        const grp: LineGroup = { lines: [], lineIndices: [], label: "name" };
        while (i < classified.length && classified[i].type === "name") {
          grp.lines.push(classified[i].text);
          grp.lineIndices.push(classified[i].lineIndex);
          i++;
        }
        groups.push(grp);
        break;
      }

      case "profession": {
        groups.push({
          lines: [cur.text],
          lineIndices: [cur.lineIndex],
          label: "profession",
        });
        i++;
        break;
      }

      case "crm_prefix": {
        const grp: LineGroup = { lines: [], lineIndices: [], label: "crm" };
        grp.lines.push(cur.text);
        grp.lineIndices.push(cur.lineIndex);
        i++;
        while (i < classified.length && classified[i].type === "crm_number") {
          grp.lines.push(classified[i].text);
          grp.lineIndices.push(classified[i].lineIndex);
          i++;
        }
        groups.push(grp);
        break;
      }

      case "crm_number": {
        const last = groups[groups.length - 1];
        if (last && last.label === "name") {
          last.lines.push(cur.text);
          last.lineIndices.push(cur.lineIndex);
        } else {
          groups.push({
            lines: [cur.text],
            lineIndices: [cur.lineIndex],
            label: "crm",
          });
        }
        i++;
        break;
      }

      default: {
        const last = groups[groups.length - 1];
        if (last) {
          last.lines.push(cur.text);
          last.lineIndices.push(cur.lineIndex);
        } else {
          groups.push({
            lines: [cur.text],
            lineIndices: [cur.lineIndex],
            label: "name",
          });
        }
        i++;
        break;
      }
    }
  }

  return groups;
}

// ────────────────────────────────────────────────────────────────
// 创建新 block
// ────────────────────────────────────────────────────────────────

function estimateTextWidth(text: string, fontSize: number): number {
  const charWidth = fontSize * 0.55;
  return Math.max(text.length * charWidth, 50);
}

function createNewBlock(
  group: LineGroup,
  originalBlock: OcrTextBlock,
  ocrRatio: number,
  totalLines: number,
): OcrTextBlock {
  const text = group.lines.join(" ");
  const fontSize = originalBlock.fontSize || 14;
  const lineHeight = Math.max(fontSize * 1.25, 10);

  const newW = estimateTextWidth(text, fontSize);
  const newH = lineHeight;

  // 水平居中于原始 bbox
  const centerX = originalBlock.x + originalBlock.w / 2;
  const newX = centerX - newW / 2;

  // 垂直位置：根据该组第一行在原始 bbox 中的比例
  const firstIdx = group.lineIndices[0];
  const ratio = totalLines > 1 ? firstIdx / totalLines : 0;
  const newY = originalBlock.y + ratio * originalBlock.h;

  const newBlock: OcrTextBlock = {
    id: crypto.randomUUID(),
    page: originalBlock.page,
    x: newX,
    y: newY,
    w: newW,
    h: newH,
    text,
    fontSize,
    label: "signature",
  };

  // 同步 OCR canvas 坐标系 bbox（用于后续 image crop）
  (newBlock as any)._ocrCanvasBbox = {
    x: newX * ocrRatio,
    y: newY * ocrRatio,
    w: newW * ocrRatio,
    h: newH * ocrRatio,
  };

  // 传递原始 provider angle（如有）
  const providerAngle = (originalBlock as any)._providerAngle as number | undefined;
  if (providerAngle !== undefined) {
    (newBlock as any)._providerAngle = providerAngle;
  }

  // Sprint-1 Commit 3：Geometry Ownership 迁移到 Distributor。
  // Normalizer 不再负责 Geometry 复制；仅记录 child 与 parent 的关联，
  // 由 Geometry Distributor 负责分配 Child Geometry。
  (newBlock as any)._parentBlockId = originalBlock.id;

  // Task-W2-3B Trace：记录 Normalizer 输出 child 的 providerAngle（incoming）与是否带 geometry
  const childProviderAngle = (newBlock as any)._providerAngle as number | undefined;
  console.log(
    `[SignatureRotationTrace] Stage:Normalizer Block:${newBlock.id} ` +
      `incomingProviderAngle:${childProviderAngle ?? 0} ` +
      `hasGeometry:${(newBlock as any).geometry ? "yes" : "no"}`,
  );

  return newBlock;
}

// ────────────────────────────────────────────────────────────────
// 公开 API
// ────────────────────────────────────────────────────────────────

/**
 * 对单个 OCR block 进行签名排版归一化。
 *
 * @param block      原始 OCR block（canvas-pixel space at scale=1.5）
 * @param pageHeight 页面高度（同坐标系），传 0 则跳过底部检测规则
 * @param ocrRatio   OCR canvas scale / editor scale（用于 _ocrCanvasBbox 同步）
 * @returns { changed, originalBlockId, blocks }
 */
export function normalizeSignatureLayout(
  block: OcrTextBlock,
  pageHeight: number = 0,
  ocrRatio: number = 1,
): SignatureNormalizeResult {
  if (!shouldSplit(block, pageHeight)) {
    return { changed: false, originalBlockId: block.id, blocks: [block] };
  }

  const textLines = block.text.split("\n").filter(l => l.trim().length > 0);
  if (textLines.length <= 1) {
    return { changed: false, originalBlockId: block.id, blocks: [block] };
  }

  const groups = groupLines(textLines);

  if (groups.length === 0) {
    return { changed: false, originalBlockId: block.id, blocks: [block] };
  }

  const newBlocks: OcrTextBlock[] = groups.map(group =>
    createNewBlock(group, block, ocrRatio, textLines.length),
  );

  return {
    changed: true,
    originalBlockId: block.id,
    blocks: newBlocks,
  };
}
