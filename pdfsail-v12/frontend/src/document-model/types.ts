/**
 * EditableDocument — PDF Reconstruction Engine V1 核心数据模型
 *
 * 设计哲学（Sprint 1 要求）：
 *   EditableDocument 不是 "TextBlock V2"，而是 "Document Object Model"。
 *
 *   - TextBlock 是「显示对象」（renderer 关心 x/y/w/h/fontSize）
 *   - EditableDocument 是「文档理解对象」（保留原文、来源、结构层级）
 *
 * 未来 AI Agent 能力（如「把合同里的付款日期改成 2027」）依赖此模型：
 *   用户意图 → EditableDocument → 定位 Date Glyph → 修改 → Renderer
 *
 * 层级结构：
 *   EditableDocument
 *     └─ EditablePage
 *          └─ EditableBlock       （text | image | table）
 *               └─ EditableLine
 *                    └─ EditableGlyph   （字符级粒度，保留 originalChar）
 *
 * 来源统一（source 字段）：
 *   - PDF 原生文本 (pdf.js TextContent)  → "pdf_native"
 *   - OCR 识别文本 (GLM-OCR)              → "ocr"
 *   - 混合（PDF 有文本层 + OCR 补充）      → "hybrid"
 *
 * 坐标系约定：
 *   所有 bbox 使用 CSS 显示坐标（canvas px × cssScale），与编辑器 docBlocks 一致。
 *   转换由 Adapter 层负责（OCR canvas px × cssScale；PDF pt → CSS px）。
 */

import type { TypographyMetrics } from "./typography";

// ────────────────────────────────────────────────────────────────
// 基础类型
// ────────────────────────────────────────────────────────────────

/** 几何边界框（CSS 显示坐标） */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 文本来源标记 */
export type TextSource = "pdf_native" | "ocr" | "hybrid";

/** Block 类型 */
export type BlockType = "text" | "image" | "table";

/**
 * LayoutRegionType — OCR 区域语义/布局类型
 *
 * 根据区域类型选择不同的重建策略：
 *   - paragraph：正文段落，使用 availableLineWidth + word wrapping + measureText 重新换行
 *   - signature：签名区域，禁止 reflow，保持 bbox / transform / rotation
 *   - table：表格区域，禁止 reflow，保持单元格结构
 *   - stamp：印章区域，禁止 reflow，保持位置
 *   - footer：页脚区域，禁止 reflow，保持位置
 */
export type LayoutRegionType =
  | "paragraph"
  | "signature"
  | "table"
  | "stamp"
  | "footer";

/**
 * LayoutMode — 布局模式（Sprint 3.5 Task 1）
 *
 * PRESERVE：优先保持原 PDF 布局（Adobe 风格文本替换）
 *   - 使用 OCR bbox / PDF native glyph 位置
 *   - 保持原 line 数量
 *   - 保持 baseline
 *   - 保持 fontSize
 *   - 禁止 reflow
 *
 * RECONSTRUCT：重建布局（measureText 换行）
 *   - 用 measureText 精确测量字符宽度
 *   - 超宽换行
 *   - 适合新增文本 / 大幅修改场景
 */
export type LayoutMode = "preserve" | "reconstruct";

// ────────────────────────────────────────────────────────────────
// 样式
// ────────────────────────────────────────────────────────────────

/**
 * EditableStyle — 排版样式（Sprint 2 完整版）
 *
 * 支持：fontFamily / fontSize / fontWeight / fontStyle / color / lineHeight / letterSpacing / transform
 *
 * 样式存储策略（Task 4 要求）：
 *   EditableDocument.styles: EditableStyle[]  ← 文档级去重数组
 *   EditableGlyph.styleRef: number            ← 指向 styles 数组索引
 *   不每个 glyph 复制 style，节省内存 + 便于批量修改。
 *
 * 来源：
 *   - PDF 原生：从 pdf.js TextContent 提取（fontName/transform/fontSize）+ graphics state（color）
 *   - OCR：推断（同区域 PDF style → 邻近文字 → 页面统计 → fallback）
 */
