/**
 * ExportCommand — Sprint 7 Task 1
 *
 * PDF 导出命令模型。
 *
 * 从 EditableDocument 生成，独立于渲染用的 RenderCommand。
 * RenderCommand 面向屏幕（CSS px），ExportCommand 面向 PDF（pt 坐标系）。
 *
 * 类型：
 *   - DrawTextGlyph：绘制单个字符（glyph 级精确导出）
 *   - DrawImage：绘制图片
 *   - DrawLine：绘制矩形（mask 遮盖 / 背景线）
 *   - Redaction：涂黑遮盖
 *
 * 坐标系：PDF pt（bottom-left origin, Y up）
 * 转换由 ExportRenderer 负责（CSS px → PDF pt）
 */

import type {
  GlyphFontIdentity,
  GlyphMetrics,
  TransformMatrix,
} from "./types";

/** ExportCommand 类型标记 */
export type ExportCommandType =
  | "drawTextGlyph"
  | "drawImage"
  | "drawLine"
  | "redaction";

/** 绘制单个字符（glyph 级精确导出） */
export interface DrawTextGlyphCommand {
  type: "drawTextGlyph";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /** 字符内容 */
  char: string;
  /** 位置（PDF pt，bottom-left origin） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /**
   * 文字基线纵坐标（PDF pt，bottom-left origin）。
   * 由导出阶段根据 glyph 真实 baseline（与 native replay / 编辑器预览一致）换算得到。
   * 缺省时回退到 g.y（bbox 底部近似 baseline），绝不能再退回 g.y + g.height（那是 bbox 顶部，会让文字整体上移一整行高）。
   */
  baseline?: number;
  /** 字体大小（PDF pt） */
  fontSize: number;
  /** 字体 family（CSS font-family 字符串） */
  fontFamily: string;
  /** 字体 weight */
  fontWeight: string | number;
  /** 字体 style */
  fontStyle: string;
  /** 颜色（#RRGGBB） */
  color: string;
  /** 所属 block ID */
  blockId: string;
  /**
   * ★ 2026-10-26 组键碰撞修复：写阶段按行分组的唯一键（`blockId#blockIndex:lineIndex`）。
   * bridge 每个 Core TextBox 产出一个 block 且 block.id 沿用 legacy blockId（整页同名），
   * 旧键 `blockId:lineIndex` 的 lineIndex 每 block 从 0 重数 ⇒ 不同 block 的第 1 行
   * 碰撞并组（实测 75-glyph 组整组按首 glyph 位置一次性绘制 ⇒ 乱位）。缺省 = 旧键。
   */
  groupKey?: string;
  /**
   * Sprint34.7: 所属 line 索引（可选）。
   * 用于 export 阶段按 EditableDocument line 边界逐行导出，避免重新 wrap。
   */
  lineIndex?: number;
  /**
   * Sprint34.11: 旋转角度（度，CSS 顺时针为正，与 glyph 一致）。
   * 导出 drawText 时用于旋转字形（需取负转 PDF 系）。
   */
  rotation?: number;
  /** 是否被修改过 */
  modified: boolean;
  /**
   * CSS 归一化 transform matrix [a, b, c, d, e, f]（可选）。
   * 仅保留旋转/倾斜，导出时用于恢复 PDF 原始旋转角度。
   */
  transform?: [number, number, number, number, number, number];
  /**
   * M7.5-005A：PDF Native Font Identity（可选）。源自 EditableGlyph.metrics.fontIdentity，
   * 供 Export 侧"看见"原字体资源（fontRef/baseFont/subtype/embedded/encoding）。
   * 本阶段仅透传，不消费（005B Font Resolver 再引用）。
   */
  fontIdentity?: GlyphFontIdentity;
  /**
   * M7.8-035R: 原 PDF 字符编码（pdfCharCode）。导出原生字体重绘时需要用它直接选择
   * 原字体（特别是 Type3）中的字形，而不是把 Unicode 当普通字符串嵌入回退字体。
   */
  pdfCharCode?: number;
  /**
   * M7.5-005A：PDF 原始综合变换矩阵（TextMatrix×FontMatrix×CTM，PDF pt 域，可选）。
   * 源自 EditableGlyph.metrics.pdfTransform。本阶段仅透传，不消费（005C Matrix Writer 再写回）。
   */
  pdfTransform?: TransformMatrix;
  /**
   * M7.5-005A：glyph 级 PDF 原生度量（advanceWidth/fontMatrix/pdfTransform/fontIdentity，可选）。
   * 保留完整 Native 上下文，避免逐字段复制丢信息。
   */
  glyphMetrics?: GlyphMetrics;
  /**
   * ★ Step 5B：**行级** export provenance —— 该行原始 PDF 内嵌字体身份。
   *
   * 源自 `EditableLine.originalFontIdentity`（由 Core→Legacy bridge 从 Sidecar 行绑定派生），
   * **刻意与上面的 `fontIdentity` 分开**：
   *   · `fontIdentity` = glyph 级测量 provenance，被 `isMeasuredOnly` / native replay 判定消费；
   *   · 本字段 = 行级 export provenance，**只**供 CID/非 WinAnsi 重绘路径选择原字体。
   *
   * 分开的原因：编辑行的 `glyph.metrics` 必然为空（Core `stripGlyphRange` 清了 glyph 索引），
   * 若把行级身份写进 `fontIdentity`，会翻转 `isMeasuredOnly`，把普通 WinAnsi 行踢出
   * 「整行单次 drawText」（M7.8-0XX 字距修复）路径。
   */
  originalFontIdentity?: GlyphFontIdentity;
}

