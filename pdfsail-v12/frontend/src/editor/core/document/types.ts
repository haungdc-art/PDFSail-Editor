/**
 * editor/core/document/types.ts — EDITOR-CORE-001
 *
 * Editor Core 的权威可编辑文档模型（规范 §8 / §42）。
 *
 * ── 为什么建在这里 ────────────────────────────────────────────────
 * 规范 §7 / §61：Editor Core 的规范化实现放在既有 src/editor/core/，
 * 不新建 document-model-v3 / editor-core-v2 / 顶层新目录。
 *
 * ── 当前已有的"文档真相"（见 docs/editor-architecture-map.md §2）─────
 *   docBlocks (editor/types.ts)        → UI 块权威
 *   Segment[] (editor-engine/types.ts) → 文字编辑权威
 *   EditableDocument (document-model)  → 导出权威
 *   EditSession / localText / pendingEdit / textItems
 *
 * 本文件的 EditorDocument 目标是成为**唯一**可编辑文档真相（规范 §6）。
 * 现阶段它是纯类型 + 工厂 + 查询 + 序列化，不接任何 UI / 导出，
 * 因此引入它**不改变任何现有行为**（规范 §41 / §42：No functional change）。
 *
 * ── 坐标系（规范 §19）─────────────────────────────────────────────
 * Editor Core 只使用一种交互坐标系：
 *
 *     Page Canvas Space
 *       origin: 页面左上角
 *       x: 向右     y: 向下
 *       unit: CSS/page px
 *
 * PDF pt 与 pdf.js viewport 坐标一律在边界层（PDF Binding / Import Adapter）转换，
 * Editor Core 内部不做二次翻转。
 *
 * ── 文本偏移（规范 §9）────────────────────────────────────────────
 * 本模型只存 string，运行期 offset 一律按 UTF-16 code unit 计数，
 * 以便与浏览器 input / IME / beforeinput 的偏移语义对齐。
 * glyph 索引**不是**本模型的概念，只作为 PDF provenance 存在
 * （见 TextSourceBinding，且仅供 PDF Binding 使用）。
 */

// ─────────────────────────────────────────────────────────────────────
//  文本样式
// ─────────────────────────────────────────────────────────────────────

/** 字体风格 */
export type FontStyle = "normal" | "italic";

/**
 * 运行级文本样式。
 *
 * 与 document-model 的 EditableStyle / editor-engine 的 FontMeta 是**不同层**的东西：
 * 本类型只描述 Editor Core 需要的视觉属性；PDF 侧的字体字节/provenance 由
 * PDF Binding 通过 TextSourceBinding + fontName 解析（规范 §18）。
 */
export interface TextStyle {
  /** CSS font-family（已映射，如 "Helvetica" / "SimSun"） */
  fontFamily: string;
  /** 字号（Page Canvas Space px） */
  fontSize: number;
  /** 字重（400 / 700 …，与 CSS font-weight 同语义） */
  fontWeight: number;
  /** 斜体 */
  fontStyle: FontStyle;
  /** 下划线（V1：bool capability；Core 语义，UI 渲染由 H1-C 接） */
  underline?: boolean;
  /** 删除线（V1：bool capability） */
  strike?: boolean;
  /** CSS 颜色（如 "#000000"） */
  color: string;
  /** 字间距（px，等价 PDF 的 Tz 水平缩放产生的额外间距；0 = 无） */
  letterSpacing: number;
  /** 行高（px）。缺省约定：fontSize * 1.3（见 createTextStyle） */
  lineHeight: number;
  /**
   * PDF 原始字体名（如 "ABCDEF+Helvetica"）。
   * 仅作为 provenance 供 PDF Binding 还原嵌入字体，不参与 Editor Core 排版决策。
   */
  sourceFontName?: string;
}

// ─────────────────────────────────────────────────────────────────────
//  Run / Paragraph
// ─────────────────────────────────────────────────────────────────────

/**
 * 最小文本单元：同一样式的一段连续文本。
 *
 * 规范 §8：编辑器的主要语义单位是 text/run/position，
 * 不要求每个 PDF glyph 都变成持久化的 Editor 对象（PDF glyph 是 provenance/layout 数据）。
 */