export interface EditableStyle {
  /** CSS font-family（已映射，如 "Helvetica, Arial, sans-serif"） */
  fontFamily?: string;
  /** CSS font-size（px） */
  fontSize?: number;
  /** CSS font-weight（"normal" | "bold" | 数字 400/700） */
  fontWeight?: string | number;
  /** CSS font-style（"normal" | "italic" | "oblique"） */
  fontStyle?: "normal" | "italic" | "oblique";
  /** CSS color（"#RRGGBB"） */
  color?: string;
  /** 行高（CSS px 或无单位倍数；导出时按需转换） */
  lineHeight?: number;
  /** 字间距（CSS px） */
  letterSpacing?: number;
  /** 文本变换矩阵 [a, b, c, d, e, f]（PDF 原生 transform，用于精确还原倾斜/缩放） */
  transform?: [number, number, number, number, number, number];
  /** 对齐方式 */
  alignment?: "left" | "center" | "right" | "justify";
  // ──────────────────────────────────────────────────────────────
  // M7.7-009B: PDF Font Identity（字体身份，用于 overlay 渲染和 export 字体一致性）
  // ──────────────────────────────────────────────────────────────
  /**
   * PDF.js 内部字体名（即 @font-face font-family 名，如 "g_d0_f1"）。
   * 用于 overlay drawText 直接引用 PDF.js 已加载的字体，替代 CSS font-family 猜测。
   */
  pdfjsFontFamily?: string;
  /**
   * PDF 原始字体名（含 subset 前缀，如 "ABCDEF+Helvetica"）。
   * 用于 export 阶段字体映射（Standard 14 / embedded font 判断）。
   */
  pdfFontName?: string;
  /**
   * 稳定字体标识符（跨页面/跨文档的同一字体使用同一 fontId）。
   * 基于 baseFont + subtype + encoding 等特征生成。
   */
  fontId?: string;
  /**
   * 字体是否已加载完成（@font-face 已注入并可用）。
   * 用于 overlay 渲染前确保字体可用，避免 fallback 字体闪烁。
   */
  fontLoaded?: boolean;
}

// ────────────────────────────────────────────────────────────────
// GlyphMetrics（M7.5: PDF 原始字符度量）
// ────────────────────────────────────────────────────────────────

/**
 * GlyphMetrics — PDF 原始字符级度量（M7.5-IMPLEMENT-001）
 *
 * 保存 pdf-native-adapter 到 EditableGlyph 之间不丢失的 PDF 原始指标。
 * 仅用于编辑定位精度，不涉及字体嵌入/导出/Renderer。
 *
 * 设计约束：
 *   - 不属于 Font Engine（不保存 font bytes / cmap / raw PDF object ref）
 *   - 不属于 Renderer（不影响渲染路径）
 *   - 只保留编辑需要的原始指标
 */
export interface GlyphMetrics {
  /** PDF 原始 advance width（CSS px，字符前进宽度，决定下一字符 x 偏移） */
  advanceWidth: number;
  /** PDF text state: char spacing（pt，可选） */
  charSpacing?: number;
  /** PDF text state: word spacing（pt，可选） */
  wordSpacing?: number;
  /** PDF text state: horizontal scale（可选，如 1.0 = 100%） */
  horizontalScale?: number;
  /** Vertical metrics: ascent（CSS px，可选） */
  ascent?: number;
  /** Vertical metrics: descent（CSS px，可选） */
  descent?: number;
  /** PDF 字符码（char code，用于字体 Widths 查表；可选） */
  pdfCharCode?: number;
  /** Unicode 字符（从 ToUnicode 解析；可选） */
  unicode?: string;
  /** PDF 字体资源 key（如 "F1"；可选） */
  fontRef?: string;
  /** PDF 字体名（BaseFont，如 "ABCDEF+Helvetica"；可选） */
  fontName?: string;
  /** 字号（PDF pt；可选） */
  fontSize?: number;
  /** PDF Font Matrix [a,b,c,d,e,f]（字体内缩放；可选） */
  fontMatrix?: [number, number, number, number, number, number];
  /** PDF Text Matrix [a,b,c,d,e,f]（文本定位矩阵；可选） */
  textMatrix?: [number, number, number, number, number, number];
  /** M7.5-003：PDF 原始综合变换矩阵（文案 textMatrix×fontMatrix×viewport，PDF pt 域，
   *  含 fontSize 缩放与平移，未做 CSS 归一化）。用于「原始 matrix 可恢复」。可选。 */
  pdfTransform?: TransformMatrix;
  /** M7.5-003：字体资源身份（font identity），支持「编辑后视觉一致」校验。可选。 */
  fontIdentity?: GlyphFontIdentity;
}