/** 绘制图片 */
export interface DrawImageCommand {
  type: "drawImage";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /**
   * 图片 src（data URL 或 URL）—— legacy / 签名路径使用（经 fetch 取字节）。
   * B3-C-5-C 起：Core 图片导出走 `bytes` 字段（assetRef 解析后的原始字节），不再依赖 URL/src。
   */
  src?: string;
  /**
   * B3-C-5-C：Core 图片导出路径的字节载体（assetRef 经 ImageAssetRegistry 解析得到）。
   * 与 `src` 互斥——存在 `bytes` 时优先生效，避免任何 URL/dataURL 往返。
   */
  bytes?: Uint8Array;
  /** `bytes` 对应的媒体类型（"image/png" | "image/jpeg"），用于选择 embedPng/embedJpg */
  mime?: string;
  /** 位置（PDF pt） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /** 所属 block ID */
  blockId: string;
  /**
   * Sprint34.11: 旋转角度（度，CSS 顺时针为正，与 glyph 一致）。
   * 导出时若存在则用 PDF transform 绕 bbox 左上角旋转（需取负转 PDF 系）。
   */
  rotation?: number;
}

/** 绘制矩形（mask 遮盖 / 背景线） */
export interface DrawLineCommand {
  type: "drawLine";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /** 位置（PDF pt） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /** 用途：mask = 白色遮盖，background = 背景填充 */
  purpose: "mask" | "background";
  /** 所属 block ID */
  blockId: string;
}

/** 涂黑遮盖 */
export interface RedactionCommand {
  type: "redaction";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /** 位置（PDF pt） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /** 所属 block ID */
  blockId: string;
}

/**
 * F3B-6.28 · D-3B-2：**整行重绘**（flow 重排后的成员行 / 被推移的位移行）。
 *
 * ⚠️ 与 `DrawTextGlyphCommand` 的本质区别：本命令**不参与任何既有写入资格判定**
 *   （不依赖 `glyph.modified`、不走 raw-CID 预扫描、不做 native replay）。
 *   它只在 Binding 侧挂载了 `EditableLine.redrawLines` 时产生 —— 那是重绘的唯一入口。
 *
 * 逐字符几何已经在 Binding 侧算好（PDF pt 域，与 `pdfTransform` 同域）：
 *   · 有完整来源（fontRef + CID + 原 transform）⇒ raw-CID 直发（原字体原字形）；
 *   · 新增字符（原 PDF 无对应字形）⇒ 渲染层走既有 fallback，**不得伪造 CID/transform**。
 */