export interface TextRun {
  id: string;
  /** UTF-16 字符串；offset 按 UTF-16 code unit 计数（规范 §9） */
  text: string;
  style: TextStyle;
  /**
   * run 级 PDF provenance（EDITOR-CORE-003 新增，规范 §24–§26）。
   *
   * 与 TextBoxObject.source 的区别：
   *   - TextBoxObject.source = 对象级（整块来自哪个 PDF block）
   *   - TextRun.source       = run 级（更精确，支持"部分删除后失效"）
   *
   * 规则：
   *   - 未修改的原文 run     → 保留完整 binding（含 glyph 索引）
   *   - 文本被修改的 run     → 保留 kind/blockId/lineId，但 **清除 glyph 索引**
   *                            （行内字符数已偏移，旧索引会导致导出错误替换，§25）
   *   - Command 新增的文本   → { kind: "generated" }，不带任何 PDF 字段（§24）
   */
  source?: TextSourceBinding;
}

/** 段落对齐（规范 §8） */
export type ParagraphAlignment = "left" | "center" | "right" | "justify";

export interface Paragraph {
  id: string;
  runs: TextRun[];
  alignment: ParagraphAlignment;
}

// ─────────────────────────────────────────────────────────────────────
//  PDF provenance（规范 §26 / §32）
// ─────────────────────────────────────────────────────────────────────

/**
 * 文本来源种类。
 *
 * "generated"（EDITOR-CORE-003 新增，规范 §24）：
 *   由 Editor Command 产生、没有 PDF provenance 的新文本。
 *   必须显式标记，禁止伪造 blockId / lineId / glyphIndex 冒充 PDF 原文。
 */
export type TextSourceKind = "pdf-native" | "ocr" | "user" | "generated";

/**
 * Editor 对象 → PDF 原始结构的绑定信息。
 *
 * 这是**唯一**允许出现 glyph 索引的地方，且仅供 PDF Binding / 导出使用
 * （规范 §10：glyph indexes 只能存在于 PDF binding adapter 中，
 *  绝不作为 Editor Core 的公开选区模型）。
 */
export interface TextSourceBinding {
  kind: TextSourceKind;
  /** document-model EditableBlock.id */
  blockId?: string;
  /** document-model EditableLine.id */
  lineId?: string;
  /**
   * 行在 block 内的序号。
   * OCR 注入文档的 line.id 是 UUID 形式，与 native 的 `pdf_${blockId}_l${idx}` 约定不同，
   * 精确 id 匹配失败时按此序号回退定位（沿用 segmentEditBinding.ts 的既有约定）。
   */
  lineIdx?: number;
  /** glyph 索引区间（含）。provenance only，禁止用于 Editor 选区。 */
  startGlyphIndex?: number;
  /** glyph 索引区间（含）。provenance only，禁止用于 Editor 选区。 */
  endGlyphIndex?: number;
}

// ─────────────────────────────────────────────────────────────────────
//  图片资产（Binding contract，规范 F3B-6.24-B3）
// ─────────────────────────────────────────────────────────────────────

/**
 * 图片资产引用。
 *
 * ImageObject **只**持有 assetRef（字符串引用），**不**直接持有 src / dataURL / bytes。
 * 真实字节由 Binding 层的 ImageAsset 承载，与 PDF XObject / 数据源解耦
 * （规范 F3B-6.24-B3：Image 只持 assetRef，不持 src/dataURL/bytes）。
 */
export type ImageAssetRef = string;

/**
 * 最小图片资产 Binding contract。
 *
 * 仅供 Editor Core → PDF Binding / 导出使用，不参与 Editor Core 排版决策。
 * bytes 为解码后的原始字节（如 dataURL 的 base64 解码结果），mime 为媒体类型。
 */
export interface ImageAsset {
  id: string;
  bytes: Uint8Array;
  mime: string;
}