/**
 * M7.5-003 · GlyphFontIdentity — PDF 字体资源身份
 *
 * 保存足够还原「原始 PDF 字体」的资源信息，使渲染不再依赖 CSS substitute。
 * 均来自 PDF Font Dictionary（pdf-font-metrics.ts 解析）。
 */
export interface GlyphFontIdentity {
  /** PDF 字体资源 key（页面 /Font 下名字，如 "F1"） */
  fontRef?: string;
  /** PDF 字体名（含 subset 前缀，如 "ABCDEF+Helvetica"） */
  fontName?: string;
  /** BaseFont（去 subset 前缀，如 "Helvetica"） */
  baseFont?: string;
  /** 字体 subtype（"Type1" | "TrueType" | "Type0" | "CIDFontType0" | ...） */
  subtype?: string;
  /** 是否内嵌字体（PDF 内嵌 embedded stream） */
  embedded?: boolean;
  /** 编码（"WinAnsiEncoding" | "MacRomanEncoding" | "/Font" 中的编码名） */
  encoding?: string;
  /** 字体字典对象号（来自原 PDF object graph，便于诊断/提升资源） */
  objectNumber?: number;
  /** unicode(字符) → PDF 原始 charCode 反查表（M7.8-035-FIX：导出时直接发 raw CID，不经 Unicode→CID） */
  unicodeToCharCode?: Map<string, number>;
}

// ────────────────────────────────────────────────────────────────
// Glyph（字符级）
// ────────────────────────────────────────────────────────────────

/**
 * Transform Matrix — 2D 仿射变换矩阵 [a, b, c, d, e, f]
 *
 * 语义（与 CSS transform: matrix(a,b,c,d,e,f) 一致）：
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 *
 * 存储 CSS 归一化形式：
 *   - 缩放归一化为 1（fontSize 由 EditableStyle.fontSize 控制，不在此重复缩放）
 *   - 平移归零为 0（位置由 bbox.x / bbox.y 控制，不在此重复平移）
 *   - 仅保留旋转/倾斜分量
 *
 * 无旋转时 = [1, 0, 0, 1, 0, 0]（单位矩阵）
 *
 * 转换关系：
 *   PDF transform [a, b, c, d, e, f]（fontSize 缩放 + 位置 + 旋转）
 *     → 归一化：fontSize = sqrt(a² + b²)，a'=a/fs, b'=b/fs, c'=c/fs, d'=d/fs
 *     → CSS 归一化 transform = [a', b', c', d', 0, 0]
 *     （PDF Y-up 和 CSS Y-down 的旋转方向一致，无需取反 b/c）
 */
export type TransformMatrix = [number, number, number, number, number, number];

/** 单位 transform（无旋转无缩放） */
export const IDENTITY_TRANSFORM: TransformMatrix = [1, 0, 0, 1, 0, 0];

/**
 * EditableGlyph — 字符级文档对象
 *
 * 保留 originalChar，支持：
 *   - 差异检测（isModified）
 *   - 增量编辑（只改一个字，不需要重写整段）
 *   - AI Agent 精确定位（「把日期 2026 改成 2027」→ 找到对应 glyph 修改）
 *
 * Sprint 1：bbox 可为估算值（按字符宽度均分），Sprint 3 Layout Engine 会精确化。
 * Sprint 3.5：新增 originalBBox，Preserve 模式下保持原始位置；
 *             bbox 可能因编辑改变，originalBBox 用于回退和 Diff 对比。
 * Sprint 4：新增 transform，保留 PDF 原始旋转/倾斜角度（签名区域等）。
 *           OCR glyph 默认单位矩阵 [1,0,0,1,0,0]。
 *           PDF native glyph 从 pdf.js transform 转换（归一化）。
 */
