/**
 * ProcessingDecision — Sprint35 · D3-1 (Definition)
 *
 * Domain Layer v2 的最后一层：Processing Decision Model。
 *
 * 只定义"应该做什么（Intent）"的模型，不包含任何 Resolver / 决策逻辑。
 * Resolver 在 D3-2（processing-decision-resolver.ts）实现。
 *
 * ────────────────────────────────────────────────────────────────
 * 核心纪律：
 *   - DecisionType 表达【意图（Intent）】，不暴露【引擎（Engine）】。
 *     禁止出现 analyze_geometry / analyze_metadata 等引擎名词。
 *     意图 → 具体引擎的映射，由 Pipeline Adapter（D4）负责。
 *   - Decision 是 Immutable / Stateless / Pure：
 *     一旦产生永不改变，不持有生命周期状态。
 *     运行状态（pending/running/done/failed）迁移到 Execution Plan（D3-3）。
 *   - Priority 用【语义枚举】DecisionPriority，数值映射收敛到 Pipeline Adapter。
 *   - 本文件【不 import】任何 Geometry / OCR / Renderer / Pipeline / Runtime。
 */

/**
 * 决策意图（DecisionType） — 表达"应该做什么"，与具体引擎解耦。
 *
 * 每个意图可对应多个引擎实现（例如 analyze_ocr 可有 GLM / Azure / Google / Tesseract），
 * 但 Decision 层不关心具体引擎，由 Pipeline Adapter 路由。
 */
export type DecisionType =
  /** 需要视觉结构分析（旋转 / 倾斜 / 透视 / 布局 —— 具体引擎由 Adapter 决定） */
  | "analyze_visual"
  /** 需要文本识别 */
  | "analyze_ocr"
  /** 需要提取结构化信息（字体 / 嵌入元数据 / 矢量属性 —— 具体引擎由 Adapter 决定） */
  | "extract_structure"
  /** 需要解码（QR / 条形码） */
  | "decode"
  /** 忽略（无需处理，如水印 / 纯装饰） */
  | "ignore"
  /** 复合对象，需拆解或组合处理 */
  | "composite";

/**
 * 语义优先级（DecisionPriority） — 可维护，避免散落魔法数字。
 *
 * 数值映射（critical=100 / high=80 / normal=60 / low=40 / none=0）
 * 由 Pipeline Adapter 负责，Decision 层只用语义枚举。
 */
export type DecisionPriority = "critical" | "high" | "normal" | "low" | "none";

/**
 * 单条处理决策。
 *
 * Immutable：一旦产生，字段不改变。
 * Stateless：不持有生命周期状态。
 * Pure：纯数据，无逻辑。
 */
export interface ProcessingDecision {
  /** 稳定唯一 ID（供 Execution Plan / 日志 / 调试引用） */
  id: string;
  /** 决策意图（引擎无关） */
  type: DecisionType;
  /** 语义优先级（数值映射在 Pipeline Adapter） */
  priority: DecisionPriority;
  /** 可选：补充解释（供审计 / 调试） */
  reason?: string;
}

/**
 * 处理决策列表 — 支持一个对象同时有多个决策。
 *
 * 例如 QRCode 可同时：decode（解析）+ analyze_ocr（识别旁白文字）。
 *
 * decisions 允许为空数组 `[]`，表示"无需任何处理"。
 */
export interface ProcessingDecisionList {
  decisions: ProcessingDecision[];
}