/**
 * 图片对象：Editor Core 的第二类 EditorObject（规范 F3B-6.24-B3）。
 *
 * 与 TextBoxObject 同层：都是页面上的布局容器（x/y/width/height/rotation/transform）。
 * 唯一区别：内容由 assetRef 指向的 ImageAsset 决定，而非 paragraphs 文本。
 */
export interface ImageObject {
  id: string;
  type: "image";
  /** Page Canvas Space（左上原点，y 向下），单位 px */
  x: number;
  /** Page Canvas Space，单位 px */
  y: number;
  /** 布局约束宽度（px） */
  width: number;
  /** 布局约束高度（px） */
  height: number;
  /** 顺时针旋转角度（度），0 = 无旋转 */
  rotation: number;
  /**
   * F3B-6.18-C.1：PDF 图片矩阵的归一化仿射分量 `[a, b, c, d]`（authoritative）。
   * 缺省 `undefined` = 无旋转/无倾斜。
   * `rotation` 是本字段的兼容便捷派生值，不是第二个权威来源。
   */
  transform?: [number, number, number, number];
  /** 指向 Binding 层 ImageAsset 的字符串引用（不持字节） */
  assetRef: ImageAssetRef;
}

// ─────────────────────────────────────────────────────────────────────
//  TextBox / Object / Page / Document
// ─────────────────────────────────────────────────────────────────────

/**
 * 文本框：真正的布局容器（规范 §16）。
 *
 * x/y/width/height 是**布局约束**，不是"随内容自动扩张"的提示：
 * 输入导致文本变更 → 重排 → 折行 → 新的 caret/选区几何，
 * 而不是 DOM 撑大后等 blur 提交。
 */
export interface TextBoxObject {
  id: string;
  type: "text";
  /** Page Canvas Space（左上原点，y 向下），单位 px */
  x: number;
  /** Page Canvas Space，单位 px */
  y: number;
  /** 布局约束宽度（px） */
  width: number;
  /** 布局约束高度（px） */
  height: number;
  /** 顺时针旋转角度（度），0 = 无旋转 */
  rotation: number;
  /**
   * F3B-6.18-C.1 · PDF 文本矩阵的**归一化仿射分量** `[a, b, c, d]`（**authoritative**）。
   *
   * 来源：PDF text-item matrix（`pdf-transform → [a/f, b/f, c/f, d/f]`，缩放归一为 1、平移归 0）。
   * 可无损表达旋转（`a=cosθ·sx, b=sinθ·sx`）、scale 与 skew；**平移由 `x/y` 承担，故不存 `e/f`**。
   * 与 CSS `matrix(a,b,c,d,0,0)` / pdf.js `transform` 语义一致。
   *
   * 缺省 `undefined` = 无旋转/无倾斜（等价单位矩阵）。
   * `rotation` 是本字段的**兼容便捷派生值**（`atan2(b, a)`），**不是**第二个权威来源。
   */
  transform?: [number, number, number, number];
  paragraphs: Paragraph[];
  /** PDF provenance（可缺省：用户新增对象没有来源） */
  source?: TextSourceBinding;
}

/**
 * Editor 对象联合类型。
 *
 * 规范 F3B-6.24-B3：在文本框之外扩展图片对象，使 Core 能表达用户新增的
 * text / image block（阶段内不改变生产 UI 的 truth）。
 */
export type EditorObject = TextBoxObject | ImageObject;

export interface EditorPage {
  id: string;
  /** 页码（1-based）。规范 §8 的最小模型未列此字段，
   *  但 Import / PDF Binding 必须按页号回写到 PDF，故在此显式声明。 */
  index: number;
  /** 页面宽度（Page Canvas Space px） */
  width: number;
  /** 页面高度（Page Canvas Space px） */
  height: number;
  objects: EditorObject[];
}

/**
 * Editor Core 的唯一可编辑文档真相。
 *
 * version 用于渲染失效判定（规范 §66）：
 * 文本编辑应只失效当前 TextBox / 受影响段落 / 受影响页，而不是整个应用重渲染。
 */
export interface EditorDocument {
  id: string;
  pages: EditorPage[];
  /** 文档版本，每次结构变更递增（由 EDITOR-CORE-003 的命令层维护） */
  version: number;
}