export interface EditableGlyph {
  /** 当前字符（可能被用户修改） */
  char: string;
  /** 原始字符（OCR/PDF 提取时的字符，用于差异检测和回退） */
  originalChar?: string;
  /** 字符 bbox（CSS 显示坐标，当前/编辑后位置） */
  bbox: BBox;
  /** 原始 bbox（CSS 显示坐标，Preserve 模式保持的位置；用于 Diff 对比和回退） */
  originalBBox?: BBox;
  /** 指向 style 索引（EditableBlock.styles 数组），避免每 glyph 重复存 style */
  styleRef: number;
  /** 是否被修改过（char !== originalChar） */
  modified: boolean;
  /**
   * CSS 归一化 transform matrix [a, b, c, d, e, f]。
   * 仅保留旋转/倾斜，缩放归一化为 1（fontSize 由 style 控制），平移归零（位置由 bbox 控制）。
   * 无旋转时 = [1, 0, 0, 1, 0, 0]。
   * GlyphRenderer 渲染为 CSS `transform: matrix(a,b,c,d,e,f)` + `transform-origin: 0 0`。
   */
  transform?: TransformMatrix;
  /**
   * 字符级基线（Original Fact，可选，Milestone-1 Baseline Fidelity）。
   *
   * 行级 EditableLine.baseline 已足够表达常规文本的基线（PDF 一行共享同一 baseline）。
   * 此字段仅当需要 per-glyph 精度（如旋转/倾斜签名块内每字符基线不同）时使用。
   * 值为 CSS 显示坐标下的真实基线（非 box-top）。
   */
  baseline?: number;
  /**
   * 字符级 Typography Metrics（Typography Domain，Sprint-1 Milestone-3）。
   *
   * 与 baseline 两阶段共存：baseline 保留（Original Fact 旧通道），
   * typography.baseline 为新的统一 Typography 事实入口（未来基线收敛于此）。
   * 仅当需要 per-glyph 排版精度时填充。
   */
  typography?: TypographyMetrics;
  /**
   * 字符级 PDF 原始度量（M7.5-IMPLEMENT-001）。
   *
   * 保存 PDF 原始 advanceWidth 等指标，用于编辑态精确字符定位。
   * 仅由 pdf-native-adapter 在提取时填充，不影响 Renderer/Export/Undo。
   * 新插入的字符（用户输入）无此字段，回退到 canvas measureText。
   */
  metrics?: GlyphMetrics;
  /**
   * M7.5-005E-C2B-2C-2 · Native Replacement 编辑态（可选）。
   *
   * 让 Export 在创建 overlay command 前实时知道该 glyph 是否已具备 native replacement 路径：
   *   - ready=true  → 该 glyph 已 native 替换（原 PDF content stream 承担渲染），
   *                    Export 不创建该区间的 overlay command（白色 mask + 重新绘制文字）。
   *   - ready=false / 字段缺省 → 走既有 overlay fallback。
   *
   * 由 Editor / Mutation 按需在「替换成功（checksum pass + round-trip 通过）」后写入，
   * 本阶段仅消费（derive routing → 短路 overlay），不参与 Undo / Selection / Layout / Renderer。
   */
  nativeReplacementState?: {
    /** 绑定的 native replacement 标识（line/block 内共享同一 bindingId 认定为整行 native-ready） */
    bindingId?: string;
    /** 是否 native replacement 就绪（字体可抽取 / binding 置信 / checksum pass） */
    ready: boolean;
    /**
     * 原生替换的目标算子整文本（单一事实源，供 Export native rewrite 精确匹配）。
     * glyph.originalChar 对「长度变化」的替换不可靠（见 glyph-mapping），故由 binding 携带。
     */
    originalText?: string;
    /** 编辑后的替换文本（单一事实源，native rewrite 的写入目标）。 */
    replacementText?: string;
    };
    /**
     * M7.8-035-FIX · Native Font Provenance（字体溯源，来自原 PDF object graph）。
     *
     * 与 metrics.fontIdentity 同源，但置于 glyph 顶层，供 Export native replay
     * （tryNativeLineRebuild / RAW-CID Replay）直接读取，避免回落到 Helvetica fallback。
     */
    fontIdentity?: GlyphFontIdentity;
    /** PDF 原始字符码（raw Type3/CID char code；M7.8-035-FIX：导出直接发 Tj，不经 Unicode→CID）。 */
    pdfCharCode?: number;
    /**
     * M7.8-036-FIX-002 · Original PDF Operator Provenance。
     *
     * 导入期即把本 glyph 钉死到原 PDF 的某个 showText 算子及其内部第几个 charCode：
     *   - operatorId       → `TextShowRecord.operatorId`（`${streamObjRef}#${sequentia}`），
     *                        全局唯一，直接定位原算子字节区间。
     *   - operatorCharIndex → 该算子在 `charCodes` 序列中的下标（0-based）。
     *
     * 这是导出删除原文字的唯一合法依据。导出时只读这两个字段，不再用 charCode 序列去猜某个算子。
     * 若无法在导入期权威建立（序列不匹配 / 含 unknown 算子 / 字体资源缺失），**两者留空**
     * （= UNKNOWN provenance）→ 导出时**绝不删除该 glyph 所在算子**，宁可保留原文也不误删。
     */
    operatorId?: string;
    operatorCharIndex?: number;
    }