export interface DrawRedrawLineCommand {
  type: "drawRedrawLine";
  /** 目标页码（0-based） */
  pageIndex: number;
  /** 所属 block ID（诊断/归因用） */
  blockId: string;
  /** 锚点 legacy 行在 block 内的行序（诊断/归因用） */
  lineIndex: number;
  /** 锚点 legacy lineId（诊断/归因用） */
  lineId: string;
  /** 重绘角色 */
  role: "flow-member" | "displaced-successor";
  /** flow 行序（位移行 ⇒ null） */
  flowIndex: number | null;
  /** 该目标行的完整文本（诊断/回退绘制用） */
  text: string;
  /** 目标盒（PDF pt） */
  box: { x: number; y: number; width: number; height: number };
  /** 目标 baseline（PDF pt） */
  baselinePt: number;
  /**
   * F3B-6.28 · D-3B-4：该行**原始 baseline**（PDF pt；全新增行 ⇒ null）。
   * renderer 在重绘落笔前据此核验「原算子已完整剥离」—— mask 是遮盖手段，
   * 不是清除完整性证明（用户第 4 步决策三）。
   */
  originalBaselinePt: number | null;
  /** 该目标行相对原位置的垂直位移（CSS px，向下为正） */
  deltaCss: number;
  /** 逐字符目标几何（PDF pt 域；`pdfCharCode/fontRef/pdfTransform` 缺失 = 新增字符） */
  glyphs: {
    char: string;
    sourceLineId: string;
    sourceGlyphIndex: number | null;
    pdfCharCode: number | null;
    fontRef: string | null;
    pdfTransform: readonly number[] | null;
    targetXPt: number;
    targetBaselinePt: number;
    /**
     * F3B-6.28 · D-3B-4（决策一）：无 provenance 字符的处置。
     *   raw=原字符有完整来源；skip=可证明的合成空白（不画）；
     *   fallback=新增字符（回退字体）；fail=原字符缺来源且非空白 ⇒ 拒绝导出。
     */
    disposition: RedrawGlyphDisposition;
  }[];
}

/**
 * F3B-6.28 · D-3B-4（决策一）：重绘字符处置。
 * 由 Binding 侧判定一次（`export-redraw-gate.classifyRedrawGlyph`），renderer 只执行，
 * 不在渲染层重写策略。
 */
export type RedrawGlyphDisposition = "raw" | "skip" | "fallback" | "fail";

/** ExportCommand 联合类型 */
export type ExportCommand =
  | DrawTextGlyphCommand
  | DrawImageCommand
  | DrawLineCommand
  | RedactionCommand
  | DrawRedrawLineCommand;

/** 类型守卫 */
export function isDrawTextGlyph(
  cmd: ExportCommand
): cmd is DrawTextGlyphCommand {
  return cmd.type === "drawTextGlyph";
}

export function isDrawExportImage(
  cmd: ExportCommand
): cmd is DrawImageCommand {
  return cmd.type === "drawImage";
}

export function isDrawExportLine(cmd: ExportCommand): cmd is DrawLineCommand {
  return cmd.type === "drawLine";
}

export function isRedaction(cmd: ExportCommand): cmd is RedactionCommand {
  return cmd.type === "redaction";
}

/** F3B-6.28 · D-3B-2：整行重绘命令守卫 */
export function isDrawRedrawLine(cmd: ExportCommand): cmd is DrawRedrawLineCommand {
  return cmd.type === "drawRedrawLine";
}

/**
 * 按类型分组 ExportCommand（便于批量写入 PDF）
 */
export function groupExportCommands(commands: ExportCommand[]): {
  textGlyphs: DrawTextGlyphCommand[];
  images: DrawImageCommand[];
  lines: DrawLineCommand[];
  redactions: RedactionCommand[];
  redrawLines: DrawRedrawLineCommand[];
} {
  const textGlyphs: DrawTextGlyphCommand[] = [];
  const images: DrawImageCommand[] = [];
  const lines: DrawLineCommand[] = [];
  const redactions: RedactionCommand[] = [];
  const redrawLines: DrawRedrawLineCommand[] = [];

  for (const cmd of commands) {
    if (isDrawTextGlyph(cmd)) textGlyphs.push(cmd);
    else if (isDrawExportImage(cmd)) images.push(cmd);
    else if (isDrawExportLine(cmd)) lines.push(cmd);
    else if (isRedaction(cmd)) redactions.push(cmd);
    else if (isDrawRedrawLine(cmd)) redrawLines.push(cmd);
  }

  return { textGlyphs, images, lines, redactions, redrawLines };
}
