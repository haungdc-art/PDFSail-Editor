/**
 * VisualSemantic — Story-2B (Visual Taxonomy)
 *
 * 只回答两个问题：
 *   1. What is it?            → VisualObjectType
 *   2. How is it represented? → VisualRepresentation
 *
 * 绝不回答第三个问题：
 *   3. What should we do?     → 属于 Story-2C (Strategy Decision)
 *
 * ────────────────────────────────────────────────────────────────
 * 命名规范（项目统一）：
 *   *Facts      描述事实，只记录观测
 *   *Semantic   描述理解，只回答"它是什么"   ← 本文件
 *   *Decision   描述决策，只回答"应该怎么做"
 *   *Strategy   描述执行策略，只决定"由谁来做"
 *   *Pipeline   负责执行，不负责判断
 * ────────────────────────────────────────────────────────────────
 *
 * 核心纪律：
 *   - Object（对象类型）与 Representation（表现形式）是两个正交维度，
 *     永远不要揉成一个类型（禁止 PrintedSignature 这种合并写法）。
 *   - 本文件【不产生任何 Decision / Strategy】，无 NeedGeometry、
 *     processingStrategy 等字段。
 *   - 本文件【不 import】任何 Geometry / OCR / Renderer / Export / Pipeline。
 */

/**
 * 视觉对象类型 — What is it?
 *
 * 只描述"这个对象是什么"，与"它如何呈现"（Representation）解耦。
 * 例如：签名可以是印刷文本 / 手写 / 位图 / 电子，但都叫 Signature。
 */
export enum VisualObjectType {
  Unknown = "unknown",
  /** 普通文本 */
  Text = "text",
  /** 签名 */
  Signature = "signature",
  /** 印章 / 公章 */
  Stamp = "stamp",
  /** Logo */
  Logo = "logo",
  /** 二维码 */
  QRCode = "qrcode",
  /** 条形码 */
  Barcode = "barcode",
  /** 水印 */
  Watermark = "watermark",
  /** 复选框 */
  Checkbox = "checkbox",
  /** 注释 / 批注 */
  Annotation = "annotation",
  /** 高亮 */
  Highlight = "highlight",
  /** 图像（一般性） */
  Image = "image",
}

/**
 * 视觉表现形式 — How is it represented?
 *
 * 只描述"对象以什么形式呈现"，与"对象是什么"（ObjectType）解耦。
 * 这里没有 NeedGeometry 等决策，因为 Representation 不是 Decision。
 *
 * 组合示例（无需新增 Object）：
 *   Signature + Bitmap  → 扫描签名
 *   Signature + Digital → Adobe 电子签名
 *   Signature + PrintedText → 印刷医生签名
 */
export enum VisualRepresentation {
  Unknown = "unknown",
  /** 印刷文本 */
  PrintedText = "printedText",
  /** 手写笔迹 */
  Handwriting = "handwriting",
  /** 位图 */
  Bitmap = "bitmap",
  /** 矢量 */
  Vector = "vector",
  /** 栅格 */
  Raster = "raster",
  /** 电子（嵌入签名 / 元数据） */
  Digital = "digital",
  /** 混合 */
  Mixed = "mixed",
}

/**
 * 视觉语义 — 对一个视觉对象"是什么 + 怎么呈现"的理解。
 *
 * 只包含 Understanding（理解），不包含 Decision（决策）。
 *   - objectType:    它是什么（Signature / Stamp / Logo ...）
 *   - representation:它怎么呈现（PrintedText / Handwriting / Bitmap ...）
 *   - confidence:    理解置信度（0-1）
 *   - evidence:      支持此理解的事实证据（关键词 / 正则 / pattern / LLM）
 */
export interface VisualSemantic {
  /** 视觉对象类型 */
  objectType: VisualObjectType;
  /** 视觉表现形式 */
  representation: VisualRepresentation;
  /** 理解置信度（0-1） */
  confidence: number;
  /** 支持此理解的事实证据 */
  evidence: string[];
}