// ────────────────────────────────────────────────────────────────
// Line（行级）
// ────────────────────────────────────────────────────────────────

/**
 * EditableLine — 行级文档对象
 *
 * 一行文本由若干 glyph 组成。
 * Sprint 1：OCR 段落按换行符 / 估算行数拆分；PDF 原生按 pdf.js Y 坐标分行。
 */
export type RenderSource = "vector" | "image" | "image-ocr";

export interface EditableLine {
  id: string;
  /**
   * 渲染源类型（M7.7-009A）。
   *
   *   - "vector"     → 该行是 PDF 原生矢量文字（有 text operator，无图片覆盖），
   *                    编辑后继续用 drawText（现有 drawText 渲染路径）。
   *   - "image"      → 该行位于图片区域内且无对应文本算子（纯扫描图，无 OCR 层），
   *                    编辑后走 PNG overlay（canvas 截图区域 → 修改 → 图片覆盖）。
   *   - "image-ocr"  → 该行位于图片区域内且存在对应文本算子（扫描图 + OCR 层），
   *                    编辑后走 PNG overlay，但禁止使用 drawText()，
   *                    因为 OCR 层的字体/粗细/anti-alias 均为图像推测，
   *                    drawText 会引入视觉差异。
   *
   * 检测逻辑（render-source-detector.ts）：
   *   Signal A: PDF operator 中存在 paintImageXObject 且覆盖该行。
   *   Signal B: 该行 bbox 对应的 text operator 存在且覆盖该行。
   *   三路判定：
   *     !A                    → "vector"
   *     A && !B               → "image"（纯扫描图，无 OCR 层）
   *     A &&  B               → "image-ocr"（扫描图 + OCR 层）
   *
   * 缺省 "vector"（向后兼容：现有文档模型无此字段时视为矢量文字）。
   */
  source: RenderSource;
  /** 行 bbox（CSS 显示坐标，View Fact / Derived） */
  bbox: BBox;
  /**
   * 编辑时被替换子串的「原始文本 bbox」列表（CSS 显示坐标，由 mutateLineText 在编辑时捕获）。
   * 导出兜底 mask 用它覆盖旧文本：当一行被编辑、但原 PDF 文本算子既无法被剥离
   * （provenance 缺失）也无法被 native replay 原位替换（字体子集缺口）时，旧文字仍残留在
   * content stream 中。此时逐字形 mask 只覆盖「新文本」位置，可能漏掉旧文本（重影）。
   * 用本字段把 mask 范围扩到被替换子串的原始位置，确保旧文本被盖住
   * （垂直仍被下一行钳制，不会擦掉上下表格线；水平只覆盖被替换的列内区域，不会误擦列间竖线）。
   *
   * 为数组而非单值：表格多列编辑会按 segment 多次调用 mutateLineText，每次编辑一段子串；
   * 若用单值会被后段覆盖，导致前段被替换子串的原始位置丢失、旧文字残留。改为累加各段
   * 被替换子串的原始 bbox，导出时逐段生成白色 mask，既盖住所有旧文字、又保留段间表格线。
   */
  editedOriginalBounds?: BBox[];
  /**
   * 行基线（Original Fact，Milestone-1 Baseline Fidelity）。
   *
   * 来自 PDF.js textItem.transform[5]（RawGlyph.pdfY），经 CoordinateMapper 坐标转换后
   * 作为 Document Model 的持久化 Original Fact 保存。
   * 是真实基线（baseline），不是 box-top（bbox.y）。
   * Consumer（Renderer / Export）可用它精确对齐，不依赖经验偏移。
   */
  baseline?: number;
  /**
   * 行级 Typography Metrics（Typography Domain，Sprint-1 Milestone-3）。
   *
   * 与 baseline 两阶段共存：baseline 保留（Original Fact 旧通道），
   * typography.baseline 为新的统一 Typography 事实入口（未来基线收敛于此）。
   * 由 Adapter/Producer 按统一事实源填充。
   */
  typography?: TypographyMetrics;
  /** 行内 glyph 列表 */
  glyphs: EditableGlyph[];
  /** 行级样式（继承自 block，可被 glyph 覆盖） */
  style: EditableStyle;
  /**
   * 行级编辑标记（M7.8-040R-3 / Bug B）：某 Segment 成功 mutation 后由
   * applySegmentEditsToDocument 置 true。
   *
   * 用途：导出侧用 line.edited 判定「整行需要 export」。否则当编辑是「删除 / 无变化」
   * （残留 glyph 未被标 modified）时，glyph.modified 全 false → 整行不触发 overlay、
   * strip 也收不到 operatorId → 编辑在复制层消失（重影修复反而丢失编辑）。
   *
   * 注意：此标记只供导出判定，**不**用于编辑器内 mask（编辑器只看 glyph.modified），
   * 因此不会触发 M7.7-034 的「二次编辑双重 mask」问题。
   */
  edited?: boolean;
  /**
   * M7.8-042-ORPHAN：编辑使行变短时（如 "100%"→"99%"）被删除的原 glyph 的 operatorId 列表。
   *
   * 根因：range mutation 逐位对齐（新[i] ← 原[start+i]），replacement 比原选区短时，
   * 尾部原 glyph（如第三个 "0" 后的 "%"）被丢弃 —— 其 operatorId 随 glyph 一起消失，
   * export 的 stripReplacedTextOperators 按 glyph.operatorId 收集不到该算子 →
   * 原 "%" 算子残留在 content stream → 导出重影（实测 x=412.4 处孤立 "%"）。
   *
   * 由 mapNewTextToOriginalGlyphs 收集（GlyphMappingResult.droppedOperatorIds）、
   * mutateLineText 累加合并到行、导出剥离时并入该行的剥离集合。
   * 为数组：同一行多次变短编辑会各产生一批孤儿算子，需累加去重。
   */
  droppedOperatorIds?: string[];
}

