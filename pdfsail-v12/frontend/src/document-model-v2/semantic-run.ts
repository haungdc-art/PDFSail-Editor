/**
 * semantic-run.ts — Semantic Document Model V2（Run 是第一公民）
 *
 * Sprint-60 Task-001：Semantic Run Model
 *
 * 目的：把 OCR Block 升级为结构化层级，Renderer 不再直接消费 OCR Block。
 *
 * 层级：
 *   DocumentV2
 *     └─ PageV2
 *          └─ ParagraphV2
 *               └─ LineV2
 *                    └─ RunV2        ← 第一公民（Run）
 *                         └─ RunGlyph
 *
 * Architecture（ADR-001/002/003）：
 *   OCR → SemanticRunBuilder → RunV2 → Renderer
 *   （禁止 OCR → Renderer）
 *
 * 【Merge Gate 1】Immutable（ADR-003）：
 *   SemanticDocumentV2 在 Builder 完成后不可变。任何修改必须重新 Builder。
 *   因此所有数组用 ReadonlyArray，所有对象字段用 Readonly。
 *
 * 【Merge Gate 2】Version：
 *   schemaVersion 标识模型版本（当前 1）。未来 RunV3 / ExportV1 / EditorV2 可共存。
 *
 * 【Merge Gate 3】Identity 引用：
 *   Run 内禁止保存 OCR 对象引用，只保存稳定 ID（backgroundRegionId / sourceId），
 *   与 OCR 生命周期解耦。Builder 是唯一拥有对象引用权的地方。
 *
 * 坐标系约定：visualBounds 使用 CSS 显示坐标（与 EditableDocument 一致）。
 */

import type { BBox, TextSource, TransformMatrix } from "../document-model/types";

/** 语义文档 schema 版本（当前 v1） */
export const SEMANTIC_DOCUMENT_SCHEMA_VERSION = 1;

/**
 * RunMetrics — 排版度量（Typography Domain，Sprint-61）。
 *
 * 字段归属（PM 纪律：每个字段必须回答归属）：
 *   全部属于 **Typography**，进入 Run.metrics。
 *   Renderer 不得用 measureText/bbox.height 自行推导，只消费此处 metrics。
 *
 * 第一版（Happy Path）：Builder 用估算填充（fontSize ≈ bbox.height 等）。
 * Sprint-62 Font Metric Engine / 后续可提升精度，但字段结构固定。
 */
export interface RunMetrics {
  /** 字体大小（Typography） */
  readonly fontSize: number;
  /** 行高（Typography） */
  readonly lineHeight: number;
  /** baseline 相对行顶的偏移（Typography） */
  readonly baseline: number;
  /** 上伸高度（Typography） */
  readonly ascent: number;
  /** 下伸深度（Typography） */
  readonly descent: number;
  /** 平均字符推进宽度（Typography） */
  readonly advanceWidth: number;
  /** 字间距（Typography） */
  readonly letterSpacing: number;
}

/**
 * VisualCoverage — 视觉覆盖（Coverage Domain，Sprint-62）。
 *
 * 关键概念（PM）：BBox 是 Geometry，**Coverage 才是 Adobe**。
 * visualCoverage 是 Document Reconstruction 的输出，不是 Renderer。
 * 以后 Patch/Mask/Renderer/Export 全部消费它，而不是自己算。
 *
 * 字段归属（PM 纪律）：
 *   maskBounds     → Geometry（mask 白色矩形，盖原文）
 *   patchBounds    → Geometry（背景 patch 范围）
 *   coverageBounds → Geometry（最终覆盖范围，含扩展，盖住原文衬线/倾斜边缘）
 *   confidence     → Semantic（覆盖置信度 0~1）
 */
export interface VisualCoverage {
  /** mask 白色矩形范围（Geometry） */
  readonly maskBounds: BBox;
  /** 背景 patch 范围（Geometry） */
  readonly patchBounds: BBox;
  /** 最终覆盖范围（Geometry，含扩展，解决 FID-010 覆盖不足） */
  readonly coverageBounds: BBox;
  /** 覆盖置信度 0~1（Semantic） */
  readonly confidence: number;
}

/** 语义文档（V2，Immutable） */
export interface SemanticDocumentV2 {
  /** schema 版本（Merge Gate 2） */
  schemaVersion: number;
  id: string;
  pages: ReadonlyArray<SemanticPageV2>;
}

/** 语义页面（Immutable） */
export interface SemanticPageV2 {
  index: number;
  width: number;
  height: number;
  paragraphs: ReadonlyArray<SemanticParagraphV2>;
}

/** 语义段落（Immutable） */
export interface SemanticParagraphV2 {
  id: string;
  lines: ReadonlyArray<SemanticLineV2>;
}

/** 语义行（Immutable） */
export interface SemanticLineV2 {
  id: string;
  runs: ReadonlyArray<SemanticRunV2>;
}

/**
 * SemanticRunV2 — 第一公民（Immutable，Readonly）。
 *
 * 当前（Sprint-60 Task-001）仅实现：
 *   id / text / glyphs / rotation / visualBounds / metrics({}) / style({}) /
 *   backgroundRegionId / sourceId / source / schemaVersion
 *
 * semanticBounds 预留（Sprint-62 VisualBounds & Coverage Engine 细化）。
 */
export interface SemanticRunV2 {
  /** schema 版本（Merge Gate 2） */
  schemaVersion: number;
  id: string;
  /** 运行文本（由 glyphs 拼接，或源直接提供） */
  readonly text: string;
  /** 字符级 glyph（保留 transform / bbox，ReadonlyArray） */
  readonly glyphs: ReadonlyArray<RunGlyph>;
  /** 视觉覆盖范围（Rule 3: One Geometry，CSS 坐标） */
  readonly visualBounds: BBox;
  /** 视觉覆盖（Coverage Domain，Sprint-62 Visual Coverage Engine） */
  readonly visualCoverage: Readonly<VisualCoverage>;
  /** CSS 旋转角度（度，顺时针为正，0 = 水平） */
  readonly rotation: number;
  /** 排版度量（Typography Domain，Sprint-61 Semantic Metrics Engine） */
  readonly metrics: Readonly<RunMetrics>;
  /** 样式 */
  readonly style: Readonly<Record<string, unknown>>;
  /**
   * 背景区域引用（稳定 ID，Merge Gate 3）。
   * 只保存 Identity，不保存 OCR 对象引用。
   */
  readonly backgroundRegionId?: string;
  /**
   * 来源 ID（稳定 ID，Merge Gate 3）。
   * 例如 OCR block id / pdf textItem id。Run 与 OCR 生命周期解耦。
   */
  readonly sourceId?: string;
  /** 来源标记 */
  readonly source: TextSource;
}

/** Run 内字符（Immutable） */
export interface RunGlyph {
  /** 字符 */
  readonly char: string;
  /** 原始字符（OCR/PDF 提取，用于差异检测） */
  readonly originalChar?: string;
  /** 字符 bbox（CSS 坐标） */
  readonly bbox: BBox;
  /** 字符变换矩阵（无旋转 = identity） */
  readonly transform?: TransformMatrix;
}
