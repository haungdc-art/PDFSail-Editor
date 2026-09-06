/**
 * Document Facts Layer — Story-2A
 *
 * 统一 Document AI Pipeline 的「事实模型」。
 *
 * ────────────────────────────────────────────────────────────────
 * Facts are IMMUTABLE.
 *
 *   Modules PRODUCE new facts.
 *   Never MODIFY existing facts.
 *
 * 任何模块不得执行 facts.xxx = xxx，只能产出新的 facts。
 * 否则 Semantic / Geometry / Resolver 会互相修改，Document Model 很快崩坏。
 * ────────────────────────────────────────────────────────────────
 *
 * 核心原则（Facts 与 Decision 分离）：
 *   - OCR / Layout / Visual / Semantic 只 Produce Facts（事实）。
 *   - 只有 Strategy Layer 才做 Decision（决策）。
 *   - 本文件【只定义 Facts，绝不包含任何 Decision 字段】。
 *
 * 因此本文件【不允许】出现：
 *   needGeometry / needOCR / needMetadata / processingStrategy / rotationStrategy
 * 等任何"决策"型字段。
 *
 * 所有字段必须能映射现有 OCR / Semantic / Geometry 的输出，
 * 不新增业务语义、不改变任何现有功能、不接入任何 Pipeline。
 *
 * ────────────────────────────────────────────────────────────────
 * 架构设计图
 *
 *   OCR
 *     ↓
 *   OCR Facts        （Story-2A）
 *     ↓
 *   Layout Facts
 *     ↓
 *   Visual Facts
 *     ↓
 *   Semantic Facts
 *     ↓
 *   Strategy Decision  ← 注意：不属于 Facts（Story-2C）
 *     ↓
 *   Geometry / OCR / Metadata / Skip
 *     ↓
 *   Renderer
 * ────────────────────────────────────────────────────────────────
 */

import type { BBox } from "./types";

// ────────────────────────────────────────────────────────────────
// OCRFacts — OCR 输出原始观测（GLM / Azure / Google / Tesseract）
// ────────────────────────────────────────────────────────────────

/**
 * OCR 输出的事实。
 * 直接映射 OCR 的 label / bbox / text / angle / confidence，
 * 不做任何类型判断或决策。
 *
 * 设计上不叫 ProviderFacts：真正需要保留的是「OCR 输出」本身，
 * 未来更换 OCR Provider（GLM→Azure→Google→Tesseract），本 Facts 无需变化。
 */
export interface OCRFacts {
  /** OCR 返回的区域 label（如 "text"、"title"、"table"、"figure"） */
  label?: string;
  /** 区域边界框（归一化或 canvas 坐标，随 OCR） */
  bbox: BBox;
  /** 区域文本内容 */
  text: string;
  /** OCR 报告的旋转角（degree）。可能缺失，是"事实"，不代表任何决策 */
  angle?: number;
  /** OCR 置信度（0-1） */
  confidence?: number;
  /** OCR 引擎名称标识（如 "glm-ocr"） */
  providerName: string;
}

// ────────────────────────────────────────────────────────────────
// VisualFacts — 视觉观测
// ────────────────────────────────────────────────────────────────

/**
 * 视觉层观测到的事实。
 * 顶层只保留元信息；具体测量值统一收进 metrics 子对象，
 * 未来新增 strokeDensity / pixelEntropy / connectedComponents / edgeDensity
 * 等指标时，全部放 metrics 里，不污染顶层。
 *
 * metrics 是「观测」（Observation），不是「结论」（Conclusion）。
 * 例如 upperRatio 是大写比例事实，但不能在此推导"手写/印刷"（那是 Decision）。
 */
export interface VisualFacts {
  /** 视觉测量值集合（纯观测，无推导） */
  metrics: {
    /** 大写字符占字母比例（0-1） */
    upperRatio?: number;
    /** bbox 高宽比（h / w） */
    aspectRatio?: number;
    /** 是否位于页面底部区域（y 占比 > 0.7） */
    isBottomArea?: boolean;
    /** 是否为纯图像块（无文本） */
    isImageOnly?: boolean;
    /** 页面高度（用于归一化判断的参考） */
    pageHeight?: number;
  };
}

// ────────────────────────────────────────────────────────────────
// LayoutFacts — 布局观测
// ────────────────────────────────────────────────────────────────

/**
 * 布局层观测到的事实。
 * 记录布局相关观测，但不做"是否 preserve / 是否 reflow"等决策。
 */
export interface LayoutFacts {
  /** 块来源（pdf_native / ocr / hybrid） */
  source: "pdf_native" | "ocr" | "hybrid";
  /** 原始 bbox（遮盖区域） */
  originalBounds?: BBox;
  /** 文本行数（观测） */
  lineCount?: number;
}

// ────────────────────────────────────────────────────────────────
// SemanticFacts — 语义观测
// ────────────────────────────────────────────────────────────────

/**
 * 语义层观测到的事实。
 * 统一用 evidence 数组记录"命中了什么证据"（关键词 / 正则 / pattern / LLM 判断），
 * 未来新增 Regex / Dictionary / Rule Engine / LLM 来源时，都往 evidence 里追加，
 * 无需每次新增字段。
 *
 * 只记录证据本身，不推导对象类型（那是 Decision）。
 * 例如 evidence: ["DoctorKeyword", "CRMKeyword"] 是事实，
 * 但不能在此推导 "signatureField"（那是由 Strategy 决定的）。
 */
export interface SemanticFacts {
  /** 命中的证据列表（来源不限：关键词 / 正则 / pattern / LLM） */
  evidence?: string[];
  /** 语义检测来源 */
  detectedBy?: "pattern" | "layout" | "keyword" | "position" | "ai_inferred" | "llm";
}

// ────────────────────────────────────────────────────────────────
// DocumentFacts — 统一事实结构
// ────────────────────────────────────────────────────────────────

/**
 * 单个文档对象的事实集合 — 将各层 Facts 聚合到统一结构。
 *
 * 注意：这里不是"一个事实"，而是聚合了多个维度的 Facts，
 * 因此命名为复数 DocumentFacts 更准确。
 *
 * 全部为 Facts，不含任何 Decision。
 */
export interface DocumentFacts {
  /** 唯一 ID（通常与源 block 对应） */
  id: string;
  /** 页码 */
  page: number;
  /** OCR 原始观测 */
  ocr: OCRFacts;
  /** 视觉观测 */
  visual?: VisualFacts;
  /** 布局观测 */
  layout?: LayoutFacts;
  /** 语义观测 */
  semantic?: SemanticFacts;
}

/** 从现有 OcrTextBlock / EditableBlock 构造 DocumentFacts 的辅助类型入参（仅映射，无决策） */
export type DocumentFactsSource = {
  id: string;
  page: number;
  text: string;
  label?: string;
  bbox: BBox;
};