// ────────────────────────────────────────────────────────────────
// Transform（几何变换）
// ────────────────────────────────────────────────────────────────

/**
 * EditableTransform — 块级几何变换模型（Sprint 33.3.5）。
 *
 * 从 Layout Tree 的 LayoutTransform 传递到 EditableDocument 的桥梁，
 * 让 Renderer 可以直接从 EditableBlock 读取旋转变换而无需回溯 Layout Tree。
 *
 * 坐标约定：与 CSS 一致 — rotation 为 CSS 旋转角度（顺时针为正）。
 */
export interface EditableTransform {
  /** CSS 旋转角度（度，顺时针为正） */
  rotation: number;
  /** X 轴缩放（1.0 = 无缩放） */
  scaleX: number;
  /** Y 轴缩放（1.0 = 无缩放） */
  scaleY: number;
  /**
   * 变换原点（CSS transform-origin 值）。
   *
   * 签名区域使用 "left top"（父容器坐标系原点），
   * 子块使用 local coordinate → 父容器 x=0, y=0。
   *
   * 默认值：center center（兼容旧行为）
   */
  origin?: string;
}

/** 恒等变换（无旋转、无缩放） */
export const IDENTITY_EDITABLE_TRANSFORM: EditableTransform = {
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  origin: "left top",
};

// ────────────────────────────────────────────────────────────────
// Signature Region（签名区域独立数据模型 — Sprint 33.5.6）
// ────────────────────────────────────────────────────────────────

/**
 * SignatureChild — 签名区域内的子元素。
 *
 * 关键设计：不存绝对坐标（child.x / child.y），
 * 而是存相对于 SignatureRegion 左上角的偏移量（offsetX / offsetY）。
 *
 * 坐标空间：PDF 原始坐标（72dpi PDF point），不经过 CSS px 转换。
 */
export interface SignatureChild {
  /** 显示文本 */
  text: string;
  /** 相对父容器左上的 X 偏移（PDF point） */
  offsetX: number;
  /** 相对父容器左上的 Y 偏移（PDF point） */
  offsetY: number;
  /** 字体信息 */
  font: {
    family: string;
    size: number;    // PDF point
  };
  /** 原文基线 Y（PDF point），用于导出时的精确定位 */
  baseline?: number;
  /** 关联的原始 EditableBlock ID（用于 debug 追溯） */
  sourceBlockId?: string;
}

