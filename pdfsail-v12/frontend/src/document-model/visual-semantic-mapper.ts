/**
 * VisualSemanticMapper — Sprint36 · Commit 2B-2
 *
 * 把 OCR Facts 映射为 VisualSemantic。
 *
 *   OCR Facts（OcrTextBlock）
 *        ↓
 *   map()
 *        ↓
 *   VisualSemantic
 *
 * 【Mapper 纪律（METH-005）】
 *   - Mapper is Stateless：纯函数，无状态，无 cache / previousBlock / statistics。
 *   - Mapper translates facts, never interprets intent：
 *       - 允许：OCR label → VisualObjectType（映射事实）
 *       - 禁止：Signature → needGeometry（那是 Decision）
 *
 * 【内部实现分三步（私有，不导出，不新增 Contract）】
 *   normalizeFacts(...)  → 归一化 OCR Facts（label / text）
 *       ↓
 *   detectObjectType(...) → 判定 VisualObjectType
 *       ↓
 *   buildVisualSemantic(...) → 组装最终 VisualSemantic
 *
 *   - 三个函数均为 Mapper 内部实现，不导出、不叫 Resolver/Analyzer。
 *   - 未来增加 OCR Bounding Box / Metadata 时，只扩展 normalizeFacts，
 *     不会让本文件长成几百行。
 *
 * 【Vertical Slice】只映射能驱动 SignatureRule 的最小字段集：
 *   - objectType 是关键（SignatureRule 只消费 context.semantic.objectType）。
 *   - representation / confidence / evidence 给合理默认，不构建完整世界模型。
 *
 * 【职责边界】不 import DecisionResolver / Geometry / Pipeline / PDFEditor。
 * 只有一个公开方法 map()，没有 create / build / resolve / analyze。
 */

import type { OcrTextBlock } from "../ocr/ocr-storage";
import {
  VisualObjectType,
  VisualRepresentation,
  type VisualSemantic,
} from "./visual-semantic";

/** OCR label → VisualObjectType 的映射（基于 OCR 事实，非意图） */
const LABEL_TO_OBJECT_TYPE: Record<string, VisualObjectType> = {
  signature: VisualObjectType.Signature,
  sign: VisualObjectType.Signature,
  signed_name: VisualObjectType.Signature,
  autograph: VisualObjectType.Signature,
  stamp: VisualObjectType.Stamp,
  seal: VisualObjectType.Stamp,
  red_seal: VisualObjectType.Stamp,
  redstamp: VisualObjectType.Stamp,
  figure: VisualObjectType.Image,
  image: VisualObjectType.Image,
  table: VisualObjectType.Text,
  title: VisualObjectType.Text,
  text: VisualObjectType.Text,
};

/** 印章关键词（基于 OCR 文本事实） */
const STAMP_KEYWORD_RE = /seal|stamp|official seal|公章|专用章|医疗专用章|诊断专用章|证明专用章/i;
/** 签名关键词（基于 OCR 文本事实） */
const SIGNATURE_KEYWORD_RE = /assinatura|signature|signed|sign here|authorized signature|医师签名|签名|盖章/i;

/** 归一化后的 OCR Facts（Mapper 内部步骤 1 的输出） */
interface NormalizedFacts {
  /** 归一化 label（小写去空白） */
  label?: string;
  /** 原始文本 */
  text: string;
}

/**
 * 步骤 1：归一化 OCR Facts。
 *
 * 未来增加 OCR Bounding Box / Metadata 时，在此扩展。
 * 私有，不导出。
 */
function normalizeFacts(block: OcrTextBlock): NormalizedFacts {
  return {
    label: block.label?.toLowerCase().trim(),
    text: block.text || "",
  };
}

/**
 * 步骤 2：判定 VisualObjectType。
 *
 * ObjectType detection must rely only on observable OCR facts.
 * Never infer processing intent.
 *
 * 这是"映射事实"（基于 OCR label + text），不是"解释意图"。
 * 禁止写出依赖"看起来重要 / 需要旋转"等意图判断的代码。
 *
 * 优先级：
 *   1. 文本关键词优先（印章 / 签名）
 *      重要：GLM-OCR 对签名常返回 label="text"，若 label 先命中 Text
 *      会跳过关键词检查。因此关键词必须先于 label（映射事实，非解释意图）。
 *   2. OCR label 直接映射（label 明确为签名/印章/图像时）
 *   3. 默认 Text
 * 私有，不导出。
 */
function detectObjectType(facts: NormalizedFacts): VisualObjectType {
  // 1. 文本关键词优先
  if (STAMP_KEYWORD_RE.test(facts.text)) return VisualObjectType.Stamp;
  if (SIGNATURE_KEYWORD_RE.test(facts.text)) return VisualObjectType.Signature;

  // 2. OCR label 直接映射（label 明确为签名/印章/图像时）
  if (facts.label) {
    const mapped = LABEL_TO_OBJECT_TYPE[facts.label];
    if (mapped && mapped !== VisualObjectType.Text) return mapped;
  }

  // 3. 默认 Text
  return VisualObjectType.Text;
}

/**
 * 步骤 3：组装最终 VisualSemantic。
 *
 * 私有，不导出。
 */
function buildVisualSemantic(facts: NormalizedFacts, objectType: VisualObjectType): VisualSemantic {
  return {
    objectType,
    representation: VisualRepresentation.Unknown,
    confidence: 0.5,
    evidence: facts.label ? [`ocr-label:${facts.label}`] : [],
  };
}

/**
 * VisualSemanticMapper 契约。
 */
export interface VisualSemanticMapper {
  /** 把一个 OCR block 映射为 VisualSemantic（纯映射，无状态） */
  map(block: OcrTextBlock): VisualSemantic;
}

/**
 * 默认 VisualSemanticMapper 实现。
 *
 * Stateless 纯函数对象。
 * 内部走三步：normalizeFacts → detectObjectType → buildVisualSemantic。
 * 只映射能驱动 SignatureRule 的最小字段集。
 */
export const DefaultVisualSemanticMapper: VisualSemanticMapper = {
  map(block: OcrTextBlock): VisualSemantic {
    const facts = normalizeFacts(block);
    const objectType = detectObjectType(facts);
    return buildVisualSemantic(facts, objectType);
  },
};