/**
 * SignatureRenderRegion — 签名区域渲染模型（Sprint 33.5.6）。
 *
 * 这是一个独立渲染单元：
 *   - 子元素使用 local coordinate（offsetX / offsetY）
 *   - rotation 只存在于容器层，由 renderer 统一应用
 *   - 不经过普通 TextRenderer 渲染路径
 *
 * 在 EditableDocument 中，SignatureRenderRegion 的 children
 * 对应的原始 EditableBlock 仍然存在于页面 blocks 数组中
 * （用于 editable 功能），但渲染时必须走签名专用路径。
 *
 * 命名区别于 signature-region-merger.ts 中的 SignatureRegion（构建期合并模型）。
 */
export interface SignatureRenderRegion {
  id: string;
  type: "signature";
  /** 包围盒（PDF point） */
  bbox: BBox;
  /** 旋转角度（度，顺时针为正） */
  rotation: number;
  /** 坐标空间标记 */
  coordinateSpace: "pdf";
  /** 子文本元素（local coordinate） */
  children: SignatureChild[];
  /** 关联的 EditableBlock ID 列表（用于追溯） */
  sourceBlockIds: string[];
  /** 页面索引 */
  pageIndex: number;
}

// ────────────────────────────────────────────────────────────────
// Block（块级）
// ────────────────────────────────────────────────────────────────

/**
 * EditableBlock — 块级文档对象
 *
 * 一个 block 对应文档中的一个语义区域（段落、图片、表格）。
 *
 * originalBounds：原文遮盖区域（source layer）。
 *   - OCR 替换模式：用 originalBounds 画白色矩形覆盖原文，
 *     用 bbox 渲染新文字（render layer）。
 *   - 与现有 TextBlock.originalBounds 语义一致，保证适配器零摩擦。
 */
export interface EditableBlock {
  id: string;
  /** Block 类型 */
  type: BlockType;
  /** 当前 bbox（CSS 显示坐标，渲染区域） */
  bbox: BBox;
  /** 来源标记 */
  source: TextSource;
  /** 原文 bbox（CSS 显示坐标，遮盖区域；OCR 段落 = 段落整体 bbox） */
  originalBounds?: BBox;
  /** 行列表 */
  lines: EditableLine[];
  /** 图片 src（type="image" 时） */
  src?: string;
  /** 布局模式（Sprint 3.5）：preserve 保持原布局，reconstruct 重建布局 */
  layoutMode?: LayoutMode;
  /**
   * 区域语义/布局类型（Sprint 4）。
   * 根据 regionType 选择不同的重建策略：
   *   - paragraph → reconstruct（word wrapping）
   *   - signature/stamp/table/footer → preserve（禁止 reflow）
   */
  regionType?: LayoutRegionType;
  /**
   * Sprint 33.3.5: 块级几何变换。
   * 签名区域的旋转/缩放从 Layout Tree 传递到 EditableDocument，
   * 让 Renderer 无需回溯 Layout Tree 即可应用正确的 transform。
   *
   * 目前用于：
   *   - 签名区域旋转（rotation angle from detectRegionRotation）
   *
   * 未来扩展：
   *   - 印章（stamp）斜角
   *   - 手写签名倾斜
   *   - 倾斜扫描文本
   *   - 图片区域 transform
   */
  transform?: EditableTransform;
  /**
   * Sprint 33.3.5: 嵌套子块。
   * 签名区域等复合块通过 children 保持层级结构，
   * 避免 Layout Tree 的 SIGNATURE_BLOCK → TEXT 层级在 Editable 层被 flatten。
   *
   * 层级约定：
   *   - 普通文本块：children = undefined（叶子节点）
   *   - 签名复合块：children = [子块1, 子块2, ...]（每个子块 type="text", regionType="signature"）
   */
  children?: EditableBlock[];
}

// ────────────────────────────────────────────────────────────────
// Page（页级）
// ────────────────────────────────────────────────────────────────

/**
 * EditablePage — 页级文档对象
 */
export interface EditablePage {
  /** 页码（1-based） */
  index: number;
  /** 页面宽度（CSS 显示坐标） */
  width: number;
  /** 页面高度（CSS 显示坐标） */
  height: number;
  /** 页内 block 列表 */
  blocks: EditableBlock[];
  /**
   * M7.8-035-FIX-4：MediaBox **下边界**的 PDF 纵坐标（= MediaBox.y0），缺省 0。
   *
   * 导入侧把 CSS 原点放在 MediaBox.y1（顶部），所以 CSS→PDF 的翻转基准是
   * `y1 = (height / scale) + y0`，只靠 height 会少掉 y0。
   * MediaBox.y0 ≠ 0 的 PDF（如 y0 = 7.83）若不记录此值，导出 mask 会整体偏移 y0，
   * 表现为「遮罩擦到下一行」或「旧文字没被盖住」。
   */
  originYPt?: number;
}

// ────────────────────────────────────────────────────────────────
// Original Text Operator Binding（M7.5-005E-C2A）
// ────────────────────────────────────────────────────────────────

/**
 * M7.5-005E-C2A · OriginalTextBinding — 建立「一组 EditableGlyph → 原始 PDF 文本算子」的映射。
 *
 * 005E-C2A 为只读绑定层：Import 侧新增 getOperatorList() 算子提取 + Glyph/Operator Strong Match。
 * 本阶段不修改 Export、不删除任何 Tj；本绑定只用于「安全替换边界」的定位依据。
 *
 * 第一版只要求 operatorIndex（不要求 content stream 字节 offset）。
 */
export interface OriginalTextBinding {
  /** 目标页码（0-based） */
  pageIndex: number;
  /** 显示该文本的字体资源 key（页面 /Font 下名字，如 "F1"） */
  fontRef: string;
  /** 该文本所在 text-show 算子在 getOperatorList 输出中的序号（fnArray 内 showText 的绝对索引） */
  operatorIndex: number;
  /** 文本算子类型：Tj = 单串；TJ = 带字距调整数组 */
  op: "Tj" | "TJ";
  /** 原始文本内容（算子解码后的 Unicode；替换校验用） */
  rawText: string;
  /** 绑定覆盖的 glyph 区间：block.lines 扁平 glyph 序的起止（含 start 不含 end） */
  glyphStart: number;
  glyphEnd: number;
  /** showText 时刻的文本变换（PDF pt，用于多算子歧义时的几何校验） */
  transform: TransformMatrix;
  /** Strong Match 置信度：strong = 唯一强命中；weak = 候选；仅 strong 允许安全替换 */
  confidence: "strong" | "weak";
}

/** 未绑定时：保持 null，继续 mask fallback（安全拒绑）。 */

// ────────────────────────────────────────────────────────────────
// Document（顶层）
// ────────────────────────────────────────────────────────────────

/**
 * EditableDocument — 顶层文档对象
 *
 * 整个 PDF 的可编辑表示。包含所有页、所有 block、所有 line、所有 glyph。
 *
 * styles 数组（Task 4 要求）：
 *   文档级去重样式表。所有 glyph 的 styleRef 指向此数组索引，
 *   避免每个 glyph 复制 style 对象。
 *   StyleResolver 负责注册/去重。
 *
 * metadata 保留原始 PDF 字节引用（用于导出时加载原 PDF）。
 */
/**
 * Editor Runtime —— 与 Document 自身属性分离的运行上下文。
 *
 * 【Sprint39-M2C】区分：
 *   - metadata  = Document 自身属性（title/author/producer/fileName 等）
 *   - runtime   = Editor Runtime（renderScale/viewport/cssScale 等，由 Import 补齐，Export 读取）
 *
 * 未来 OCR（ocrScale/imageDpi）、Signature（rotation）等也放 runtime，不污染 metadata。
 */
export interface EditableDocumentRuntime {
  /** PDF 渲染 scale（通常 1.5） */
  renderScale: number;
  /** CSS 显示缩放（canvas.clientWidth / canvas.width） */
  cssScale: number;
  /** 各页 viewport 尺寸（pt） */
  pageMetrics: { width: number; height: number }[];
}

export interface EditableDocument {
  /** 所有页 */
  pages: EditablePage[];
  /** 文档级样式表（去重）。glyph.styleRef 指向此数组索引。 */
  styles: EditableStyle[];
  /** 文档元数据（Document 自身属性，不含 Runtime 字段） */
  metadata: {
    /** 原始 PDF 文件名 */
    fileName?: string;
    /** 总页数 */
    pageCount: number;
    /** 创建时间戳 */
    createdAt: number;
  };
  /** Editor Runtime（由 parsePdfToEditableDocument 补齐，exportEditableDocument 读取） */
  runtime: EditableDocumentRuntime;
}
