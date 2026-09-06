/**
 * ExportRenderer — Sprint 7 Task 2 + Task 3
 *
 * EditableDocument → ExportCommand[] → pdf-lib 写入
 *
 * Task 2: Export Pipeline
 *   EditableDocument → ExportRenderer → ExportCommand[] → pdf-lib
 *
 * Task 3: Preserve Export
 *   PRESERVE 模式：
 *     - glyph 位置保持（用 originalBBox）
 *     - style 保持（fontFamily/fontSize/color）
 *     - mask 保持（originalBounds 白色遮盖）
 *
 * 坐标转换：
 *   EditableDocument 的 bbox 在 CSS 显示坐标（canvas px × cssScale）
 *   ExportCommand 的坐标在 PDF pt（bottom-left origin, Y up）
 *   转换公式：
 *     ptX = cssX / (renderScale × cssScale)
 *     ptY = pageHeightPt - cssY / (renderScale × cssScale) - ptHeight
 *
 * 不修改现有 export-pdf.ts（保留作为 fallback）。
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFStream,
  PDFNumber,
  decodePDFRawStream,
  rgb,
  degrees,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import {
  calculateReplacementMaskBounds,
  resolveVisualCoverageBounds,
} from "./signature-mask-geometry";
import { pivotOfBounds } from "./signature-transform-context";
import type {
  EditableDocument,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  BBox,
  SignatureRenderRegion,
  GlyphFontIdentity,
} from "./types";
import type {
  ExportCommand,
  DrawTextGlyphCommand,
  DrawLineCommand,
  DrawImageCommand,
} from "./export-command";
import { groupExportCommands } from "./export-command";
// M7.8-035-FIX-5：复用已有的内容流解析/补丁能力做「文本层语义修复」
import {
  resolvePageShowTextWithXObjects,
  tokenizeContentStream,
  type TextShowRecord,
} from "./content-stream-resolver";
import { patchContentStream, computeRangeChecksum } from "./content-stream-patch";
import {
  filterOverlayForNativeReplaced,
  deriveNativeRoutingFromBlock,
  nativeLineKey,
  type NativeReplaceRouting,
} from "./native-export-router";
import { exportDocumentNativeFirst, stripNativeReadyState } from "./native-export-policy";
import { defaultExportStrategySelector } from "./export-strategy";
import type { ExportRequirements } from "./export-strategy";
import { analyzeMaskImpact, blockLineInkBands } from "./export-impact-analysis";
import { emitRawCidGlyphs, emitNativeTextRun } from "./export-raw-cid-font";

// Sprint40-fix（bug 3 通用修复）：Standard 14 回退字体缓存，避免逐 glyph 重复嵌入。
const stdFontCache = new Map<string, PDFFont>();
import {
  collectFontResources,
  findFontForChar,
  type PdfFontResource,
} from "./pdf-font-provenance";
import type { TransformMatrix } from "./types";
import fontkit from "fontkit";

/** 导出上下文（坐标转换参数） */
export interface ExportContext {
  /** PDF 渲染 scale（通常 1.5） */
  renderScale: number;
  /** CSS 显示缩放（canvas.clientWidth / canvas.width） */
  cssScale: number;
  /** 页面高度（PDF pt，用于 Y 翻转） */
  pageHeightPt: number;
  /**
   * M7.8-035-FIX-4：页面**顶部**的 PDF 纵坐标（= MediaBox.y1），Y 翻转的真正基准。
   *
   * 导入侧 CoordinateMapper.pdfYToCssY 用的是 `originYDevice = vp.transform[5]`
   * = MediaBox.y1 × scale，即 CSS 原点在 **y1**（不是 y0）。
   * 而这里 pageHeightPt = page.height / scale = MediaBox.**height** = y1 − y0。
   * 当 MediaBox.y0 ≠ 0 时两者相差 y0，导出翻转会把内容整体下移 y0：
   *   - 文字走原生重放（直接用原始 pdfTransform）→ 位置仍正确；
   *   - mask 走 cssToPdf → 位置偏移 y0 → 擦到下一行 / 漏掉旧文字。
   * 缺省时回退 pageHeightPt，保证 y0 === 0 的 PDF 行为完全不变。
   */
  pageTopPt?: number;
}

/**
 * M7.7-006: mask 安全扩展（CSS 显示坐标）。
 * 编辑态扫描出的真实墨迹盒是紧密贴合像素的包围盒；PDF 渲染时字形边缘有抗锯齿半透明像素，
 * 不加 padding 可能导致旧文字边缘残影。用小的保守扩展（约等于 1-2 个设备像素，经 scale 放大后
 * 在 PDF pt 中仍然很小）保证 100% 遮盖，又不至于侵入相邻行/相邻文字。
 */
// M7.9-MASK-COVER-FIX：padding 由 2 → 3（CSS px ≈ 2 PDF pt），容忍原文与重绘之间的亚像素
// 位置偏差与抗锯齿半透明边缘，避免原文边缘透出叠加成重影/变粗。相邻行越界由 lineMaskTop/Bottom
// 的 prevBottom/nextTop 钳制兜底，不会误擦邻居。
const MASK_PADDING_X = 3;
const MASK_PADDING_Y = 3;

/**
 * M7.8-035-FIX-4：计算与导入侧自洽的 Y 翻转基准。
 *
 * 导入（CoordinateMapper.pdfYToCssY）以 `vp.transform[5] = MediaBox.y1 × scale` 为原点，
 * 即 CSS 的 y=0 对应 PDF 的 **y1**；而 pageHeightPt 只等于 MediaBox **height** = y1 − y0。
 * 因此翻转基准必须是 `pageHeightPt + originYPt（= y0）`，否则 MediaBox.y0 ≠ 0 的 PDF
 * 导出内容会整体下移 y0（文字走原生重放不受影响，但 mask 会擦错行）。
 */
function pageFlipBase(
  page: { height: number; originYPt?: number },
  ctx: Pick<ExportContext, "renderScale" | "cssScale">,
): Pick<ExportContext, "pageHeightPt" | "pageTopPt"> {
  const pageHeightPt = page.height / (ctx.renderScale * ctx.cssScale);
  return { pageHeightPt, pageTopPt: pageHeightPt + (page.originYPt ?? 0) };
}

/** 空显示算子：`() Tj` 对 Tj/TJ 两种原始算子都合法，且不再产生任何文本层内容 */
const EMPTY_SHOW_BYTES = new TextEncoder().encode("() Tj");

/**
 * M7.8-035-FIX-5（decode-independent 文本层剥离）：
 * 匹配不依赖 ToUnicode 解码（部分 PDF 的 ToUnicode 错乱会让解码文本不可信，
 * 典型如把 "VICTOR" 解成 "VIBTOR"），直接以 glyph.pdfCharCode（原 PDF 原始 CID）
 * 反推算子原始字节，逐片段整段剥离。详见 stripReplacedTextOperators。
 */

function readStreamText(pdf: PDFDocument, ref: PDFRef): string | null {
  const obj = pdf.context.lookup(ref);
  if (obj instanceof PDFRawStream) {
    try {
      return Buffer.from(decodePDFRawStream({ dict: obj.dict, contents: obj.asUint8Array() }).getBytes()).toString("latin1");
    } catch {
      return null;
    }
  }
  if (obj instanceof PDFStream) {
    try {
      const bytes = obj.contents?.getBytes?.() ?? new Uint8Array(0);
      return Buffer.from(bytes).toString("latin1");
    } catch {
      return null;
    }
  }
  return null;
}

function writeStreamText(pdf: PDFDocument, ref: PDFRef, text: string): void {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  const obj = pdf.context.lookup(ref);
  if (obj instanceof PDFRawStream) {
    // Form XObject（及压缩内容流）：必须保留原 dict（/Subtype /Resources /BBox 等），
    // 仅替换内容字节并去掉压缩过滤器，否则会破坏 XObject 结构导致渲染异常。
    obj.dict.delete(PDFName.of("Filter"));
    obj.dict.delete(PDFName.of("DecodeParms"));
    if (typeof (obj.dict as any).set === "function") {
      (obj.dict as any).set(PDFName.of("Length"), PDFNumber.of(bytes.length));
    }
    obj.contents = bytes;
    return;
  }
  // 页面内容流无关键 dict，沿用原 assign 逻辑
  pdf.context.assign(ref, pdf.context.stream(bytes));
}

/**
 * M7.8-040R-3 Bug A：页面「内联 content stream」解析与回写。
 * resolver 对 page 直接内联内容流（/Contents 为直接流对象、非间接引用）给出
 * streamObjRef="embedded"。但 ctx.pdf.stream("embedded") 无法定位（embedded 不是合法
 * PDF 间接引用）→ 原方案跳过 → 整页 0 剥离 → 重影。必须从流对象本身解析/回写。
 */
function getEmbeddedContentStream(
  pdf: PDFDocument,
  pageIdx: number,
): PDFRawStream | PDFStream | null {
  if (pageIdx < 0 || pageIdx >= pdf.getPageCount()) return null;
  const page = pdf.getPage(pageIdx) as any;
  const contentsNode = page.node.Contents?.();
  // 多流 / 间接引用：各自有真实 ref（resolver 也会给非 embedded 的 streamObjRef），不在此分支处理
  if (!contentsNode || contentsNode instanceof PDFArray || contentsNode instanceof PDFRef) {
    return null;
  }
  return (contentsNode as unknown) as PDFRawStream | PDFStream;
}

function readStreamObject(obj: PDFRawStream | PDFStream): string | null {
  if (obj instanceof PDFRawStream) {
    try {
      return Buffer.from(decodePDFRawStream({ dict: obj.dict, contents: obj.asUint8Array() }).getBytes()).toString("latin1");
    } catch {
      return null;
    }
  }
  if (obj instanceof PDFStream) {
    try {
      const bytes = obj.contents?.getBytes?.() ?? new Uint8Array(0);
      return Buffer.from(bytes).toString("latin1");
    } catch {
      return null;
    }
  }
  return null;
}

function writeStreamObject(obj: PDFRawStream | PDFStream, text: string): void {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  if (obj instanceof PDFRawStream) {
    // 压缩内容流：保留原 dict，仅替换内容字节并去过滤器（与 writeStreamText 对齐）
    obj.dict.delete(PDFName.of("Filter"));
    obj.dict.delete(PDFName.of("DecodeParms"));
    if (typeof (obj.dict as any).set === "function") {
      (obj.dict as any).set(PDFName.of("Length"), PDFNumber.of(bytes.length));
    }
    obj.contents = bytes;
    return;
  }
  try {
    (obj as any).contents = bytes;
  } catch {
    /* 直接流写回失败：保持原流，overlay 兜底 */
  }
}

/**
 * M7.8-042-FIX：/Contents 必须是「间接引用」（ISO 32000-1 §7.3.8）。
 *
 * pdf-lib 的 `PDFContext.stream()` / `flateStream()` 返回的是**未注册**的 PDFRawStream。
 * 若把它直接 `page.node.set("Contents", stream)` 写回，导出的 /Contents 会变成：
 *     /Contents [ 19 0 R << /Length 15381 >> stream ... endstream 20 0 R ]
 * —— 数组里出现「直接流对象」。流只能是间接对象，这是非法 PDF：
 *   Chrome / Edge / Adobe 解析该页内容流失败 → 整页空白。
 *
 * 本函数在 save 前兜底扫描所有页，把 /Contents（单值或数组每一项）中的直接流对象
 * register 成间接对象。同时能自愈「历史导出的坏文件被再次编辑导出」的情况。
 */
export function ensureIndirectPageContents(pdf: PDFDocument): void {
  const contentsKey = PDFName.of("Contents");
  const toRef = (v: unknown): unknown =>
    v instanceof PDFRawStream || v instanceof PDFStream
      ? pdf.context.register(v as never)
      : v;
  for (let i = 0; i < pdf.getPageCount(); i++) {
    try {
      const page = pdf.getPage(i) as any;
      const node = page?.node;
      if (!node) continue;
      const entry = node.get(contentsKey);
      if (!entry) continue;
      if (entry instanceof PDFArray) {
        const items = entry.asArray();
        for (let k = 0; k < items.length; k++) {
          const fixed = toRef(items[k]);
          if (fixed !== items[k]) entry.set(k, fixed as never);
        }
      } else if (!(entry instanceof PDFRef)) {
        const fixed = toRef(entry);
        if (fixed !== entry) node.set(contentsKey, fixed as never);
      }
    } catch {
      /* 单页修复失败不应中断整体导出 */
    }
  }
}

/**
 * M7.8-036-FIX-002（Original Operator Provenance 文本层清理）：从原 content stream 移除
 * 「含被编辑 glyph」的 showText 算子，使编辑后文本真正进入复制层（旧文本不再残留、不重影）。
 *
 * 删除范围不再靠 charCode 序列去猜（旧 splitLineIntoFragments / findContiguousRuns / operatorCidCodes
 * 长度奇偶猜测均已删除）。改为直接消费「导入期为每个 glyph 钉定的 Original PDF Operator Provenance」：
 *   - glyph.operatorId        → TextShowRecord.operatorId（`${streamObjRef}#${sequentia}`，全局唯一）
 *   - glyph.operatorCharIndex → 该算子 charCodes 序列内的下标
 *
 * 流程：
 *   1. 遍历所有页，收集 modified glyph 的 operatorId（去重）。
 *   2. 每个 operatorId 反查 resolvePageShowTextWithXObjects 同页记录 → 定位字节区间
 *      （递归 Form XObject，按真实 stream PDFRef 逐流 patch；与旧方案一致，覆盖正文在 XObject 的 PDF）。
 *   3. 算子内只要有一个 glyph 被编辑 → 整 operator 剥离（overlay / native replay 已重绘整行）。
 *   4. 找不到记录 / charCodes === null（UNKNOWN provenance）→ 跳过，绝不删除（宁可保留原文也不误删）。
 *
 * 安全边界：必须在 writeExportCommandsToPDF **之前**调用；流内从后往前 patch（带 delta 偏移避免漂移）；
 *   全部异常吞掉，provenance 不可信时保留原文，文本层清理失败只影响复制语义，不应中断导出。
 */
/**
 * M7.8-041-FIX-R4：文本层剥离结果。
 * fullyStrippedLines 中记录「本行所有原算子都被成功剥离」的行 key（`blockId:lineIndex`）。
 * 这些行的旧文字已从 content stream 移除，导出时**无需再画白色 mask** ——
 * mask 只会白白擦掉行内的表格线（用户报告表格线消失）。
 */
type StripResult = {
  stripped: number;
  fullyStrippedLines: Set<string>;
};

async function stripReplacedTextOperators(
  pdf: PDFDocument,
  doc: EditableDocument,
): Promise<StripResult> {
  let stripped = 0;
  /** 成功剥离的 operatorId */
  const strippedOps = new Set<string>();
  /** 行 → 该行待剥离的 operatorId 集合（用于判定「整行是否剥离干净」） */
  const lineOpIds = new Map<string, Set<string>>();
  /** 存在「旧字形缺 operatorId」的行 —— 这些行无法剥离干净，禁止跳过 mask */
  const noProvenanceLines = new Set<string>();

  // ① 收集被编辑 glyph 的 operatorId（按页），去重。
  //    provenance 由导入期钉定（glyph.operatorId / operatorCharIndex），此处只消费、不再猜测。
  for (let pageIdx = 0; pageIdx < doc.pages.length; pageIdx++) {
    const page = doc.pages[pageIdx];
    if (pageIdx < 0 || pageIdx >= pdf.getPageCount()) continue;

    const opIds = new Set<string>();

    for (const block of page.blocks) {
      for (let li = 0; li < block.lines.length; li++) {
        const line = block.lines[li];
        const isEditedLine =
          line.edited || line.glyphs.some((g) => g.modified);
        const key = `${block.id}:${li}`;
        for (const g of line.glyphs) {
          if (!g.operatorId) {
            // 缺 provenance 的「原可见文字」glyph（未改动、有墨迹） → 其原算子无法定位、无法剥离。
            // 若据此判定「整行剥离干净」并跳过 mask，旧文字会残留 → 与新绘制整行叠加成重影
            //（实测：编号 "4" 缺 provenance → 导出成 "44 Bidens f r"）。
            // 排除两类：① 空格/布局空白（char.trim()===""）本无独立算子；
            //          ② 新增/插入字符（modified===true，原 PDF 中无对应算子，不存在残留）。
            continue;
          }
          if (isEditedLine) {
            // 编辑行将被「整行重绘」（native replay 或 overlay 均重绘整行），
            // 故收集该行**全部** glyph 的原算子 —— 含未改动的 "4"/"Bidens" 等，
            // 否则只剥离 modified glyph 的算子（如 "69"）会让 "4"/"Bidens" 残留，
            // 与新绘整行叠加成重影（实测 "44 Bidens f r"）。
            opIds.add(g.operatorId);
            const set = lineOpIds.get(key) ?? new Set<string>();
            set.add(g.operatorId);
            lineOpIds.set(key, set);
          } else if (g.modified || line.edited) {
            // 非整行编辑（单 glyph 改动且未标 edited）按原逻辑收集
            opIds.add(g.operatorId);
            const set = lineOpIds.get(key) ?? new Set<string>();
            set.add(g.operatorId);
            lineOpIds.set(key, set);
          }
        }
        // M7.8-042-ORPHAN：变短编辑（如 "100%"→"99%"）丢弃的原 glyph 算子也必须剥离。
        // 这些「孤儿算子」不在任何现存 glyph 上（glyph 已被删除），但原算子仍留在
        // content stream 里 → 不收集则原字符残留成重影（实测孤立 "%"）。
        if (isEditedLine && line.droppedOperatorIds?.length) {
          for (const dropId of line.droppedOperatorIds) {
            if (!dropId) continue;
            opIds.add(dropId);
            const set = lineOpIds.get(key) ?? new Set<string>();
            set.add(dropId);
            lineOpIds.set(key, set);
          }
        }
      }
    }
    // ② 本页算子记录（streamRef 分组 / 文本匹配兜底）
    let metaRecords: TextShowRecord[] = [];
    try {
      metaRecords = resolvePageShowTextWithXObjects(pdf, pageIdx);
    } catch {
      continue;
    }
    const metaById = new Map<string, TextShowRecord>();
    for (const r of metaRecords) metaById.set(r.operatorId, r);

    // M7.8-042-FALLBACK-Y：页可视区顶部（CropBox.y1）—— pdfjs 视口 y（向下）↔ 原始用户空间
    // textY（向上）换算锚点：textY ≈ y1 - pdfjsY。与 pdf.js getTextContent 的默认视口一致。
    let cropTopY: number | undefined;
    try {
      const pge = pdf.getPage(pageIdx);
      const cb = typeof pge.getCropBox === "function" ? pge.getCropBox() : undefined;
      cropTopY = cb && cb.height > 0 ? cb.y + cb.height : pge.getHeight();
    } catch {
      cropTopY = undefined;
    }

    // ①B 文本兜底（M7.8-041-FIX-STALE）：编辑行缺 operatorId provenance（旧 doc / HMR 残留内存态）
    // 时，按「行原文字」在流算子序列中文本匹配，回退到 provenance 剥离，使整行仍可被判定为
    // 剥离干净 → 跳过 mask → 保留表格线。仅当该编辑行尚未收集到任何 provenance 才触发，
    // 正常 provenance 路径完全不受影响。
    for (const block of page.blocks) {
      for (let li = 0; li < block.lines.length; li++) {
        const line = block.lines[li];
        const isEdited = line.edited || line.glyphs.some((g) => g.modified);
        if (!isEdited) continue;
        const key = `${block.id}:${li}`;
        if ((lineOpIds.get(key)?.size ?? 0) > 0) continue; // 已有 provenance，无需兜底
        const ids = textFallbackStripLine(line, metaRecords, cropTopY);
        if (ids.length > 0) {
          for (const id of ids) opIds.add(id);
          lineOpIds.set(key, new Set(ids));
        }
      }
    }

    // 重新判定「仍缺 provenance」的行（含兜底后仍失败）→ 禁止跳过 mask（避免旧文字残留成重影）
    for (const block of page.blocks) {
      for (let li = 0; li < block.lines.length; li++) {
        const line = block.lines[li];
        const isEdited = line.edited || line.glyphs.some((g) => g.modified);
        if (!isEdited) continue;
        const key = `${block.id}:${li}`;
        if ((lineOpIds.get(key)?.size ?? 0) === 0) {
          // 整行无任何 provenance（连文本兜底都没匹配到）→ 一定残留旧文字
          noProvenanceLines.add(key);
          continue;
        }
        // M7.8-FIX：即便行内「部分」glyph 有 provenance（其余已被收集/剥离），只要存在
        // 「原可见文字 glyph 缺 operatorId」（既非空格），其原算子就无法被定位、无法被剥离。
        // 这包含两类：① 未改动的原文字 glyph 缺 provenance；② 被编辑的 glyph（如 "6"→"7"）
        // 其「原始」算子同样缺 provenance（operatorId 由原始 glyph 继承，原始没有则新 glyph 也没有）。
        // 若其余算子恰好被剥离干净，该行会被误判为「整行剥离干净」→ 跳过 mask → 残留的旧文字
        // 与新绘制文字叠画成重影（实测表格单元格 "69" 等数字残留）。
        // 故：含此类不可追溯 glyph 的编辑行，禁止跳过 mask（与上方 noProvenance 行同等待遇）。
        // 注：纯插入（无原算子可残留、且非原可见文字）也会被此条件命中，但编辑行本就会走
        // overlay+mask，多画一块 per-glyph 白矩不会擦掉列间表格线（mask 是逐字形分段的），无害。
        const hasUntraceable = line.glyphs.some(
          (g) => !g.operatorId && g.char.trim() !== "",
        );
        if (hasUntraceable) noProvenanceLines.add(key);
      }
    }
    if (opIds.size === 0) continue;

    // ③ 收集待剥离区间（按 stream 分组）；算子内任一 glyph 被编辑 → 整 operator 剥离
    //    同时保留 opId 与区间的关联，供「整行是否剥离干净」判定使用。
    //    注：此处仅用 metaById 取 streamRef；byteStart/byteEnd 在 ④ 中基于实际 cur 重算。
    const targetsByStream = new Map<string, { bs: number; be: number; opIds: string[] }[]>();
    for (const opId of opIds) {
      const rec = metaById.get(opId);
      // UNKNOWN provenance（找不到记录 / 不可权威解码）→ 跳过，绝不删除
      if (!rec || rec.charCodes === null) {
        if (process.env.MASK_DIAG === "1") {
          console.log(`[FIX-002] 跳过 ${opId}：provenance 未知或不可权威解码`);
        }
        continue;
      }
      const arr = targetsByStream.get(rec.streamObjRef) ?? [];
      arr.push({ bs: rec.byteStart, be: rec.byteEnd, opIds: [opId] });
      targetsByStream.set(rec.streamObjRef, arr);
    }

    // ④ 按 stream 回填（从后往前，带 delta 偏移，避免漂移）
    for (const [streamRef, targets] of targetsByStream) {
      // M7.8-040R-3 Bug A：streamObjRef==="embedded" 为内联页面内容流（直接流对象），
      // 不能走 ctx.pdf.stream("embedded")（非法间接引用），需直接拿流对象解析/回写。
      let original: string | null = null;
      let writeBack: ((text: string) => void) | null = null;
      if (streamRef === "embedded") {
        const obj = getEmbeddedContentStream(pdf, pageIdx);
        if (!obj) continue;
        original = readStreamObject(obj);
        if (original == null) continue;
        // M7.8-041-FIX-R4：pdf-lib 会把内容流缓存为 PDFContentStream（operators），
        //   直接改 obj.contents 在 save 时被忽略 → 剥离无效（实测导出仍含 "(4) Tj"）。
        //   正确做法：用新 stream 整体替换 page.Contents，使其进入 pdf-lib 对象图并被保存。
        // M7.8-042-FIX：PDFContext.stream() 返回的是**未注册**的 PDFRawStream，
        //   直接 page.node.set("Contents", stream) 会把流写成「直接对象」——
        //   ISO 32000-1 §7.3.8 规定流只能是间接对象，否则 /Contents 里出现内联流，
        //   解析器判定页面内容流损坏 → 整页空白（用户报告「第一页内容无法显示」）。
        //   必须先 register 取 PDFRef，让 /Contents 指向间接对象。
        writeBack = (text: string) => {
          const nb = new Uint8Array(text.length);
          for (let i = 0; i < text.length; i++) nb[i] = text.charCodeAt(i) & 0xff;
          const pg = pdf.getPage(pageIdx) as any;
          pg.node.set(
            PDFName.of("Contents"),
            pdf.context.register(pdf.context.stream(nb)),
          );
        };
      } else {
        const refParts = streamRef.split(" ").map(Number);
        const ref = PDFRef.of(refParts[0], refParts[1] ?? 0);
        original = readStreamText(pdf, ref);
        if (original == null) continue;
        writeBack = (text: string) => writeStreamText(pdf, ref, text);
      }
      let cur = original;

      if (process.env.STRIP_DIAG === "1") {
        console.log(
          `[STRIP_DIAG] cur.indexOf("(4)") = ${cur.indexOf("(4)")}  ` +
          `cur.indexOf("(69)") = ${cur.indexOf("(69)")}  ` +
          `cur.indexOf("10.8 TL") = ${cur.indexOf("10.8 TL")}`,
        );
      }

      // M7.8-041-FIX-R4：基于实际 cur（即将被 patch 的字符串）重算各算子的真实字节区间。
      // 不用 extractShowTextRecords(cur) —— 其在「已重序列化 / 不同加载策略」的 pdf 上
      //   给出的 byteStart 与 cur 实际位置漂移（实测 embedded#15 偏移 -8 字节，把 "10.8 TL"
      //   当 "(4) Tj" 剥离 → 重影 "44"）。改用 tokenizeContentStream(cur)（与 _diag_tokens
      //   一致、偏移正确），按字符串字面量文本匹配算子。
      const toks = tokenizeContentStream(cur);
      // M7.9-STRIP-TJ-FIX：showOps 必须同时识别 **Tj**（顶层 literal/hex 紧跟 Tj）与
      // **TJ**（文本在数组内部、顶层是 `array` 紧跟 TJ）。旧实现只认 Tj，导致所有 TJ 算子的
      // 原文从未进入 showOps → findLocalRec 永远匹配不到 → 原文残留 → 导出重影
      // （实测：编辑中间列 "Begônia" 后，原 "Begônia" 未被剥离、新文本叠加成 "BegôniaBegônia de"）。
      // 此处收集口径与 extractShowTextRecords（metaRecords 来源）保持一致（Tj/TJ 各计一条、
      // 按 token 顺序），这样 streamMeta.length === showOps.length 成立，ALIGN-FIX 对齐得以启用。
      const showOps: {
        byteStart: number;
        byteEnd: number;
        raw: string;
        tm: { x: number; y: number } | null;
        text: string;
      }[] = [];
      let lastTm: { x: number; y: number } | null = null;
      const pendingNums: number[] = [];
      for (let i = 0; i < toks.length; i++) {
        const tok = toks[i];
        if (tok.kind === "number") {
          pendingNums.push(Number(tok.value));
          if (pendingNums.length > 6) pendingNums.shift();
          continue;
        }
        if (tok.kind === "op") {
          if (tok.value === "Tm" && pendingNums.length >= 6) {
            lastTm = { x: pendingNums[4], y: pendingNums[5] };
          }
          pendingNums.length = 0;
          continue;
        }
        if (
          (tok.kind === "literal" || tok.kind === "hex") &&
          toks[i + 1]?.kind === "op" &&
          (toks[i + 1].value === "Tj" || toks[i + 1].value === "TJ")
        ) {
          showOps.push({
            byteStart: tok.start,
            byteEnd: toks[i + 1].end,
            raw: cur.slice(tok.start, toks[i + 1].end),
            tm: lastTm ? { ...lastTm } : null,
            text: tok.value,
          });
          continue;
        }
        if (tok.kind === "array" && toks[i + 1]?.kind === "op" && toks[i + 1].value === "TJ") {
          // TJ：从数组内部拼接 literal/hex 文本（与 extractShowTextRecords 一致）
          let tjText = "";
          const inner = (tok as unknown as { value?: Array<{ kind: string; value: string }> }).value;
          if (Array.isArray(inner)) {
            for (const t of inner) {
              if (t.kind === "literal" || t.kind === "hex") tjText += t.value;
            }
          }
          showOps.push({
            byteStart: tok.start,
            byteEnd: toks[i + 1].end,
            raw: cur.slice(tok.start, toks[i + 1].end),
            tm: lastTm ? { ...lastTm } : null,
            text: tjText,
          });
          continue;
        }
        pendingNums.length = 0;
      }
      /**
       * M7.9-STRIP-ALIGN-FIX：把 meta 记录与 cur 中的文本算子按「流内序号」一一对齐。
       *
       * 背景（用户报告「上一个格子的数据没有显示」）：只按文本匹配时，同名算子会剥错。
       *   本 PDF 中第 3 行数量列的「5」与第 5 行序号的「5」，raw 都是 "(5) Tj"；
       *   旧实现取流中**第一个**同名算子，于是剥掉的是第 3 行的数量 → 那一行数据凭空消失。
       *
       * extractShowTextRecords 与此处使用同一个 tokenizeContentStream、按同一 token 顺序
       *   产出记录，故「第 i 条记录 ↔ cur 中第 i 个文本算子」是结构性对应，不受文本歧义影响。
       * 仅在数量严格一致时启用；否则保持原文本匹配行为（绝不比旧实现更激进）。
       */
      const streamMeta = metaRecords
        .filter((r) => r.streamObjRef === streamRef)
        .sort((a, b) => a.sequentia - b.sequentia);
      const alignedByOpId = new Map<string, (typeof showOps)[number]>();
      if (streamMeta.length > 0 && streamMeta.length === showOps.length) {
        for (let i = 0; i < streamMeta.length; i++) {
          alignedByOpId.set(streamMeta[i].operatorId, showOps[i]);
        }
      }
      /** 按真实文本在 cur 中匹配算子（相对 cur 的字节区间，patch 安全）。 */
      const findLocalRec = (opId: string): TextShowRecord | null => {
        const meta = metaById.get(opId);
        if (!meta) return null;
        // M7.9-STRIP-TEXT-FIX：showOps.text 与 meta.operatorText 同源（同一 tokenizer、同一字节
        // 解码），而 unicodeText 是 further 解码。本 PDF 中 "ô" 原字节被解成 "\u0002"，
        // unicodeText 才还原成 "ô"；两者对特殊字符不一致。若只用 unicodeText 匹配，
        // showOps.text（=operatorText 等价）永远命中不了 → 原算子不剥离 → 重影
        // （实测 "Beg\u0002nia"：unicodeText="Begônia" 与 showOps.text 不匹配，原文残留）。
        // 故匹配同时尝试 operatorText 与 unicodeText，任一命中即可；两者对 ASCII 恒等。
        const wantText = meta.unicodeText ?? "";
        const wantOper = meta.operatorText ?? "";
        if (!wantText && !wantOper) return null;
        // M7.9-STRIP-ALIGN-FIX：优先按序号对齐取算子（结构性定位，与文本是否同名无关）。
        // 命中后做文本校验（operatorText 或 unicodeText 任一命中），否则对齐不可信，回退文本匹配。
        const aligned = alignedByOpId.get(opId);
        if (
          aligned &&
          (aligned.text.includes(wantOper) ||
            aligned.text.includes(wantText) ||
            aligned.raw.toLowerCase().includes(wantOper.toLowerCase()) ||
            aligned.raw.toLowerCase().includes(wantText.toLowerCase()))
        ) {
          return aligned as unknown as TextShowRecord;
        }
        // 候选：decoded text 含目标文本（Tj/TJ 统一），或 raw 字面量含目标文本（hex 兜底）
        const cands = showOps.filter(
          (o) =>
            o.text.includes(wantOper) ||
            o.text.includes(wantText) ||
            o.raw.toLowerCase().includes(wantOper.toLowerCase()) ||
            o.raw.toLowerCase().includes(wantText.toLowerCase()),
        );
        if (cands.length === 0) return null;
        // 优先选 text 恰好等于目标文本的精确匹配
        const exact = cands.find((o) => o.text === wantOper || o.text === wantText);
        return (exact ?? cands[0]) as unknown as TextShowRecord;
      };

      // 同一 operator 可能被多个 glyph 命中 → 区间去重（合并 opIds）
      const uniq = new Map<string, { bs: number; be: number; opIds: string[] }>();
      for (const t of targets) {
        // 真实区间：embedded 用 cur 重算（文本就近匹配）；非 embedded 回退 metaById
        const realRec =
          streamRef === "embedded"
            ? findLocalRec(t.opIds[0])
            : metaById.get(t.opIds[0]);
        if (!realRec || realRec.charCodes === null) {
          if (process.env.MASK_DIAG === "1") {
            console.log(`[FIX-002] 跳过 ${t.opIds[0]}：cur 中未匹配到算子`);
          }
          continue;
        }
        const k = `${realRec.byteStart}:${realRec.byteEnd}`;
        const prev = uniq.get(k);
        if (prev) {
          for (const id of t.opIds) if (!prev.opIds.includes(id)) prev.opIds.push(id);
        } else {
          uniq.set(k, { bs: realRec.byteStart, be: realRec.byteEnd, opIds: [...t.opIds] });
        }
      }
      const sorted = [...uniq.values()].sort((a, b) => b.bs - a.bs);
      // 按字节位置从大到小处理，且 cur 原地变更：删除较高位置的算子不会影响较低位置的
      // 算子坐标，因此逐算子直接用原始 byteStart/byteEnd，切勿累计 delta 再偏移（否则会把
      // 较早的算子错移到错误字节，剥离掉相邻图形命令如表格线 "L"，造成重影/表格线消失）。
      for (const tgt of sorted) {
        const bs = tgt.bs;
        const be = tgt.be;
        if (process.env.STRIP_DIAG === "1") {
          console.log(
            `[STRIP_DIAG] stream=${streamRef} opIds=${tgt.opIds.join(",")} ` +
            `range=${bs}..${be} oldText=${JSON.stringify(cur.slice(bs, be).substring(0, 30))}`
          );
        }
        if (bs < 0 || be > cur.length || be <= bs) continue;
        let res: { contentText: string; checks: { parseOk: boolean } } | null = null;
        try {
          res = patchContentStream(
            cur,
            {
              byteStart: bs,
              byteEnd: be,
              checksum: computeRangeChecksum(cur, bs, be),
              oldText: cur.slice(bs, be),
            },
            EMPTY_SHOW_BYTES,
          );
        } catch {
          res = null;
        }
        if (res && res.checks?.parseOk) {
          cur = res.contentText;
          stripped++;
          // 记录成功剥离的算子 → 供「整行剥离干净」判定
          for (const id of tgt.opIds) strippedOps.add(id);
        } else if (process.env.MASK_DIAG === "1") {
          console.log(`[FIX-002] ${streamRef} 区间 ${bs}..${be} patch 失败，跳过（保留原文）`);
        }
      }
      if (cur !== original) {
        try {
          writeBack(cur);
        } catch {
          // 写回失败：保持原流 → 该 stream 上的算子实际未被移除，不能算剥离成功
          for (const t of targets) for (const id of t.opIds) strippedOps.delete(id);
        }
      }
    }
  }

  if (process.env.STRIP_DIAG === "1") {
    try {
      const pg = pdf.getPage(0) as any;
      const cNodes = pg.node.Contents?.();
      let txt: string | null = null;
      if (cNodes && !(cNodes instanceof PDFArray) && !(cNodes instanceof PDFRef)) {
        txt = readStreamObject(cNodes as PDFRawStream | PDFStream);
      }
      if (txt != null) {
        console.log(`[STRIP_DIAG] 写回后 page0 流含 "(4) Tj" = ${txt.includes("(4) Tj")}`);
      }
    } catch {
      /* ignore */
    }
  }

  // ⑤ 判定「整行剥离干净」：该行所有原算子都成功从 content stream 移除。
  //    这些行导出时不再需要白色 mask（mask 只会擦掉行内表格线）。
  const fullyStrippedLines = new Set<string>();
  for (const [key, ids] of lineOpIds) {
    if (ids.size === 0) continue;
    // 存在缺 provenance 的旧字形 → 该行一定有旧文字残留，绝不能跳过 mask
    if (noProvenanceLines.has(key)) continue;
    let all = true;
    for (const id of ids) {
      if (!strippedOps.has(id)) { all = false; break; }
    }
    if (all) fullyStrippedLines.add(key);
  }

  if (typeof console !== "undefined" && stripped > 0) {
    console.log(
      `%c[M7.8-036-FIX-002] 文本层清理: 按 operator provenance 移除 ${stripped} 个原始算子` +
      `（整行剥离干净 ${fullyStrippedLines.size} 行）`,
      "color:#16a34a;font-weight:bold;",
    );
  }
  return { stripped, fullyStrippedLines };
}

/**
 * M7.8-041-FIX-STALE：文本兜底剥离（仅在编辑行缺 operatorId provenance 时由
 * stripReplacedTextOperators 调用，正常 provenance 路径完全不受影响）。
 *
 * 根因：当内存中的 EditableDocument 由「未钉定 provenance 的旧导入」生成
 * （典型：HMR 热替换只刷新了 export-renderer.ts，但编辑器里那份已加载的 doc 仍是旧导入、
 *  glyph.operatorId 全为空），stripReplacedTextOperators 按 provenance 收集不到任何原算子 →
 * 整行不被判定为「剥离干净」→ 导出仍画整行白矩 mask → 擦掉行内表格线
 * （用户报告「表格线被擦除」的根因）。
 *
 * 兜底：用 glyph.originalChar（当前 mapNewTextToOriginalGlyphs 在 operatorId 缺失时仍会
 * 经 `orig?.char` 回退保留原字符）拼出「行原文字」，在流算子序列中按文本匹配，
 * 回退到 provenance 剥离，使整行仍可被判定为剥离干净 → 跳过 mask → 保留表格线。
 *
 * @returns 该编辑行命中的原算子 operatorId 列表（可能跨多个 Tj/TJ）。
 */
/**
 * M7.8-042-FALLBACK-Y · 文本兜底剥离 v2。
 *
 * v1 缺陷：把整页所有算子按流顺序拼成一条长文本，要求「行原文字」在其中**连续**命中。
 * 真实 PDF 的表格行文字在内容流中常与其它行交错（非连续）→ indexOf 失配（idx=-1）→
 * 整行不剥离 → 原文残留 + overlay 新文字叠加 = 重影（用户报告第 2 行 "power 100%"）。
 *
 * v2 优先走 **y 带过滤**：resolver 现为每个 showText 算子记录其文本行矩阵 baseline
 * （textY，原始用户空间），行 glyph 的 metrics.pdfTransform[5] 是 pdf.js 视口基线 y
 * （向下），两者满足 textY ≈ cropTopY - pdfjsY。先取「与编辑行同 baseline 带」的算子
 * 子集（彻底消除跨行同词误配），再做文本匹配；带内失配或无位置数据时退回 v1 全流匹配。
 *
 * @param cropTopY 页可视区顶部（CropBox.y + height），用于 pdfjs↔PDF 用户空间换算；缺省跳过 y 过滤。
 * @returns 该编辑行命中的原算子 operatorId 列表（可能跨多个 Tj/TJ）。
 */
function textFallbackStripLine(
  line: EditableLine,
  metaRecords: TextShowRecord[],
  cropTopY?: number,
): string[] {
  const norm = (s: string) => s.replace(/\s+/g, "");
  // 重建「行原文字」：未编辑 glyph 直接用 char（即原文）；已编辑 glyph 用 originalChar
  // （插入字符的 originalChar 已为 undefined → 视为空，不污染匹配）；空格等布局字符照常。
  const target = norm(
    line.glyphs
      .map((g) => (!g.modified ? g.char : (g.originalChar ?? "")))
      .join(""),
  );
  if (!target) return [];

  const matchOps = (ops: TextShowRecord[], tag: string): string[] => {
    // 拼完整流文本（保留原样用于区间映射），同时记录每个算子的 [start, end)
    let full = "";
    const ranges: { id: string; start: number; end: number }[] = [];
    for (const op of ops) {
      const t = op.unicodeText ?? op.operatorText ?? "";
      ranges.push({ id: op.operatorId, start: full.length, end: full.length + t.length });
      full += t;
    }
    const idx = norm(full).indexOf(target);
    if (process.env.MASK_DIAG === "1") {
      console.error(`[FALLBACK-DBG:${tag}] line.id=${line.id} target=${JSON.stringify(target)} fullLen=${full.length} idx=${idx} firstFull=${JSON.stringify(norm(full).slice(0, 60))}`);
    }
    if (idx < 0) return [];
    // 把归一化命中区间映射回原始 full 的 [lo, hi)
    let lo = -1;
    let hi = -1;
    let acc = 0;
    for (let i = 0; i < full.length; i++) {
      if (/\s/.test(full[i])) continue;
      if (lo < 0 && acc === idx) lo = i;
      if (acc === idx + target.length - 1) {
        hi = i + 1;
        break;
      }
      acc++;
    }
    if (lo < 0 || hi < 0) return [];
    const hit = ranges.filter((r) => r.end > lo && r.start < hi).map((r) => r.id);
    if (process.env.MASK_DIAG === "1") {
      console.error(`[FALLBACK-DBG:${tag}] line.id=${line.id} lo=${lo} hi=${hi} hitOps=${hit.length} full[lo..hi]=${JSON.stringify(full.slice(lo, hi))}`);
    }
    return hit;
  };

  const base = metaRecords
    .filter((r) => r.charCodes !== null && (r.unicodeText !== undefined || r.operatorText))
    .sort((a, b) => a.byteStart - b.byteStart);
  if (base.length === 0) return [];

  // ── 首选：y 带过滤匹配（同 baseline 才参与，跨行同词绝不误配）──
  if (cropTopY !== undefined) {
    const pdfjsYs = line.glyphs
      .map((g) => (g as unknown as { metrics?: { pdfTransform?: number[] } }).metrics?.pdfTransform?.[5])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (pdfjsYs.length > 0) {
      const TOL = 2.5; // pt；行内 baseline 抖动容忍（远小于最小行距）
      const min = Math.min(...pdfjsYs);
      const max = Math.max(...pdfjsYs);
      const fLo = cropTopY - max - TOL;
      const fHi = cropTopY - min + TOL;
      const bandOps = base.filter(
        (r) => typeof r.textY === "number" && r.textY >= fLo && r.textY <= fHi,
      );
      if (bandOps.length > 0) {
        const hit = matchOps(bandOps, "YBAND");
        if (hit.length > 0) return hit;
      }
    }
  }

  // ── 退路：v1 全流匹配 ──
  return matchOps(base, "FULL");
}

/**
 * CSS 显示坐标 → PDF pt 坐标（Y 翻转）
 *
 * @param cssRect CSS 显示坐标 { x, y, width, height }
 * @param ctx 导出上下文
 * @returns PDF pt 坐标 { x, y, width, height }
 */
function cssToPdf(
  cssRect: { x: number; y: number; width: number; height: number },
  ctx: ExportContext
): { x: number; y: number; width: number; height: number } {
  const totalScale = ctx.renderScale * ctx.cssScale;
  // M7.8-035-FIX-4：以页面顶部（MediaBox.y1）为翻转基准，与导入侧 pdfYToCssY 自洽。
  const flipBase = ctx.pageTopPt ?? ctx.pageHeightPt;
  // M7.8-048-FIX-EXPORT-X：glyph.bbox 是 renderScale 文档坐标系（CSS px @ scale=renderScale），
  // cssScale 仅是「显示缩放」（clientWidth/canvas.width），不参与文档坐标换算。
  // 此前 ptX 被多除了 cssScale → 编辑 overlay 文字相对原图右移 (约 cssScale 偏离量)。
  // Y 仍由 baseline 单独处理、width/height 仅用于 mask bbox，故仅修正 X 一个维度。
  const ptX = cssRect.x / ctx.renderScale;
  const ptY = flipBase - (cssRect.y / totalScale) - (cssRect.height / totalScale);
  const ptW = cssRect.width / totalScale;
  const ptH = cssRect.height / totalScale;
  return { x: ptX, y: ptY, width: ptW, height: ptH };
}

/**
 * CSS fontSize → PDF pt fontSize
 */
function fontSizeCssToPt(fontSizeCss: number, ctx: ExportContext): number {
  return fontSizeCss / (ctx.renderScale * ctx.cssScale);
}

/**
 * Task 2: 把单个 block 转换为 ExportCommand[]
 *
 * PRESERVE 模式（Task 3）：
 *   - mask：originalBounds → 白色矩形遮盖
 *   - glyph：用 originalBBox（保持原始位置）
 *   - style：从 styleRef 解析（保持字体/颜色）
 *
 * RECONSTRUCT 模式：
 *   - mask：originalBounds → 白色矩形遮盖
 *   - glyph：用 bbox（LayoutEngine 重新计算的位置）
 *   - style：同上
 */
export function renderBlockToExportCommands(
  block: EditableBlock,
  styles: EditableStyle[],
  ctx: ExportContext,
  pageIndex = 0,
  /** M7.7-006: 编辑态记录的真实墨迹覆盖盒（lineId → CSS bbox）。导出 mask 用它而非模型 bbox。 */
  editedLineBoxes?: Map<string, BBox>,
  /** M7.8-035R: 当前页所有 block，跨 block 找下一行顶。 */
  pageBlocks?: EditableBlock[],
): ExportCommand[] {
  if (block.type !== "text") return [];

  const commands: ExportCommand[] = [];
  const mode = block.layoutMode || "preserve";

  // M7.7-004A：逐行 native routing —— native-ready / 未触碰行 → 跳过 mask + 重绘（原 PDF 内容承担），
  // 仅「编辑过但 native 失败 / 需 overlay」的行生成逐行 mask + 重绘（避免整块白矩遮住未编辑原生文本）。
  const routing = deriveNativeRoutingFromBlock(block);

  // Sprint34.7 Debug: 打印 export 输入 block
  if (typeof console !== "undefined") {
    console.log(
      `%c[ExportRenderer] block: ${block.id} type=${block.type} layoutMode=${mode} lines=${block.lines.length} native=${[...routing.replacedLines].join(",")}`,
      "color:#0ea5e9;",
    );
    for (const l of block.lines) {
      console.log(
        `  line: "${l.glyphs.map((g) => g.char).join("")}" y=${l.bbox.y} h=${l.bbox.height} glyphs=${l.glyphs.length}`,
      );
    }
  }

  // M7.8-024 Step B: 预计算每行 original ink band（含 CID 变换），供 analyzeMaskImpact 判定受影响邻行
  // 注意 blockLineInkBands 要求 toPdfInk 返回 InkRect({x0,y0,x1,y1})，而 cssToPdf 返回 {x,y,width,height}，需转换
  const bands = blockLineInkBands(block, (b) => {
    const p = cssToPdf(b, ctx);
    return { x0: p.x, y0: p.y, x1: p.x + p.width, y1: p.y + p.height };
  });

  // 逐行导出：仅非 native-ready / 未触碰的行需要 overlay（per-line mask + glyph 重绘）
  for (let li = 0; li < block.lines.length; li++) {
    const line = block.lines[li];
    const lineKey = nativeLineKey(block.id, li);
    const skipOverlay =
      routing.replacedLines.has(lineKey) || routing.fullyReplacedBlocks.has(block.id);
    if (skipOverlay) continue;

    // ── M7.8-034 Phase B: 只为「真正被编辑的行」生成 mask + 重绘 ──
    // 旧行为：block 内所有行都生成白色 mask + 逐 glyph 重绘。结果是整块原文被擦掉后
    // 用（回落后的）Standard 14 字体重画 —— 即使那些行一个字都没改。
    // 这正是用户报告的「导出后字体/大小/样式/长度全变」以及「邻行被遮」的直接原因。
    // 新行为：未编辑的行完全不碰，由原 PDF 内容流原样呈现（像素级零损伤）。
    // M7.8-040R-3 Bug B：编辑可能是「删除 / 无变化」（残留 glyph 未被标 modified），
    // 但 line.edited 已由 applySegmentEditsToDocument 置 true → 仍判定为已编辑，整行 overlay 重绘。
    const lineEdited = line.glyphs.some((g) => g.modified) || line.edited === true;
    if (!lineEdited) continue;

    // M7.7-006: per-line mask —— 优先用编辑态记录的真实墨迹覆盖盒（editedLineBoxes，含 canvas 扫描
    // 扩展，贴合 pdf.js 实际渲染像素），否则回退模型 line.bbox。模型 bbox 比实际墨迹窄/偏移
    // （M7.7-004C：窄 ~18%、垂直偏移 ~11px）→ 直接用它会导致"旧文字边缘残留"（M5 最大风险）。
    // mask 加 MASK_PADDING 安全扩展，覆盖抗锯齿边缘半透明像素。
    const realBox = editedLineBoxes?.get(line.id);
    // M7.8-022A: fallback 时 mask 取「line.bbox ∪ glyph 实际并集」。
    // 模型 line.bbox 比真实墨迹窄（M7.7-004C：~18%）且可能垂直偏移（~11px），
    // 直接用它当 mask 会残留旧文字（用户报告"导出后看到原文"）。
    // 与 glyph 并集合并后，mask 才能贴合实际绘制内容。
    const glyphUnion = (() => {
      if (line.glyphs.length === 0) return null;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const g of line.glyphs) {
        minX = Math.min(minX, g.bbox.x);
        minY = Math.min(minY, g.bbox.y);
        maxX = Math.max(maxX, g.bbox.x + g.bbox.width);
        maxY = Math.max(maxY, g.bbox.y + g.bbox.height);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    })();
    const fbLineBBox = line.bbox;
    // 单行 fallback：line.bbox 与 glyph 并集的合并（二者都可能不覆盖完整墨迹）
    const fbBox = (() => {
      if (!glyphUnion) return fbLineBBox;
      if (!fbLineBBox) return glyphUnion;
      const minX = Math.min(fbLineBBox.x, glyphUnion.x);
      const minY = Math.min(fbLineBBox.y, glyphUnion.y);
      const maxX = Math.max(fbLineBBox.x + fbLineBBox.width, glyphUnion.x + glyphUnion.width);
      const maxY = Math.max(fbLineBBox.y + fbLineBBox.height, glyphUnion.y + glyphUnion.height);
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    })();
    // M7.8-034 Phase C: mask = 编辑行「完整 original ink」。
    // 来源优先级：
    //   1. 编辑态 canvas 扫描的真实墨迹盒（editedLineBoxes，含完整 ascender/descender），
    //      它比模型 bbox 更贴合实际渲染像素，可避免旧文字边缘残留（重影/遮一半）。
    //   2. glyph.originalBBox ∪ glyph.bbox（原始位置 ∪ 编辑后新位置）。
    // 纪律：
    //   - 不改 CoordinateMapper / cssToPdf / baseline / font-size / lineHeight。
    //   - mask 下沿钳制到下一行顶部，避免遮罩侵占下一行；真实 ascender/descender 已由
    //     editedLineBoxes 覆盖，钳制不会导致残留。
    let inkMinX = Number.POSITIVE_INFINITY;
    let inkMinY = Number.POSITIVE_INFINITY;
    let inkMaxX = Number.NEGATIVE_INFINITY;
    let inkMaxY = Number.NEGATIVE_INFINITY;
    // M7.8-034 Phase B/C：mask = 编辑行的**完整** original ink bbox（originalBBox ∪ 编辑后 bbox）。
    // 几何上必须覆盖整行：Phase C 会以行首 glyph 的 pdfTransform 为基准、按 native advance
    // 累积重建整行；若 mask 只覆盖局部，未擦除的前缀会与重建文字叠画成重影。
    // 「不遮住前缀未修改文字」由 Phase C 保证 —— 用原字体+原位置+原 advance 重建后，
    // 前缀像素与原文一致（regression 以 pixel diff = 0 判定，而非 mask 几何）。
    for (const g of line.glyphs) {
      const b = g.originalBBox ?? g.bbox;
      if (!b) continue;
      inkMinX = Math.min(inkMinX, b.x);
      inkMinY = Math.min(inkMinY, b.y);
      inkMaxX = Math.max(inkMaxX, b.x + b.width);
      inkMaxY = Math.max(inkMaxY, b.y + b.height);
      // 同时纳入编辑后的新位置（字符变长后新墨迹会落到原 bbox 之外）
      const nb = g.bbox;
      if (nb) {
        inkMinX = Math.min(inkMinX, nb.x);
        inkMinY = Math.min(inkMinY, nb.y);
        inkMaxX = Math.max(inkMaxX, nb.x + nb.width);
        inkMaxY = Math.max(inkMaxY, nb.y + nb.height);
      }
    }
    // M7.8-034 Phase C: 编辑态 canvas 扫描的真实墨迹盒（含完整 ascender/descender）
    // 比模型 bbox 更准确，必须纳入 mask，否则旧文字边缘残留（重影/遮一半）。
    if (realBox) {
      inkMinX = Math.min(inkMinX, realBox.x);
      inkMinY = Math.min(inkMinY, realBox.y);
      inkMaxX = Math.max(inkMaxX, realBox.x + realBox.width);
      inkMaxY = Math.max(inkMaxY, realBox.y + realBox.height);
    }

    // ── mask 生成 ──
    // 先按「行级 bbox」计算垂直范围（含 nextTop 钳制），再按 glyph 切分为多个小 mask。
    // 这样 glyph 之间的表格线/竖线不会被整行白矩擦除（用户报告表格线消失）。
    let maskRects: { x: number; y: number; width: number; height: number }[] = [];
    if (inkMaxX > inkMinX && inkMaxY > inkMinY) {
      // 加安全 padding 覆盖抗锯齿半透明像素，同时避免侵入相邻行（上下均需防护）。
      let mh = inkMaxY - inkMinY + MASK_PADDING_Y * 2;

      // M7.8-035-FIX-3：mask 下沿钳制到「下一行顶部」。旧实现有两个致命缺陷：
      //
      //   缺陷① 没有排除**当前行自己**。遍历 otherLine 时把正在编辑的 line 也算了进去。
      //          当前行 glyph 的 bbox.y（行框顶）大于 mask 顶部 my（= inkMinY - PADDING），
      //          于是当前行自己满足 `lineTop > my + 0.001` 被当成「下一行」：
      //            nextTop = inkMinY
      //            mh      = nextTop - my = MASK_PADDING_Y = 2px
      //          真实 PDF 实测：mask 高度被压成 1.3333pt，原文 100% 残留，形成重影。
      //
      //   缺陷② 用 `inkMaxY - gapEps` 作下界会**把紧邻的下一行也排除掉**
      //          （gapEps=4px 大于行间距），导致 nextTop 缺失，mh 退化为默认高度
      //          inkHeight+4，反而侵入下一行，擦掉下一行顶部。
      //
      // 正确判据：排除当前行自己后，取**所有在当前行墨迹顶部之下**的最近一行；
      // 这样下一行行框顶无论多近都会被正确识别。
      //
      // M7.9-MASK-TOP-FIX（与下沿对称）：同时求「上一行底部」用于上沿钳制。
      //   此前只钳下沿、不钳上沿，而上沿直接取 glyph.bbox 顶部（行框顶，比真实墨迹顶
      //   高出 ascender+leading）。行距紧凑的表格里相邻行行框重叠 → mask 向上越过上一行
      //   墨迹底部 → 擦掉上一行同列内容（实测：编辑第 4 行数量列后，第 3 行数量列的
      //   「5」被整块擦除，即用户报告的「上一个格子的数据不见了」）。
      let nextTop: number | undefined;
      let prevBottom: number | undefined;
      const scanBlocks = pageBlocks ?? [block];
      for (const otherBlock of scanBlocks) {
        for (const otherLine of otherBlock.lines) {
          if (otherLine.id !== undefined && line.id !== undefined && otherLine.id === line.id) {
            continue; // ① 排除当前行自己
          }
          const lineTop =
            otherLine.glyphs.length > 0
              ? Math.min(...otherLine.glyphs.map((g) => g.bbox?.y ?? Infinity))
              : otherLine.bbox?.y;
          if (lineTop !== undefined && Number.isFinite(lineTop) && lineTop > inkMinY + 0.001) {
            // ② 必须是当前行墨迹之下的行
            if (nextTop === undefined || lineTop < nextTop) nextTop = lineTop;
          }
          // 上一行：墨迹底部位于当前行墨迹之上 → 作为上沿钳制边界
          const frameBottom =
            otherLine.glyphs.length > 0
              ? Math.max(...otherLine.glyphs.map((g) => (g.bbox?.y ?? -Infinity) + (g.bbox?.height ?? 0)))
              : (otherLine.bbox?.y ?? -Infinity) + (otherLine.bbox?.height ?? 0);
          if (Number.isFinite(frameBottom) && frameBottom < inkMaxY - 0.001) {
            if (prevBottom === undefined || frameBottom > prevBottom) prevBottom = frameBottom;
          }
        }
      }
      // ③ 下沿基准必须用**真实墨迹底部**，而不是 glyph.bbox 底部。
      //    glyph.bbox 是「行框」= ascender + descender + leading，其底部比真实墨迹底部
      //    低约行高的 20%。在行距紧凑的 PDF 里，相邻两行的行框会重叠，
      //    用行框底部当 mask 下沿就会侵入下一行（实测 L2 下一行被擦掉 50.4%）。
      //    正确做法：baseline + descender（descender ≈ 行框高 × 0.25）估算真实墨迹底部。
      let inkBottom = inkMaxY;
      let maxBaseline = -Infinity;
      for (const g of line.glyphs) {
        const bl = g.baseline;
        if (typeof bl === "number" && Number.isFinite(bl)) maxBaseline = Math.max(maxBaseline, bl);
      }
      if (Number.isFinite(maxBaseline)) {
        const est = maxBaseline + (inkMaxY - inkMinY) * 0.25;
        // M7.9-MASK-COVER-FIX：取较大者——baseline 估算只作兜底，真实墨迹底（含字脚 descender）
        // 优先；旧实现用 `est < inkBottom` 会压低 mask 下沿，漏掉字脚 → 原文字脚透出、与新文本
        // 叠加成重影/变粗（实测编辑行颜色加深）。相邻行越界由下方 nextTop 钳制兜底。
        if (est > inkBottom) inkBottom = est;
      }
      // ④（与③对称）上沿基准必须用**真实墨迹顶部**，而不是 glyph.bbox 顶部（行框顶）。
      //    行框顶含 ascender + leading，比真实墨迹顶高出约行高的 20%~30%；
      //    行距紧凑时相邻行行框重叠 → mask 上沿侵入上一行 → 擦掉上一行同列内容。
      //    正确做法：baseline - ascender（ascender ≈ 行框高 × 0.75）估算真实墨迹顶部。
      let inkTop = inkMinY;
      if (Number.isFinite(maxBaseline)) {
        const estTop = maxBaseline - (inkMaxY - inkMinY) * 0.75;
        // M7.9-MASK-COVER-FIX：取较小者——baseline 估算只作兜底，真实墨迹顶（含重音符 ã/ô 字顶）
        // 优先；旧实现用 `estTop > inkTop` 会抬高 mask 上沿，漏掉重音字顶 → 原文字顶透出、与
        // 新文本叠加成重影/变粗（实测 "Informo..." 段颜色加深）。相邻行越界由上方 prevBottom 钳制兜底。
        if (estTop < inkTop) inkTop = estTop;
      }
      let my = inkTop - MASK_PADDING_Y;
      // ⑤ 上沿钳制：绝不越过上一行墨迹底部（留 1px 安全间隙）。
      //    宁可当前行顶部残留一点，也绝不能擦掉上一行的有效内容（后者是数据丢失）。
      if (prevBottom !== undefined && my < prevBottom + 1) my = prevBottom + 1;
      const lineMaskTop = my;
      const defaultH = Math.max(1, inkBottom - inkTop + MASK_PADDING_Y * 2);
      mh = defaultH;
      if (nextTop !== undefined && my + mh > nextTop - 1) {
        // 绝不越过下一行顶部（留 1px 安全间隙）；
        // 保底至少覆盖到 baseline，避免极端行重叠时 mask 被裁成一条线（重影）。
        const minH = Number.isFinite(maxBaseline) ? Math.max(1, maxBaseline + 1 - my) : Math.max(1, inkBottom - inkTop);
        mh = Math.max(minH, Math.min(mh, nextTop - my - 1));
      }
      const lineMaskBottom = lineMaskTop + mh;

      if (process.env.MASK_DIAG === "1") {
        console.log(
          `[MASK_DIAG] line=${line.id} inkMinY=${inkMinY.toFixed(2)} inkMaxY=${inkMaxY.toFixed(2)} ` +
          `maxBaseline=${Number.isFinite(maxBaseline) ? maxBaseline.toFixed(2) : "n/a"} ` +
          `inkBottom=${inkBottom.toFixed(2)} nextTop=${nextTop !== undefined ? nextTop.toFixed(2) : "n/a"} ` +
          `my=${my.toFixed(2)} defaultH=${defaultH.toFixed(2)} mh=${mh.toFixed(2)} ` +
          `maskBottom=${lineMaskBottom.toFixed(2)}`,
        );
      }

      // 计算同行 glyph 宽度的中位数，用于识别表格布局中的超宽空格。
      const glyphWidths = line.glyphs
        .map((g) => g.bbox?.width ?? 0)
        .filter((w) => w > 0.001)
        .sort((a, b) => a - b);
      const medianW = (() => {
        if (glyphWidths.length === 0) return 0;
        const mid = Math.floor(glyphWidths.length / 2);
        return glyphWidths.length % 2 === 0
          ? (glyphWidths[mid - 1] + glyphWidths[mid]) / 2
          : glyphWidths[mid];
      })();
      const maxNormalWidth = Math.max(medianW * 2.5, medianW + 30);

      // 逐 glyph 生成 mask：覆盖原位置 ∪ 编辑后位置，但跳过表格布局用的超宽空格。
      // 多个小 mask 之间会保留表格线（竖线 / 部分横线）。
      const rawRects: { x: number; y: number; width: number; height: number }[] = [];
      for (const g of line.glyphs) {
        const bw = g.bbox?.width ?? 0;
        // 跳过表格布局用的超宽空格（本身不含可见墨迹，mask 会误擦列间表格线）。
        if (
          (g.char === " " || g.originalChar === " ") &&
          bw > maxNormalWidth
        ) continue;

        const b1 = g.originalBBox ?? g.bbox;
        const b2 = g.bbox;
        if (!b1 && !b2) continue;
        const minX = Math.min(b1?.x ?? Infinity, b2?.x ?? Infinity);
        const minY = Math.min(b1?.y ?? Infinity, b2?.y ?? Infinity);
        const maxX = Math.max(
          b1 ? b1.x + b1.width : -Infinity,
          b2 ? b2.x + b2.width : -Infinity,
        );
        const maxY = Math.max(
          b1 ? b1.y + b1.height : -Infinity,
          b2 ? b2.y + b2.height : -Infinity,
        );
        if (!Number.isFinite(minX + minY + maxX + maxY)) continue;

        // 用行级垂直范围裁剪，保证不侵入下一行；水平方向保留 glyph 真实范围。
        const rx = minX - MASK_PADDING_X;
        const ry = Math.max(lineMaskTop, minY - MASK_PADDING_Y);
        const rb = Math.min(lineMaskBottom, maxY + MASK_PADDING_Y);
        if (rb <= ry) continue;
        rawRects.push({ x: rx, y: ry, width: maxX - minX + MASK_PADDING_X * 2, height: rb - ry });
      }

      // M7.8-FIX：兜底覆盖「被替换子串的原始位置」。当一行被编辑、但原 PDF 文本算子既无法
      // 被剥离（provenance 缺失）也无法被 native replay 原位替换（字体子集缺口）时，旧文字
      // 仍残留在 content stream 中。此时上方逐字形 mask 只覆盖「新文本」位置，可能漏掉旧文本
      // （重影）。editedOriginalBounds 记录各段被替换子串的原始 bbox（由 mutateLineText 累加捕获），
      // 把它们作为额外 mask 矩形并入，即可盖住旧文本。水平只覆盖被替换的列内区域（不会误擦列间
      // 竖线），垂直被 lineMaskTop/Bottom 钳制（不会擦掉上下表格线）。
      if ((line.glyphs.some((g) => g.modified) || line.edited) && line.editedOriginalBounds?.length) {
        for (const ob of line.editedOriginalBounds) {
          const rx = ob.x - MASK_PADDING_X;
          const ry = Math.max(lineMaskTop, ob.y - MASK_PADDING_Y);
          const rb = Math.min(lineMaskBottom, ob.y + ob.height + MASK_PADDING_Y);
          if (rb > ry) {
            rawRects.push({ x: rx, y: ry, width: ob.width + MASK_PADDING_X * 2, height: rb - ry });
          }
        }
      }

      // 合并水平相邻/重叠的 mask，减少 PDF 小矩形数量。
      rawRects.sort((a, b) => a.x - b.x);
      for (const r of rawRects) {
        const last = maskRects[maskRects.length - 1];
        if (
          last &&
          r.x <= last.x + last.width + 2 && // 水平间距 ≤ 2px 视为连续文本
          Math.abs(r.y - last.y) < 0.5 &&
          Math.abs(r.y + r.height - last.y - last.height) < 0.5
        ) {
          const newX = Math.min(last.x, r.x);
          const newY = Math.min(last.y, r.y);
          const newR = Math.max(last.x + last.width, r.x + r.width);
          const newB = Math.max(last.y + last.height, r.y + r.height);
          last.x = newX;
          last.y = newY;
          last.width = newR - newX;
          last.height = newB - newY;
        } else {
          maskRects.push({ ...r });
        }
      }
    } else if (realBox) {
      // 保底：无 glyph 墨迹时回退编辑态真实墨迹盒（加安全 padding 覆盖 AA 边缘）
      maskRects = [{
        x: realBox.x - MASK_PADDING_X,
        y: realBox.y - MASK_PADDING_Y,
        width: realBox.width + MASK_PADDING_X * 2,
        height: realBox.height + MASK_PADDING_Y * 2,
      }];
    } else {
      const fb = fbBox ?? block.originalBounds;
      if (fb) maskRects = [{ x: fb.x, y: fb.y, width: fb.width, height: fb.height }];
    }

    // ── OCR/扫描件补遮罩：把 mask 横向延伸到「真实墨迹范围」──
    // 上面 mask 是**逐 glyph** 生成的（设计目的：保留 glyph 之间的表格竖线）。
    // 副作用：没有 glyph 的位置不会产生任何遮罩。而 OCR 段落的原文真实墨迹常常
    // 超出新文字范围（OCR bbox 偏窄 / OCR 把原文断行读错，本例原文行1 墨迹到
    // pt 1769，而新文字只到 pt 1506）→ 原文尾部漏出（用户报告：残留 "balho, a"、
    // 原文行与新文本行同时显示）。realBox（editedLineBoxes 的真实墨迹盒）虽已并入
    // inkMinX/inkMaxX，但逐 glyph 分支不使用它，故此处显式延伸首/末 mask。
    // 仅对 RECONSTRUCT（OCR 段落）生效：原生文本 / 表格路径完全不受影响，
    // 避免重蹈「mask 横向膨胀擦掉表格线」的回归。
    if (realBox && mode === "reconstruct" && maskRects.length > 0) {
      const needLeft = inkMinX - MASK_PADDING_X;
      const needRight = inkMaxX + MASK_PADDING_X;
      const firstRect = maskRects[0];
      const lastRect = maskRects[maskRects.length - 1];
      if (firstRect.x > needLeft) {
        const dx = firstRect.x - needLeft;
        firstRect.x = needLeft;
        firstRect.width += dx;
      }
      if (lastRect.x + lastRect.width < needRight) {
        lastRect.width = needRight - lastRect.x;
      }
    }

    for (const rect of maskRects) {
      const pdfRect = cssToPdf(rect, ctx);
      commands.push({
        type: "drawLine",
        pageIndex,
        x: pdfRect.x,
        y: pdfRect.y,
        width: pdfRect.width,
        height: pdfRect.height,
        purpose: "mask",
        blockId: block.id,
        lineIndex: li,
      } as DrawLineCommand);
    }

    const lineStyle = resolveLineStyle(line, styles);
    // M7.7-010 Audit-4: 导出时该行的完整 style runs
    const exportStyleRuns: { styleRef: number; text: string; fontWeight: number | string }[] = [];
    let exportRun: { styleRef: number; text: string; fontWeight: number | string } | null = null;
    for (const g of line.glyphs) {
      const ref = g.styleRef ?? 0;
      const st = styles[ref];
      const fw = st?.fontWeight ?? "?";
      if (!exportRun || exportRun.styleRef !== ref) {
        if (exportRun) exportStyleRuns.push(exportRun);
        exportRun = { styleRef: ref, text: g.char, fontWeight: fw };
      } else {
        exportRun.text += g.char;
      }
    }
    if (exportRun) exportStyleRuns.push(exportRun);
    if (exportStyleRuns.length > 1) {
      console.log(`[M7.7-010][EXPORT_GLYPH_STYLE] lineIdx=${li} runs=${exportStyleRuns.length}:`, exportStyleRuns.map(r => `[styleRef=${r.styleRef} fontWeight=${r.fontWeight}] "${r.text.substring(0, 50)}"`));
    }
    // M7.8-034 Phase C: 重绘集合 = 整行，与 mask 范围严格一致（避免前缀叠画重影）。
    // Phase C 会接管：以行首 pdfTransform 为基准、原字体 + raw CID + native advance 重建。
    for (const glyph of line.glyphs) {
      // PRESERVE 模式用 originalBBox，RECONSTRUCT 用 bbox
      const bbox =
        mode === "preserve" && glyph.originalBBox
          ? glyph.originalBBox
          : glyph.bbox;

      const pdfRect = cssToPdf(bbox, ctx);
      const glyphStyle = styles[glyph.styleRef] || lineStyle;
      const fontSizePt = fontSizeCssToPt(
        glyphStyle.fontSize || 14,
        ctx
      );

      // 根因修复：导出文字基线必须用 glyph 的真实 baseline（与 native replay /
      // 编辑器预览完全一致），不能用 cssToPdf 之后的 bbox 顶部 (g.y+g.height)，
      // 否则被编辑行整体向上偏移约一个行高，侵占上一行。
      // 公式与 cssToPdf 同源：baselinePdfY = flipBase - baseCssY/totalScale，
      // 用 pdfRect.y 反推以保证与 bbox 转换自洽（含 MediaBox.y0、scale 等）。
      const totalScale = ctx.renderScale * ctx.cssScale;
      const baseCssY =
        typeof glyph.baseline === "number" && Number.isFinite(glyph.baseline)
          ? glyph.baseline
          : bbox.y + bbox.height; // 兜底：bbox 底部近似 baseline
      const baselinePdfY = pdfRect.y + (bbox.y + bbox.height - baseCssY) / totalScale;

      // ── M7.8-036 / BUG-COORD-Y-ROOT-001 只读诊断（临时，判 A/B 用，不改变任何业务逻辑）──
      if (typeof console !== "undefined") {
        console.log("[YDIAG]", {
          char: glyph.char,
          pdfTransform: glyph.metrics?.pdfTransform,
          pdfTransform5: glyph.metrics?.pdfTransform?.[5],
          baseline: glyph.baseline,
          bboxY: glyph.bbox.y,
          bboxHeight: glyph.bbox.height,
          pdfY: (glyph as any).pdfY,
          commandBaseline: baselinePdfY,
        });
      }

      commands.push({
        type: "drawTextGlyph",
        pageIndex,
        char: glyph.char,
        x: pdfRect.x,
        y: pdfRect.y,
        width: pdfRect.width,
        height: pdfRect.height,
        baseline: baselinePdfY,
        fontSize: fontSizePt,
        fontFamily:
          // M7.8-024: 优先使用 PDF 原始字体名，使 export 阶段 Standard 14 映射更贴近原 PDF。
          glyphStyle.pdfFontName ||
          glyphStyle.pdfjsFontFamily ||
          glyphStyle.fontFamily ||
          "'Arial','Helvetica','SimSun','Noto Serif CJK SC',sans-serif",
        fontWeight: glyphStyle.fontWeight || "normal",
        fontStyle: glyphStyle.fontStyle || "normal",
        color: glyphStyle.color || "#000000",
        blockId: block.id,
        lineIndex: li,
        modified: glyph.modified,
        transform: glyph.transform,
        // M7.5-005A：Native Model 透传（不消费，仅让 Export pipeline 看见原字体/矩阵/度量）
        // M7.8-035-FIX：优先读 glyph 顶层的 fontIdentity / pdfCharCode（导入时由
        // 原 PDF object graph 直接写入），metrics 作为兼容回退。
        fontIdentity: glyph.fontIdentity ?? glyph.metrics?.fontIdentity,
        pdfCharCode: glyph.pdfCharCode ?? glyph.metrics?.pdfCharCode,
        pdfTransform: glyph.metrics?.pdfTransform,
        glyphMetrics: glyph.metrics,
      } as DrawTextGlyphCommand);
    }
    // ── M7.8-024 Step B: 编辑行 mask 若与邻行墨迹真实重叠，用原嵌入字体重绘受影响邻行 ──
    // 不写死 N+1：以 analyzeMaskImpact 的几何相交结果为准（spec §4.1）。
    {
      const impact = analyzeMaskImpact(bands, li);
      for (const aj of impact.affectedLineIndices) {
        if (aj === li) continue;
        const nLine = block.lines[aj];
        if (!nLine || nLine.glyphs.length === 0) continue;
        const nStyleRef = nLine.glyphs[0].styleRef ?? 0;
        const nStyle = styles[nStyleRef] || lineStyle;
        for (const glyph of nLine.glyphs) {
          const nb = mode === "preserve" && glyph.originalBBox ? glyph.originalBBox : glyph.bbox;
          const npdf = cssToPdf(nb, ctx);
          commands.push({
            type: "drawTextGlyph",
            pageIndex,
            char: glyph.char,
            x: npdf.x,
            y: npdf.y,
            width: npdf.width,
            height: npdf.height,
            fontSize: fontSizeCssToPt(nStyle?.fontSize || 14, ctx),
            // M7.8-024: 优先使用 PDF 原始字体名，保持邻行重绘与原 PDF 一致。
            fontFamily: nStyle?.pdfFontName || nStyle?.pdfjsFontFamily || nStyle?.fontFamily || "'Arial','Helvetica',sans-serif",
            fontWeight: nStyle?.fontWeight || "normal",
            fontStyle: nStyle?.fontStyle || "normal",
            color: nStyle?.color || "#000000",
            blockId: block.id,
            lineIndex: aj,
            modified: false,
            transform: glyph.transform,
            fontIdentity: glyph.metrics?.fontIdentity,
            pdfTransform: glyph.metrics?.pdfTransform,
            glyphMetrics: glyph.metrics,
          } as DrawTextGlyphCommand);
        }
      }
    }
  }

  // ── Sprint34.7.1 Trace: 阶段 3 — Export layout 计算后 finalLines ──
  if (typeof console !== "undefined") {
    // 按 lineIndex 归纳出 finalLines（line boundary 是否在此阶段丢失）
    const byLine = new Map<number, DrawTextGlyphCommand[]>();
    for (const c of commands) {
      if (c.type !== "drawTextGlyph") continue;
      const li = c.lineIndex ?? 0;
      const arr = byLine.get(li) || [];
      arr.push(c);
      byLine.set(li, arr);
    }
    console.log(
      `%c[Sprint34.7.1][ExportLayout] blockId=${block.id} finalLines=${byLine.size}`,
      "font-weight:bold;color:#f59e0b;",
    );
    const sorted = [...byLine.entries()].sort((a, b) => a[0] - b[0]);
    for (const [li, cmds] of sorted) {
      const text = cmds.map((c) => c.char).join("");
      const minX = Math.min(...cmds.map((c) => c.x));
      const maxX = Math.max(...cmds.map((c) => c.x + c.width));
      const y = Math.min(...cmds.map((c) => c.y));
      console.log(
        `  line${li}: "${text}" x=${Math.round(minX)} xEnd=${Math.round(maxX)} y=${Math.round(y)} glyphs=${cmds.length}`,
      );
    }
  }

  // C2B-2C-2（M7.7-004A）：过滤已内联到逐行导出（native-ready / 未触碰行不再产出任何命令）
  return commands;
}

// ── Sprint 33.5.6: Signature Export ──

/**
 * 对坐标应用旋转变换。
 * 以 (originX, originY) 为中心旋转一个点。
 * 注意：坐标在 PDF pt 空间（Y 向上已翻转完成）。
 */
function rotatePoint(
  px: number,
  py: number,
  originX: number,
  originY: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - originX;
  const dy = py - originY;
  return {
    x: originX + dx * cos - dy * sin,
    y: originY + dx * sin + dy * cos,
  };
}

/**
 * Sprint 33.5.6: 把 SignatureRegion 转换为导出命令。
 *
 * 坐标处理：
 *   1. 父 bbox 的左上角 → PDF pt 原点（originX, originY）
 *   2. 子元素 offsetX/offsetY → PDF pt 局部坐标
 *   3. 旋转矩阵应用于局部坐标
 *   4. 输出绝对坐标的 ExportCommand（writeExportCommandsToPDF 不需要特殊处理）
 *
 * 这样每个 glyph 都是旋转后的精确 PDF 坐标，无需 pdf-lib push/pop。
 */
function renderSignatureRegionToExportCommands(
  region: SignatureRenderRegion,
  doc: EditableDocument,
  ctx: ExportContext,
): ExportCommand[] {
  const commands: ExportCommand[] = [];
  const { bbox, rotation, children, sourceBlockIds } = region;

  // Task-W2-3B Trace：记录 Export 签名区 rotation（来自 sigRegions，即 signatureRotationRef）
  console.log(
    `[SignatureRotationTrace] Stage:Export RegionId:${region.id} ` +
      `sigRegionRotation:${rotation ?? 0} sourceBlockIds:[${sourceBlockIds?.join(",")}]`,
  );

  // 父 bbox 左上角 → PDF pt
  const totalScale = ctx.renderScale * ctx.cssScale;
  const originPdf = cssToPdf({ x: bbox.x, y: bbox.y, width: 0, height: 0 }, ctx);

  for (const child of children) {
    // Child 局部坐标（CSS px）→ PDF pt
    const localPtX = child.offsetX / totalScale;
    const localPtY = -child.offsetY / totalScale; // Y flip: CSS top-down → PDF bottom-up

    // Sprint34.14: 统一旋转中心为 originalBounds center（与 mask 一致）。
    // 之前 rotatePoint 绕 block 左上角（originPdf）旋转，而 mask（calculateReplacementMaskBounds）
    // 绕 originalBounds center 旋转，导致长文本（Dr. Jefferson）文字与 mask 错位露边。
    // 现在改为绕 originalBounds center 旋转，使文字起点绕 center 旋转 + 字形 rotate，
    // 整段文字等效于绕 center 旋转，与 mask 几何一致。
    const srcBlock = doc.pages[region.pageIndex]?.blocks.find(b => b.id === child.sourceBlockId);
    const pivotCss = srcBlock?.originalBounds
      ? srcBlock.originalBounds
      : { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
    // Sprint34.15: 统一用 pivotOfBounds（= originalBounds center）作为旋转 pivot，
    // 与 Editor 的 SignatureTransformContext pivot 完全一致，避免双坐标系漂移。
    const pivot = pivotOfBounds(pivotCss);
    const centerX = pivot.x;
    const centerY = pivot.y;
    const centerPdf = cssToPdf({ x: centerX, y: centerY, width: 0, height: 0 }, ctx);

    // 旋转
    // Sprint34.9: rotation 是 CSS 系角度（顺时针为正），rotatePoint 是 PDF Y-up 逆时针公式，
    // 需做符号转换（-rotation），否则导出倾斜方向相反（Layout/Render 正常、Export 反）。
    const pdfRotation = -rotation;
    const rotated = rotation !== 0
      ? rotatePoint(
          originPdf.x + localPtX,
          originPdf.y + localPtY,
          centerPdf.x,
          centerPdf.y,
          pdfRotation,
        )
      : { x: originPdf.x + localPtX, y: originPdf.y + localPtY };

    // Sprint34.15 Debug: 输出 Export 签名文字 pivot（originalBounds center）与旋转后起点
    if (typeof console !== "undefined") {
      const t = child.text.substring(0, 30);
      console.log(
        `%c[Sprint34.15][ExportGlyphPivot] text="${t}" rot=${rotation} ` +
        `pivotCenter=(x=${centerX.toFixed(1)},y=${centerY.toFixed(1)}) ` +
        `startBefore=(x=${originPdf.x.toFixed(1)},y=${originPdf.y.toFixed(1)}) ` +
        `startAfter=(x=${rotated.x.toFixed(1)},y=${rotated.y.toFixed(1)})`,
        "color:#f59e0b;",
      );
    }

    const fontSizePt = child.font.size / totalScale;
    const blockId = child.sourceBlockId || region.id;
    const childWidth = (bbox.width / totalScale) * 0.95;

    if (/[^\x00-\x7F]/.test(child.text)) {
      // CJK → PNG export (will be handled by writeExportCommandsToPDF)
      // We pass the rotated coordinates so the image is placed correctly
      commands.push({
        type: "drawTextGlyph",
        pageIndex: region.pageIndex,
        char: child.text,
        x: rotated.x,
        y: rotated.y,
        width: childWidth,
        height: fontSizePt,
        fontSize: fontSizePt,
        fontFamily: child.font.family,
        fontWeight: "normal",
        fontStyle: "normal",
        color: "#000000",
        blockId,
        modified: false,
        transform: undefined,
        rotation: region.rotation,
      } as DrawTextGlyphCommand);
    } else {
      // ASCII
      commands.push({
        type: "drawTextGlyph",
        pageIndex: region.pageIndex,
        char: child.text,
        x: rotated.x,
        y: rotated.y,
        width: childWidth,
        height: fontSizePt,
        fontSize: fontSizePt,
        fontFamily: child.font.family,
        fontWeight: "normal",
        fontStyle: "normal",
        color: "#000000",
        blockId,
        modified: false,
        transform: undefined,
        rotation: region.rotation,
      } as DrawTextGlyphCommand);
    }
  }

  // Mask the source blocks' original bounds
  // Sprint34.13: mask 用真实旋转矩形的 bounding box（calculateReplacementMaskBounds），
  // 与 Editor 共用同一几何逻辑，确保 rotation 后的完整文字区域被覆盖。
  for (const blockId of sourceBlockIds) {
    const block = doc.pages[region.pageIndex]?.blocks.find(b => b.id === blockId);
    if (block?.originalBounds) {
      // FID-010：Coverage 与 Rotation 职责分离，与 Editor 共用同一 Coverage 来源。
      const coverageBounds = resolveVisualCoverageBounds(block.originalBounds);
      const maskBounds = calculateReplacementMaskBounds({
        originalBounds: coverageBounds,
        rotation: region.rotation,
      });
      const maskRect = cssToPdf(maskBounds, ctx);
      // Sprint34.13 Debug: 输出 Export mask geometry（original → expanded，CSS + PDF pt）
      if (typeof console !== "undefined") {
        const ob = block.originalBounds;
        console.log(
          `%c[Sprint34.13][ExportMaskGeometry] id=${blockId} rot=${region.rotation} ` +
          `original=(x=${ob.x.toFixed(1)},y=${ob.y.toFixed(1)},w=${ob.width.toFixed(1)},h=${ob.height.toFixed(1)}) ` +
          `expanded=(x=${maskBounds.x.toFixed(1)},y=${maskBounds.y.toFixed(1)},w=${maskBounds.width.toFixed(1)},h=${maskBounds.height.toFixed(1)}) ` +
          `pdf=(x=${maskRect.x.toFixed(1)},y=${maskRect.y.toFixed(1)},w=${maskRect.width.toFixed(1)},h=${maskRect.height.toFixed(1)})`,
          "color:#a855f7;",
        );
      }
      commands.push({
        type: "drawLine",
        pageIndex: region.pageIndex,
        x: maskRect.x,
        y: maskRect.y,
        width: maskRect.width,
        height: maskRect.height,
        purpose: "mask",
        blockId,
      } as DrawLineCommand);
    }
  }

  return commands;
}

/**
 * 渲染整个文档 → ExportCommand[]
 */
export function renderDocumentToExportCommands(
  doc: EditableDocument,
  ctx: ExportContext,
  signatureRegions?: SignatureRenderRegion[],
  /** M7.7-006: 编辑态真实墨迹覆盖盒（lineId → CSS bbox），透传给逐行 mask。 */
  editedLineBoxes?: Map<string, BBox>,
): ExportCommand[] {
  const commands: ExportCommand[] = [];

  // Sprint 33.5.6: 收集所有签名区域的 blockId，跳过它们的普通渲染
  const sigBlockIds = new Set<string>();
  if (signatureRegions && signatureRegions.length > 0) {
    for (const sr of signatureRegions) {
      for (const id of sr.sourceBlockIds) {
        sigBlockIds.add(id);
      }
    }
  }

  for (let pi = 0; pi < doc.pages.length; pi++) {
    const page = doc.pages[pi];
    const pageCtx: ExportContext = {
      ...ctx,
      ...pageFlipBase(page, ctx),
    };
    for (const block of page.blocks) {
      if (block.type !== "text") continue;
      // Sprint 33.5.6: Skip signature blocks (rendered separately)
      if (sigBlockIds.has(block.id)) continue;

      // ── Sprint34.7.1 Trace: 阶段 1 — EditableDocument 原始数据 ──
      if (typeof console !== "undefined") {
        const blockText = block.lines
          .map((l) => l.glyphs.map((g) => g.char).join(""))
          .join("\n");
        console.log(
          `%c[Sprint34.7.1][EditableDocument] blockId=${block.id} text="${blockText.substring(0, 80)}"`,
          "font-weight:bold;color:#0ea5e9;",
        );
        console.log(
          `  lines=${block.lines.length} lineBoundaryGlyphCounts=[${block.lines.map((l) => l.glyphs.length).join(",")}]`,
        );
        block.lines.forEach((l, i) => {
          const t = l.glyphs.map((g) => g.char).join("");
          console.log(`    line${i}: "${t}" y=${l.bbox.y} h=${l.bbox.height}`);
        });
      }

      commands.push(
        ...renderBlockToExportCommands(block, doc.styles, pageCtx, pi, editedLineBoxes, page.blocks),
      );
    }
  }

  // Sprint 33.5.6: Render signature regions with rotation
  if (signatureRegions && signatureRegions.length > 0) {
    for (const region of signatureRegions) {
      const page = doc.pages[region.pageIndex];
      if (!page) continue;
      const pageCtx: ExportContext = {
        ...ctx,
        ...pageFlipBase(page, ctx),
      };
      commands.push(
        ...renderSignatureRegionToExportCommands(region, doc, pageCtx),
      );
    }
  }

  return commands;
}

/**
 * Task 2: 把 ExportCommand[] 写入 PDF（通过 pdf-lib）
 *
 * 写入顺序：
 *   1. mask 矩形（白色遮盖）
 *   2. text glyphs（文字内容）
 *   3. images（图片）
 *   4. redactions（涂黑）
 *
 * 文字写入策略：
 *   - ASCII 字符：page.drawText（矢量）
 *   - 非 ASCII 字符（中文等）：Canvas→PNG→embedPng（位图）
 *
 * @param pdf pdf-lib PDFDocument
 * @param commands ExportCommand[]
 * @param pageOffsets 每页的 y 偏移（页码 → 页面高度 pt）
 */
// ─────────────────────────────────────────────────────────────────────────────
// M7.8-034 Phase C: Native Line Rebuild
//
// 目标：编辑后的行也必须用**原嵌入字体**导出，而不是回落到 Standard 14 或 PNG。
// 手段（用户明确的四要素）：
//   1. 原字体        → fontRef 直接引用原 PDF 的字体资源，不重新嵌入、不 subset
//   2. raw CID       → 逐字符经原字体 ToUnicode 反查得到码位（Type0 2 字节 / simple 1 字节）
//   3. native advance   → 取原字体 Widths 表中的 native advance（fontSize=1 单位，PDF pt）
//   4. 原 baseline   → 行基准 transform 的 f 分量原样保留（无旋转时 f 恒定不漂移）
//
// 与 M7.8-033 RAW-CID Replay 的区别：
//   M7.8-033 要求 glyphs.every(g => !g.modified)，即**只能回放未修改的行**；
//   编辑过的行会整体回落到 drawText（Standard 14）→ 字体/字宽全变（用户报告的导出失真）。
//   Phase C 改为：只要本行所有字符都能在原字体中解析出码位与 advance，就整行原生重建，
//   无论是否含被编辑字符。文本长度自然变化，字体/字号/旋转/baseline 一律不动。
//
// 安全边界：任何一步拿不到数据即返回 false，调用方回落到既有路径（行为零变化）。
// ─────────────────────────────────────────────────────────────────────────────

// M7.8-035-FIX：旧 Phase C 的 page 级字体度量缓存 / 查找 / CID codec 三件套已移除。
// 它们只服务于「字体必须在 page /Resources/Font 里」这一错误前提；
// 真实 PDF 的 Type3 字体常驻 Form XObject，page 级度量恒为空 → 原生路径 100% 失败。
// 现在统一以 collectFontResources（递归 Form XObject）为准，见 tryNativeLineReplay。

/**
 * M7.8-035-FIX · Native Replay 结果。
 *
 * handled=true  → 该行已用「原字体 + 原始 charCode + 原 Tm」写入，**调用方必须 continue**。
 * handled=false → 原生路径未完全覆盖，reason 说明原因；
 *                 isType3Line 为真时调用方**禁止**走 drawText/Helvetica 回退（用户明确要求）。
 */
type NativeReplayResult = {
  handled: boolean;
  /** 该行（首个能解析出身份的 glyph）是否为 Type3 —— Type3 禁止 Helvetica 回退 */
  isType3Line: boolean;
  reason: string;
};

/** 判断两个 transform 是否相同（同一 Tj 文本块） */
function sameTransform(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-3) return false;
  return true;
}

/** 取 glyph 的字体身份（顶层优先，metrics 兼容回退） */
function glyphFontIdentityOf(g: DrawTextGlyphCommand): GlyphFontIdentity | undefined {
  return g.fontIdentity ?? g.glyphMetrics?.fontIdentity;
}

/** 取 glyph 的原始 Tm（文本块级矩阵，含 fontSize 缩放与平移，PDF pt 域） */
function glyphTransformOf(g: DrawTextGlyphCommand): number[] | null {
  const t = g.glyphMetrics?.pdfTransform;
  return Array.isArray(t) && t.length === 6 && t.every((n) => typeof n === "number" && Number.isFinite(n))
    ? (t as number[])
    : null;
}

/** Type0/Identity-H 用 2 字节码，其余（Type3/Type1/TrueType）用 1 字节 */
function hexLenFor(subtype: string | undefined): number {
  return subtype === "Type0" ? 4 : 2;
}

/**
 * M7.8-035-FIX · 原生重放整行。
 *
 * 与旧 tryNativeLineRebuild 的三处关键差异（都是本次真实 PDF 的致命缺陷）：
 *   1. **不再依赖 page 级字体度量表**。旧实现要求 `parsePdfFontMetrics` 里存在该字体，
 *      而本 PDF 的 /F5…/F12 全部挂在 Form XObject /Resources 下，page 级 /Font 为空
 *      → 旧实现 100% 失败 → 回落 drawText → Helvetica。
 *      现在直接以原 PDF object graph（collectFontResources，递归 Form）为准。
 *   2. **逐 glyph 用自己的字体身份**。旧实现整行共用首个 glyph 的 fontRef 与
 *      unicodeToCharCode；而真实行常跨字体（本 PDF 一行里 /F8 单词 + /F9 标点 + /F10 '/'），
 *      用同一张表查码会把 'a' 查成别的字形的码位。
 *   3. **禁止 Helvetica 回退**。Type3 行里某个字符无法编码时，先在同页其它同族字体里找
 *      原生字形；仍找不到则丢弃该字符并告警，**绝不**交给 page.drawText。
 *
 * 位置来源固定为 glyph.metrics.pdfTransform —— pdf.js 给出的文本块矩阵（PDF 用户空间，
 * d 恒正）。原样作为 Tm 写出即可像素级复现原 baseline / 字号 / 起始 x。
 */
function tryNativeLineReplay(
  page: PDFPage,
  pdf: PDFDocument,
  pageIndex: number,
  glyphs: DrawTextGlyphCommand[],
): NativeReplayResult {
  const first = glyphs[0];
  const firstIdent = glyphFontIdentityOf(first);
  const isType3Line = firstIdent?.subtype === "Type3";

  // 资源表（递归 page + Form XObject）—— 原生重放的唯一事实来源
  let resources: ReturnType<typeof collectFontResources>;
  try {
    resources = collectFontResources(pdf, pageIndex);
  } catch (e) {
    return { handled: false, isType3Line, reason: `collectFontResources failed: ${(e as Error).message}` };
  }
  const entryFor = (fr: string): PdfFontResource | undefined => {
    const bare = fr.replace(/^\//, "");
    return resources.get(bare) ?? resources.get(`/${bare}`) ?? resources.get(fr);
  };

  // ── 逐 glyph 解析：Tm + fontRef + charCode ──
  // runs 按 (fontRef, Tm) 分组：同一文本块（Tj）内的字符由字体自身宽度推进，
  // 绝不按 advance 手动累积（M7.8-034 已实测：手动累积最大误差 87.2pt）。
  type Run = { fontRef: string; base: number[]; hexParts: string[] };
  const runs: Run[] = [];
  let cur: Run | null = null;
  let anyNative = false;
  let hasIdentifiableGlyph = false;
  let unrecoverable = false; // 非 Type3 字符在子集/同族中都无原生字形
  const dropped: string[] = [];

  for (const g of glyphs) {
    const ident = glyphFontIdentityOf(g);
    if (ident?.fontRef) hasIdentifiableGlyph = true;
    const tm = glyphTransformOf(g);
    const fontRefRaw = ident?.fontRef;
    if (!tm || !fontRefRaw) {
      // M7.9-REPLAY-DROP-DIAG：这里是「导出文字比输入少字」的唯一静默丢弃点。
      // 只打日志，不改变任何行为 —— 用于定位某个 glyph 为何丢了 pdfTransform / fontRef。
      if (typeof console !== "undefined") {
        console.warn(
          "[NATIVE_REPLAY_DROP] char=" +
            JSON.stringify(g.char) +
            " missing=" +
            (!tm ? "pdfTransform" : "fontIdentity.fontRef") +
            " modified=" +
            String(g.modified) +
            " originalChar=" +
            JSON.stringify(g.originalChar ?? null) +
            " hasMetrics=" +
            String(!!g.glyphMetrics) +
            " hasFontIdentity=" +
            String(!!g.fontIdentity) +
            " metricsFontIdentity=" +
            String(!!(g.glyphMetrics as { fontIdentity?: unknown } | undefined)?.fontIdentity),
        );
      }
      dropped.push(g.char);
      continue;
    }
    const fontRef = fontRefRaw.replace(/^\//, "");

    // ⑤ 字符必须使用原始 charCode，绝不经 Unicode→font.encodeText()
    let code: number | undefined;
    if (!g.modified) {
      const raw = g.pdfCharCode ?? g.glyphMetrics?.pdfCharCode;
      if (typeof raw === "number") code = raw;
    }
    // 编辑但字符未变（仅改样式/重绘/局部替换）：直接用原始 charCode。
    // 这能绕过「子集字体声明编码与真实码位不符」导致的乱码（如 TT1/TimesNewRoman 子集），
    // 也避免无 /ToUnicode 的子集字体把整行字符误丢 → 导出后整行消失。
    if (code === undefined && g.modified && g.char === g.originalChar) {
      const raw = g.pdfCharCode ?? g.glyphMetrics?.pdfCharCode;
      if (typeof raw === "number") code = raw;
    }
    if (code === undefined) {
      // 编辑过且字符确实变化的：用该字体自己的 /ToUnicode 反查表，
      // 仍失败则在同页同族字体中找原生字形（findFontForChar）。
      code = ident?.unicodeToCharCode?.get(g.char);
    }
    if (code === undefined) {
      // 该字符不在本字体子集里 → 在同页同族字体中找原生字形（仍然不走 Helvetica）
      const alt = findFontForChar(pdf, pageIndex, g.char, {
        subtype: ident?.subtype,
        baseFont: ident?.baseFont ?? ident?.fontName,
      });
      if (alt) {
        const altRef = alt.resourceName.replace(/^\//, "");
        if (!cur || cur.fontRef !== altRef || !sameTransform(cur.base, tm)) {
          cur = { fontRef: altRef, base: tm, hexParts: [] };
          runs.push(cur);
        }
        cur.hexParts.push(alt.charCode.toString(16).padStart(hexLenFor(ident?.subtype), "0"));
        anyNative = true;
        continue;
      }
      // 该字符在本字体子集及同族字体中都无原生字形。
      // Type3 行：禁止 Helvetica 回退（避免画错字体图形），只能丢弃。
      // 非 Type3 行：绝不能丢弃 → 标记后整行交给调用方的 overlay 绘制兜底，
      // 否则编辑含重音/子集字体的行时整行文字会凭空消失。
      if (isType3Line) {
        dropped.push(g.char);
      } else {
        unrecoverable = true;
      }
      continue;
    }

    if (!cur || cur.fontRef !== fontRef || !sameTransform(cur.base, tm)) {
      cur = { fontRef, base: tm, hexParts: [] };
      runs.push(cur);
    }
    cur.hexParts.push(code.toString(16).padStart(hexLenFor(ident?.subtype), "0"));
    anyNative = true;
  }

  if (!anyNative) {
    return {
      handled: false,
      isType3Line,
      reason: hasIdentifiableGlyph
        ? "no glyph could be encoded with its original font"
        : "no fontIdentity.fontRef on any glyph (provenance missing)",
    };
  }
  // 非 Type3 行若有字符无法用原生字体编码，整行交给 overlay 绘制兜底（Helvetica/系统字体），
  // 避免「部分字符 emit 成功就返回 handled=true、其余字符被丢弃」导致整行文字凭空消失。
  if (unrecoverable) {
    return {
      handled: false,
      isType3Line,
      reason: "non-Type3 line has glyphs missing from subset; fall back to overlay drawing",
    };
  }

  // ④ 字体资源提升：把**实际用到**的字体从 Form Resources 提到 page /Resources。
  //    原生重放的算子追加在 page 级内容流（非 Form XObject 内），必须保证 /F3+0 这类
  //    仅存在于 Form /Resources 的嵌入字体在 page 级可见，否则 Tf 引用不到字体 → 文字不渲染（空白）。
  //    （M7.8-041 实测：该 PDF 字体挂在 Form 下、page 级 /Font 为空，仅提升 Type3 会导致
  //      TrueType 子集行的编辑文字凭空消失。故对任意 subtype 都提升，已存在则幂等跳过。）
  try {
    for (const r of runs) {
      const entry = entryFor(r.fontRef);
      if (entry) elevateType3Font(pdf, pageIndex, r.fontRef);
    }
  } catch (e) {
    return { handled: false, isType3Line, reason: `elevate Type3 failed: ${(e as Error).message}` };
  }

  // 原 PDF 的文本状态（Tc / Tw / Tz）—— 不恢复会导致字距与原文不符
  const ts = first?.glyphMetrics;
  const textState = {
    charSpacing: ts?.charSpacing ?? 0,
    wordSpacing: ts?.wordSpacing ?? 0,
    horizontalScale: ts?.horizontalScale ?? 1,
    fontSize: ts?.fontSize,
  };
  // M7.8-041-FIX-INVIS：原生重放必须显式设填充色，否则继承图形状态残留的白色填充
  // （原 PDF 末笔白底/白块）→ 编辑行文字画成白底白字而消失。
  // 用编辑行文字色；但若颜色缺失或为白（极可能原 PDF 未设色/白字），强制黑色以保证可见。
  const rawColor = hexToRgb(first.color);
  const fillColor =
    rawColor && rawColor.r + rawColor.g + rawColor.b > 0.05 ? rawColor : { r: 0, g: 0, b: 0 };

  try {
    for (const run of runs) {
      const hex = run.hexParts.join("");
      if (!hex) continue;
      emitNativeTextRun(page, run.fontRef, run.base as TransformMatrix, hex, textState, fillColor);
    }
  } catch (e) {
    return { handled: false, isType3Line, reason: `emit failed: ${(e as Error).message}` };
  }

  if (dropped.length > 0) {
    console.warn(
      `[M7.8-035-FIX][NATIVE_REPLAY] 行内 ${dropped.length} 个字符在原字体中没有字形，已按` +
        `「禁止 Helvetica 回退」丢弃（原字体为子集字体，无法表示这些字符）: ` +
        JSON.stringify(dropped.slice(0, 16)),
    );
  }
  return { handled: true, isType3Line, reason: "ok" };
}

export async function writeExportCommandsToPDF(
  pdf: PDFDocument,
  commands: ExportCommand[],
  getPageHeight: (pageIndex: number) => number,
  nativeRouting?: NativeReplaceRouting,
  /**
   * M7.8-041-FIX-R4：整行原算子已被完全剥离的行（`blockId:lineIndex`）。
   * 这些行的旧文字已从 content stream 移除，**不需要白色 mask** ——
   * 画 mask 只会白白擦掉行内的表格线 / 边框线（用户报告表格线消失）。
   */
  fullyStrippedLines?: Set<string>,
): Promise<void> {
  // M7.8-024 Step B: 注册 fontkit 以支持原嵌入 CID 字体写回
  pdf.registerFontkit(fontkit);
  // C2B-2C-1：若提供 Native Replace Routing，则对已 native 替换的 block/line
  // 短路 overlay（白色 mask + 重新绘制文字），改由原 PDF content stream 的 native 文本承担。
  // 缺省（undefined）时行为完全不变（fallback overlay）。
  if (nativeRouting) {
    commands = filterOverlayForNativeReplaced(commands, nativeRouting);
  }
  const { textGlyphs, lines, images, redactions } = groupExportCommands(commands);
  // M7.8-022A: 入口计数诊断 —— 确认 commands 是否抵达本函数、以及 glyph/mask 各有多少。
  // 若本行出现但 [PDFdraw] 未出现，说明 textGlyphs 在此后被清空或未进入绘制循环。
  if (typeof console !== "undefined") {
    const byType = new Map<string, number>();
    for (const c of commands) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
    console.log(
      `[M7.8-022A][WRITE_ENTRY] commands=${commands.length} ` +
        `textGlyphs=${textGlyphs.length} lines=${lines.length} ` +
        `images=${images.length} redactions=${redactions.length} ` +
        `hasNativeRouting=${!!nativeRouting} ` +
        `types={${[...byType.entries()].map(([k, v]) => `${k}:${v}`).join(",")}}`,
      "color:#8b5cf6;font-weight:bold;",
    );
  }

  // Sprint39: 字体嵌入缓存 —— 同一字体只嵌入一次（避免为每行重复 embed，控制 PDF 体积与性能）。
  const fontCache = new Map<string, PDFFont>();
  // M7.8-024 Step B: 原嵌入 CID 字体缓存（按资源名，跨行累积子集、避免重复嵌入）
  const cidFontCache = new Map<string, PDFFont>();
  // M7.8-034 Phase C 的逐页度量缓存已移除（见 tryNativeLineReplay 注释）

  // 按页分组
  const byPage = new Map<number, ExportCommand[]>();

  // mask 矩形（白色遮盖）
  for (const cmd of lines) {
    const pageCommands = byPage.get(0) || [];
    pageCommands.push(cmd);
    byPage.set(0, pageCommands);
  }

  // M7.8-041-FIX-R3: 导出策略 —— 按行是否编辑分别处理。
  //
  //   未编辑行（无 modified glyph）：
  //     原 PDF 已包含正确的文字内容，无需任何修改。
  //     不画 mask、不画 overlay → 原 PDF 的文字和非文字元素（表格线/图形/边框）完整保留。
  //
  //   编辑行（含 modified glyph）：
  //     必须用新文本替换旧文本 → mask 擦除原文 + Standard 14 / PNG overlay 写入新文字。
  //
  // 执行顺序（重要！）：
  //   ① 行分类：识别编辑行（editedLineKeys）
  //   ② 画 mask（仅编辑行）
  //   ③ overlay（仅编辑行）

  // Sprint34.7: 按 blockId + lineIndex 分组 glyph，逐 line 导出，禁止 export 阶段重新 wrap。
  // 仅当 glyph 带 lineIndex 时逐行；否则回退到旧逻辑（整 block 拼接）。
  type LineKey = string; // "blockId:lineIndex"
  const lineGlyphs = new Map<LineKey, DrawTextGlyphCommand[]>();
  for (const cmd of textGlyphs) {
    const key = cmd.lineIndex !== undefined ? `${cmd.blockId}:${cmd.lineIndex}` : cmd.blockId;
    const arr = lineGlyphs.get(key) || [];
    arr.push(cmd);
    lineGlyphs.set(key, arr);
  }

  // ── Pass 1: 行分类（编辑 vs 未编辑）──
  // M7.8-041-FIX-R3: 核心策略变更 —— 未编辑行完全不处理。
  //
  //   未编辑行（无 modified glyph）：
  //     原 PDF 已包含正确的文字内容，无需任何修改。
  //     无论是 Phase C（原生重放）还是 overlay（Standard 14）都无法做到像素级一致，
  //     且 overlay 路径的 mask 会擦除非文字元素（表格线/图形/边框）→ 导致视觉缺陷。
  //     因此未编辑行直接跳过，保持原 PDF 内容不变。
  //
  //   编辑行（含 modified glyph）：
  //     必须用新文本替换旧文本 → 需要 mask 擦除原文 + overlay 写入新文字。
  //     统一走 Standard 14 / PNG overlay 路径（Phase C 对编辑行有 CID 编码风险）。
  //
  const editedLineKeys = new Set<LineKey>();
  let totalGlyphs = 0;
  let modifiedGlyphCount = 0;
  for (const [key, glyphs] of lineGlyphs) {
    if (glyphs.length === 0) continue;
    totalGlyphs += glyphs.length;
    const editedGlyphs = glyphs.filter((g) => g.modified);
    modifiedGlyphCount += editedGlyphs.length;
    const hasEdited = editedGlyphs.length > 0;
    if (hasEdited) editedLineKeys.add(key);
    if (typeof console !== "undefined" && hasEdited) {
      const skip = fullyStrippedLines?.has(key);
      console.log(`[M7.8-041-R3][EDITED_LINE] key="${key}" ${skip ? "fully stripped → skip mask (保留表格线)" : "will use overlay+mask"}`);
    }
  }
  if (typeof console !== "undefined") {
    console.log(
      `%c[M7.8-041-R3][DIAG] totalLines=${lineGlyphs.size} editedLines=${editedLineKeys.size} ` +
        `totalGlyphs=${totalGlyphs} modifiedGlyphs=${modifiedGlyphCount}`,
      "color:#ff00ff;font-weight:bold;",
    );
  }

  // M7.8-FIX：预扫描 —— 对编辑行提前尝试 native replay（tryNativeLineReplay 会**原位改写**
  // 原 PDF content stream 中对应行的文本算子）。成功（或 Type3 接管）的行，其旧文本已被
  // 原生流替换为新文本，因此：
  //   · 无需再画白色 mask（否则整行/整单元格白矩会覆盖该行的表格线 —— 用户报告 bug）；
  //   · 也无需再画 overlay（避免与已替换的文本重影 / 二次改写）。
  // 该扫描只执行一次（tryNativeLineReplay 含 write 副作用，不可重复调用）。
  const replayedKeys = new Set<LineKey>();
  for (const [key, glyphs] of lineGlyphs) {
    if (!editedLineKeys.has(key)) continue;
    const firstGlyph = glyphs[0];
    const pageIdxForLine = Math.min(firstGlyph.pageIndex ?? 0, pdf.getPageCount() - 1);
    const page = pdf.getPage(pageIdxForLine);
    // M7.8-042-REPLAY-NONEMBED：放开「仅嵌入字体/Type3」门禁。
    // 非嵌入字体（如 /FT8 SimSun）的原字体资源、编码、/ToUnicode 都在 PDF 里，
    // native replay 只是按原 charCode + 原 Tm 重写内容流 —— 与嵌入字体完全同构，
    // 由查看器的替换字体渲染，字距与原文一致。排除它导致整行回落 Helvetica overlay
    // → 字形宽于原字体 → 字符重叠「粘在一起」（用户报告的行内字距压缩根因）。
    // 安全性不变：未改动 glyph 用原始 charCode；改动 glyph 走 /ToUnicode 反查，
    // 失败 → findFontForChar → 仍失败 → unrecoverable → 整行回落 overlay（原行为）。
    const hasFontRef = !!firstGlyph.fontIdentity?.fontRef;
    const allHaveTransform = glyphs.every((g) => Array.isArray(g.glyphMetrics?.pdfTransform));
    if (hasFontRef && allHaveTransform) {
      const isEditedLine = glyphs.some((g) => g.modified);
      if (isEditedLine) {
        const replay = tryNativeLineReplay(page, pdf, pageIdxForLine, glyphs);
        if (typeof console !== "undefined") {
          console.log(
            `[M7.8-041-R4][NATIVE_REPLAY] key=${key} handled=${replay.handled} ` +
              `type3=${replay.isType3Line} reason=${replay.reason}`,
          );
        }
        if (replay.handled || replay.isType3Line) replayedKeys.add(key);
      }
    }
  }

  // ── 画 mask（仅编辑行需要擦除原文）──
  // 未编辑行不画 mask → 原 PDF 的非文字元素（表格线/图形/边框）完整保留。
  // 仅编辑行需要 mask 擦除旧文字，避免与 overlay 新文字产生重影。
  // 已 native replay 成功原位替换的行（replayedKeys）同样跳过 mask —— 旧文本已消失，
  // 再画 mask 只会白白擦掉该行的表格线。
  for (const cmd of lines) {
    const maskKey = cmd.lineIndex !== undefined ? `${cmd.blockId}:${cmd.lineIndex}` : undefined;
    // 仅「有 lineIndex 且属于未编辑行」的 mask 跳过（未编辑行不擦除 → 保留原 PDF 表格线等）。
    // block 级 mask（无 lineIndex，redaction/signature）始终绘制。
    // 注：编辑行一律画（per-glyph 分段）mask 擦除原文，避免与 overlay 新文字重影。
    //   mask 为 per-glyph 分段（renderBlockToExportCommands 中按字形水平分块），
    //   不会覆盖字形之间的表格线 / 边框线（用户报告表格线消失的根因是旧版整行大白块）。
    if (maskKey && !editedLineKeys.has(maskKey)) continue;
    // M7.8-036-FIX-003：整行原算子已干净剥离（fullyStrippedLines）→ 无残留原文，
    //   无需 mask；mask 会擦掉行内表格线 / 边框线（即便 per-glyph 也会覆盖行边界的水平表格线）。
    //   跳过 → 保留表格线，新文字由 native replay / overlay 直接绘在已剥离的流上。
    if (maskKey && fullyStrippedLines?.has(maskKey)) continue;
    // M7.8-FIX：已 native replay 成功原位替换的行（replayedKeys）→ 旧文本已消失，
    //   同样无需 mask；画 mask 只会白白擦掉该行的表格线（用户报告 bug）。
    if (maskKey && replayedKeys.has(maskKey)) continue;

    const pageIdx = cmd.pageIndex ?? 0;
    const page = pdf.getPage(Math.min(pageIdx, pdf.getPageCount() - 1));
    if (cmd.purpose === "mask") {
      page.drawRectangle({
        x: cmd.x,
        y: cmd.y,
        width: cmd.width,
        height: cmd.height,
        color: rgb(1, 1, 1),
        borderColor: rgb(1, 1, 1),
        borderWidth: 0,
      });
    }
  }

  // ── Pass 2: Overlay（仅编辑行）──
  for (const [key, glyphs] of lineGlyphs) {
    if (glyphs.length === 0) continue;
    if (!editedLineKeys.has(key)) continue; // 未编辑行跳过（原 PDF 已有正确内容）
    // M7.8-FIX：已 native replay 成功原位替换的行（replayedKeys）跳过 overlay，
    // 文本已由原生 content stream 承担，避免叠加 overlay 造成重影 / 二次改写。
    if (replayedKeys.has(key)) continue;

    const firstGlyph = glyphs[0];
    const pageIdxForLine = Math.min(firstGlyph.pageIndex ?? 0, pdf.getPageCount() - 1);
    const page = pdf.getPage(pageIdxForLine);

    // 拼接文本（单 line 内保持原字符顺序）
    const text = glyphs.map((g) => g.char).join("");
    // M7.7-009C: 判断是否需要 Unicode fallback（PNG 栅格化）。
    // 欧洲语言（葡萄牙语/西班牙语/法语等）的重音字符均在 WinAnsi 可编码范围内，
    // 走 drawText 矢量路径（使用映射的 Standard 14 字体）。
    // 仅 CJK/emoji 等超出 Latin-1 范围的字符走 PNG fallback。
    const requiresFallback = needsUnicodeFallback(text);

    // Sprint34.7 / Sprint34.7.1 Trace 阶段 4: 打印 PDF drawText（每行 text + x/y）
    // M7.8-022A: 增加坐标反推诊断（pageHeightPt / scale / cssY / cssH），
    // 用于定位"导出后文字下移"的根因（y 偏小 → 视觉下移）。
    // M7.8-022A 事故修复：本函数**没有** ctx 参数（签名是
    // writeExportCommandsToPDF(pdf, commands, getPageHeight, nativeRouting)）。
    // 此前诊断代码引用了 ctx.renderScale / ctx.pageHeightPt → TypeError
    // → 中断整个文字绘制循环 → 100 个字形一个都没画，而 mask 已在循环前写入，
    // 于是导出结果只剩白色遮盖块（表现为"原文露出 / 修改行下移 / 侵占下一行"）。
    // 现改为只使用本作用域内可用的 getPageHeight 回调，并整体 try/catch 包裹，
    // 确保任何诊断失败都不会再影响渲染。
    if (typeof console !== "undefined") {
      try {
        const drawX = Math.round(firstGlyph.x);
        const drawY = Math.round(firstGlyph.y + firstGlyph.height);
        console.log(
          `%c[Sprint34.7.1][PDFdraw] key=${key} text="${text}" x=${drawX} y=${drawY} size=${Math.round(firstGlyph.fontSize * 10) / 10} charCount=${text.length}`,
          "font-weight:bold;color:#22c55e;",
        );
        const pageH = getPageHeight(firstGlyph.pageIndex ?? 0);
        console.log(
          `%c[M7.8-022A][COORD_DIAG] key=${key} ptY=${Math.round(firstGlyph.y * 10) / 10} ` +
            `ptH=${Math.round((firstGlyph.height ?? 0) * 10) / 10} ` +
            `pageHeightPt=${Math.round(pageH * 10) / 10} ` +
            `→ cssInkBottom≈${Math.round((pageH - firstGlyph.y) * 10) / 10}（scale 未知，需乘 renderScale*cssScale）`,
          "color:#f59e0b;",
        );
      } catch {
        /* 诊断日志绝不能影响渲染 */
      }
    }

    if (requiresFallback) {
      // Unicode fallback（超出 WinAnsi 范围）：Canvas → PNG → embedPng
      // 用于 CJK、emoji 等 pdf-lib WinAnsi 编码无法表示的字符。
      try {
        const pngBytes = await textToPngForExport(
          text,
          firstGlyph.fontSize,
          firstGlyph.blockId
        );
        if (pngBytes) {
          const img = await pdf.embedPng(pngBytes);
          // 计算该 line 的 bbox
          const minX = Math.min(...glyphs.map((g) => g.x));
          const minY = Math.min(...glyphs.map((g) => g.y));
          const maxX = Math.max(...glyphs.map((g) => g.x + g.width));
          const maxY = Math.max(...glyphs.map((g) => g.y + g.height));
          const imgW = maxX - minX;
          const imgH = maxY - minY;
          page.drawImage(img, {
            x: minX,
            y: minY,
            width: imgW,
            height: imgH,
          });
        }
      } catch (e) {
        console.warn("[ExportRenderer] CJK text export failed:", key, e);
      }
    } else {
      // WinAnsi 可编码文本：逐 line drawText（矢量，保留原始坐标，可选中）。
      // M7.7-009C: 欧洲语言（葡萄牙语/西班牙语/法语等）的重音字符均在此路径，
      // 使用 resolveEmbeddedFont 映射的 Standard 14 字体，避免中文字体 PNG 栅格化。
      // Sprint34.7: 不再设 maxWidth，避免 pdf-lib 按宽度重新 wrap，保持与 Editor 的 line 边界一致。
      // Sprint40: 清洗 WinAnsi 不可编码字符（控制字符等），避免 pdf-lib 编码崩溃
      //（如 WinAnsi cannot encode "\u0003"），但保留可显示字符以保证 Fidelity。
      const color = hexToRgb(firstGlyph.color) || { r: 0, g: 0, b: 0 };

      // M7.8-0XX (OCR-EDIT-SYNC 修复): OCR / 无原生字体身份的编辑行（measured-only）。
      // 此前整行逐 glyph 绝对 x 绘制，因「测量字体 ≠ Standard-14 重绘字体」字距不匹配，
      // 导出文字被「打散 / 插空格」（如 "Ate sto que"）。改用整行单次 drawText（自然字距），
      // 从根本上消除字距错位；对带嵌入字体的原生 PDF 编辑行零影响（走下方 Native Replay / 逐 glyph 路径）。
      const isMeasuredOnly = glyphs.every(
        (g) => !g.fontIdentity && !Array.isArray(g.glyphMetrics?.pdfTransform)
      );
      if (!requiresFallback && isMeasuredOnly) {
        const serif = /serif/i.test(firstGlyph.fontFamily || "");
        const bold = firstGlyph.fontWeight === "bold" || firstGlyph.fontWeight === 700;
        const stdName = bold
          ? serif
            ? StandardFonts.TimesBold
            : StandardFonts.HelveticaBold
          : serif
            ? StandardFonts.TimesRoman
            : StandardFonts.Helvetica;
        const gFont = stdFontCache.get(stdName) ?? (await pdf.embedFont(stdName));
        stdFontCache.set(stdName, gFont);
        const gColor = hexToRgb(firstGlyph.color) || { r: 0, g: 0, b: 0 };
        page.drawText(text, {
          x: firstGlyph.x,
          // 用 glyph 真实 baseline（已由构建阶段换算为 PDF pt）；缺省退回 bbox 底部 (g.y)
          y:
            typeof firstGlyph.baseline === "number" && Number.isFinite(firstGlyph.baseline)
              ? firstGlyph.baseline
              : firstGlyph.y,
          size: firstGlyph.fontSize,
          font: gFont,
          color: rgb(gColor.r, gColor.g, gColor.b),
          maxWidth: 100000,
          lineHeight: (firstGlyph.fontSize || 14) * 1.3,
        });
        continue; // 跳过逐 glyph 路径（原生 PDF 编辑行不受影响）
      }

      // M7.8-033 RAW-CID Native Replay：直接引用原 PDF 已存在的嵌入字体（fontIdentity.fontRef），
      // 逐 glyph 直发真实 CID（pdfCharCode），不经 Unicode→CID 映射。
      // 每 glyph 用自身 pdfTransform 作为 Tm，Tf=1（矩阵即真相）。
      // 仅对「未修改的嵌入行」生效：被编辑行（char 已变）必须走 Unicode/overlay 写回新文本，
      // 不能直发旧 CID（否则渲染原字形而非 replacement）。
      const isType3 = firstGlyph.fontIdentity?.subtype === "Type3";
      const isEmbedded = firstGlyph.fontIdentity?.embedded && !isType3;
      const hasFontRef = !!firstGlyph.fontIdentity?.fontRef;
      const allHaveTransform = glyphs.every((g) => Array.isArray(g.glyphMetrics?.pdfTransform));

      if (hasFontRef && allHaveTransform && (isEmbedded || isType3)) {
        // ── M7.8-041-FIX-R4：编辑行优先用「原 PDF 嵌入字体」原生重放 ──
        // 背景：编辑行此前一律回落 Standard 14（Helvetica）逐 glyph drawText。
        //   Helvetica 的字宽与原 PDF 嵌入字体不同（如原字体 '6' 宽 8.11pt，Helvetica 'f' 仅 ~4pt），
        //   即使每个 glyph 的 x 仍取原位置，字符的**视觉间距**也会与原文不一致
        //   —— 表现为编辑后的字母间距比其它字符宽（"fr" 间距异常）。
        // 修复：编辑行在上方「预扫描」阶段已完成 tryNativeLineReplay（原地替换原文算子）；
        //   成功或 Type3 接管的行已记入 replayedKeys 并跳过 overlay（见 Pass 2 入口）。
        //   此处若仍在集合内（理论上不会），直接跳过以避免重复改写 / 叠加 overlay。
        // 安全边界：tryNativeLineReplay 对「非 Type3 行存在子集缺口字符」会返回 handled=false
        //   （绝不丢弃字符），此时回落到下方 Standard 14 兜底；Type3 行则禁止 Helvetica 回退。
        if (replayedKeys.has(key)) continue;

        const fontRef = (firstGlyph.fontIdentity!.fontRef ?? "").replace(/^\//, "");

        if (isEmbedded) {
          const allHaveCharCode = glyphs.every(
            (g) => typeof (g.pdfCharCode ?? g.glyphMetrics?.pdfCharCode) === "number" && !g.modified,
          );
          if (allHaveCharCode) {
            const rawGlyphs = glyphs.map((g) => ({
              cid: (g.pdfCharCode ?? g.glyphMetrics!.pdfCharCode)!,
              transform: g.glyphMetrics!.pdfTransform as [number, number, number, number, number, number],
            }));
            emitRawCidGlyphs(page, fontRef, rawGlyphs);
            continue;
          }
        }

        // Type3 分支已由上方 tryNativeLineReplay 统一接管（M7.8-035-FIX）：
        // 旧实现整行共用一个 fontRef/一张 unicodeToCharCode 表，且缺口字符会画成
        // 标准字体造成「行内字体混杂」。新实现逐 glyph 用其自身字体身份，
        // 缺口字符在同页同族 Type3 字体里找原生字形，找不到则丢弃（禁止 Helvetica）。
      }
      // Sprint40-fix（bug 3 通用修复）：混排行不能整行共用首个 glyph 字体，
      // 否则非首字体的字符（@ / . 等标点字体）与新增字符（子集缺失）会被 pdf-lib 静默丢弃，
      // 表现为「显示丢字 / 复制出旧文本」。改为逐 glyph 绘制，每个 glyph 用其自身字体身份；
      // 编辑过（新增）或原子集无法编码的字符回退 Standard 14，保证字符可见。
      for (const g of glyphs) {
        const gIdentity = g.fontIdentity ?? g.glyphMetrics?.fontIdentity;
        const gFontName =
          gIdentity?.fontName || g.glyphMetrics?.fontIdentity?.fontName || g.fontFamily;
        // overlay 路径（含编辑字符的行）必须保证新文本可见：直接使用 pdf-lib 内建
        // Standard 14 字体（无需外部字体文件），避免 resolveEmbeddedFont 映射到的
        // 替代字体在部分环境缺失导致字形丢失。整行重绘时保真度让位于正确性。
        let gFont: PDFFont | undefined = undefined;
        {
          const serif = /serif/i.test(g.fontFamily || "");
          const bold = g.fontWeight === "bold" || g.fontWeight === 700;
          const stdName = bold
            ? serif ? StandardFonts.TimesBold : StandardFonts.HelveticaBold
            : serif ? StandardFonts.TimesRoman : StandardFonts.Helvetica;
          gFont = stdFontCache.get(stdName) ?? (await pdf.embedFont(stdName));
          stdFontCache.set(stdName, gFont);
        }
        const gColor = hexToRgb(g.color) || { r: 0, g: 0, b: 0 };
        const gt = sanitizeWinAnsi(g.char ?? "");
        if (!gt) continue;
        const gRot = g.rotation ?? 0;
        const gOpts: Parameters<typeof page.drawText>[1] = {
          x: g.x,
          // 用 glyph 真实 baseline（已由构建阶段换算为 PDF pt）；
          // 缺省退回 bbox 底部 (g.y)，绝不能用 g.y + g.height（那是 bbox 顶部，会让文字整体上移一整行高）。
          y: typeof g.baseline === "number" && Number.isFinite(g.baseline) ? g.baseline : g.y,
          size: g.fontSize,
          font: gFont,
          color: rgb(gColor.r, gColor.g, gColor.b),
          maxWidth: 100000,
          lineHeight: g.fontSize * 1.3,
        };
        if (Math.abs(gRot) > 0.01) gOpts.rotate = degrees(-gRot);
        if (typeof console !== "undefined") {
          console.log(
            `%c[Sprint40-fix][DrawGlyph] "${gt}" font=${gFontName} x=${Math.round(g.x)} y=${Math.round(g.y)}`,
            "color:#a855f7;",
          );
        }
        page.drawText(gt, gOpts);
      }
    }
  }

  // 写入图片
  for (const cmd of images) {
    try {
      const resp = await fetch(cmd.src);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const img = resp.headers.get("content-type")?.includes("png")
        ? await pdf.embedPng(bytes)
        : await pdf.embedJpg(bytes);
      const page = pdf.getPage(Math.min(cmd.pageIndex ?? 0, pdf.getPageCount() - 1));
      const rot = (cmd as DrawImageCommand).rotation ?? 0;
      if (Math.abs(rot) > 0.01) {
        // Sprint34.11: 图片绕 bbox 左上角 (cmd.x, cmd.y) 旋转。
        // 与 glyph 一致：CSS 顺时针为正 → PDF 逆时针为负（取 -rotation）。
        // pdf-lib drawImage 不支持任意 transform 矩阵，改用 canvas 预旋转出新的倾斜 PNG，
        // 再平铺 drawImage（图片内容方向已正确）。
        const rotatedBytes = await rotateImageBytes(cmd.src, rot);
        if (rotatedBytes) {
          const rimg = await pdf.embedPng(rotatedBytes);
          // canvas 旋转后尺寸可能变化；保持 bbox 位置与尺寸不变（绕左上角，内容倾斜）
          page.drawImage(rimg, {
            x: cmd.x,
            y: cmd.y,
            width: cmd.width,
            height: cmd.height,
          });
        } else {
          page.drawImage(img, {
            x: cmd.x,
            y: cmd.y,
            width: cmd.width,
            height: cmd.height,
          });
        }
        // Sprint34.11 Debug
        if (typeof console !== "undefined") {
          console.log(
            `%c[Sprint34.11][ExportImage] rotation=${rot} x=${Math.round(cmd.x)} y=${Math.round(cmd.y)}`,
            "color:#0ea5e9;",
          );
        }
      } else {
        page.drawImage(img, {
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
        });
      }
    } catch (e) {
      console.warn("[ExportRenderer] Image export failed:", cmd.blockId, e);
    }
  }

  // 写入涂黑
  for (const cmd of redactions) {
    const page = pdf.getPage(Math.min(cmd.pageIndex ?? 0, pdf.getPageCount() - 1));
    page.drawRectangle({
      x: cmd.x,
      y: cmd.y,
      width: cmd.width,
      height: cmd.height,
      color: rgb(0, 0, 0),
      borderWidth: 0,
    });
  }

  // M7.8-042-FIX：保存前兜底 —— 每页 /Contents 必须是间接引用（流不能是直接对象），
  // 否则解析器判定页面内容流损坏 → 整页空白。
  ensureIndirectPageContents(pdf);

  void getPageHeight; // 保留参数（未来多页支持）
  void byPage;
}

/**
 * Task 4: 从 EditableDocument 导出 PDF（主入口）
 *
 * 流程：
 *   1. 加载原始 PDF 字节
 *   2. EditableDocument → ExportCommand[]
 *   3. ExportCommand[] → pdf-lib 写入
 *   4. pdf.save() → Uint8Array
 *
 * 【API 收敛】Sprint39-M2C
 *   - 不再接收 ctx 参数。ctx（renderScale/cssScale/pageHeightPt）属于 Export Runtime，
 *     由 Export 自己从 doc.runtime 读取。Caller（Runner/Editor）不知道 Export 内部实现。
 *   - 需要 doc.runtime.renderScale / cssScale（parsePdfToEditableDocument 已补齐）。
 *     缺失时回退默认（renderScale=1.5, cssScale=1）。
 *
 * @param doc EditableDocument（含 runtime.renderScale/cssScale）
 * @param originalBytes 原始 PDF 字节（可选；缺省则新建空白 PDF）
 * @param signatureRegions 签名渲染区域（可选）
 * @param requirements Export Requirements（可选；决定 Strategy。缺省/visualOverlayOnly → Overlay，needRewrite → Document Rewrite）
 * @returns Uint8Array（PDF 字节）
 */
export async function exportEditableDocument(
  doc: EditableDocument,
  originalBytes?: ArrayBuffer,
  signatureRegions?: SignatureRenderRegion[],
  requirements?: ExportRequirements,
  /** M7.7-006: 编辑态真实墨迹覆盖盒（lineId → CSS bbox），供 overlay mask 覆盖真实墨迹。 */
  editedLineBoxes?: Map<string, BBox>,
): Promise<Uint8Array> {
  // Export Runtime：从 doc.runtime 读取上下文（Caller 不传 ctx）
  const renderScale = doc.runtime?.renderScale ?? 1.5;
  const cssScale = doc.runtime?.cssScale ?? 1;
  const ctx: ExportContext = {
    renderScale,
    cssScale,
    pageHeightPt: doc.pages[0]?.height ?? 792,
  };

  // Sprint44-Order-020（ADR-007）：Strategy 决定 PDF 来源。
  // Phase B：needRewrite && rewriteCapable(doc) → Document Rewrite；否则 Overlay。
  // writeExportCommandsToPDF 保持纯 Renderer（不感知策略）。
  const strategy = defaultExportStrategySelector.select(requirements ?? {}, doc);
  // M7.8-022A: 一次性诊断 — 确认本次导出走哪条路径
  if (typeof console !== "undefined") {
    console.log(
      `[M7.8-022A][EXPORT_PATH] strategy.name="${strategy.name}" ` +
        `requirements=${requirements ? JSON.stringify(requirements) : "undefined"} ` +
        `hasOriginalBytes=${!!originalBytes} hasEditedLineBoxes=${!!editedLineBoxes}`,
      "color:#06b6d4;font-weight:bold;",
    );
  }

  // M7.7-004A：Native First —— 存在 native-ready 行（编辑态已绑定原生算子）且 Overlay 策略（原始 PDF 为源）时，
  // 走原生改写（Tj/TJ 原位替换 + 写回内容流）+ 仅对未 ready 行 overlay，避免 Helvetica fallback。
  if (strategy.name === "overlay" && originalBytes) {
    // M7.7-006 hardening: 测试门 __forceOverlay=process.env.STRIP_DIAG === "1" 时跳过 native-first，强制 Overlay（mask+重绘）路径，
    // 用于专门验证 overlay 视觉保真（mask/CJK-PNG/旋转）。
    // M7.8-022A: 默认改为「禁用 native rewrite」（__nativeRewrite !== process.env.STRIP_DIAG === "1" 即禁用）。
    //   根因：composeReplacementOperator（replace-text-operator.ts）无条件把 TJ 重建为
    //   单元素数组 `[(全文)] TJ`，原 PDF TJ 数组中的字距调整（kerning）数字全部丢失；
    //   且改写的行会被 deriveNativeRoutingFromBlock 判为 native-ready → skipOverlay，
    //   不再生成任何 overlay 命令 → 导出既无 mask 也无重绘，错位的文字直接来自被改写的
    //   内容流（用户报告：修改行下移 / 换行 / 露出原文 / 侵占下一行）。
    //   该缺陷与替换是否等长无关（等长同样丢字距），故不能仅按长度放行。
    //   恢复方式：运行时设 globalThis.__nativeRewrite = process.env.STRIP_DIAG === "1"。
    const nativeRewriteEnabled =
      (globalThis as unknown as { __nativeRewrite?: boolean })?.__nativeRewrite === process.env.STRIP_DIAG === "1";
    const forceOverlay =
      !nativeRewriteEnabled ||
      (globalThis as unknown as { __forceOverlay?: boolean })?.__forceOverlay === process.env.STRIP_DIAG === "1";
    if (forceOverlay && typeof console !== "undefined") {
      console.log(
        "[M7.8-022A][NATIVE_DISABLED] native rewrite 已禁用 → 强制 overlay（mask + 逐 glyph 重绘）",
        "color:#f59e0b;font-weight:bold;",
      );
    }
    const hasNativeReady = !forceOverlay && doc.pages.some((p) =>
      p.blocks.some((b) => {
        const r = deriveNativeRoutingFromBlock(b);
        return r.replacedLines.size > 0 || r.fullyReplacedBlocks.size > 0;
      }),
    );
    if (hasNativeReady) {
      return await exportDocumentNativeFirst({
        originalBytes,
        doc,
        pageIndex: 0,
        renderScale,
        cssScale,
        signatureRegions,
        editedLineBoxes,
      });
    }
  }

  let pdf: PDFDocument;
  if (strategy.name === "document-rewrite") {
    pdf = await strategy.createPdf(undefined);
  } else {
    pdf = await strategy.createPdf(originalBytes);
  }
  // M7.8-042-FIX：导入即归一化 —— /Contents 必须是间接引用。
  // 历史导出的坏文件（/Contents 里是内联流）在此被修正，
  // 否则下游 resolver（streamObjRef="embedded" 判定）/strip/native 都会拿到畸形结构。
  ensureIndirectPageContents(pdf);

  // EditableDocument → ExportCommand[]
  // M7.7-006：纯 overlay 路径不做 native rewrite，故剥离 native ready 态，
  //   使 nativeReady 编辑行回退 overlay（mask+重绘），避免被 deriveNativeRoutingFromBlock 短路而静默丢编辑。
  const overlayDoc = stripNativeReadyState(doc);

  // M7.8-035-FIX-5：文本层语义修复（移除被编辑行的原始 showText 算子）必须在
  // renderDocumentToExportCommands **之前**执行。
  // 原因：renderDocumentToExportCommands 内的 tryNativeLineReplay / emitNativeTextRun
  //   会调用 page.pushOperators，pdf-lib 会把整页内容流重新序列化（normalize 空白/去注释），
  //   导致各 showText 算子的 byteStart 相对原 PDF 整体偏移（实测 #15 "4" 偏移 -8 字节）。
  //   若先 render 再 strip，strip 解析的是已被重序列化的流，byteStart 错位 → 剥离到错误的
  //   算子（如把 "10.8 TL" 当 "(4) Tj" 剥离），原文字残留 → 导出成 "44 Bidens f r" 重影。
  // 故 strip 必须在内容流仍为原样时先跑，拿到正确 byteStart；随后 render 的 native replay
  //   在已剥离的流上追加新文字，互不干扰。
  // 这样复制/搜索导出 PDF 时不会同时得到「旧文本 + 新文本」两份内容。
  const stripResult = await stripReplacedTextOperators(pdf, overlayDoc);

  const commands = renderDocumentToExportCommands(overlayDoc, ctx, signatureRegions, editedLineBoxes);

  // ExportCommand[] → pdf-lib
  await writeExportCommandsToPDF(
    pdf,
    commands,
    (idx) => {
      const page = doc.pages[idx];
      return page ? page.height / (renderScale * cssScale) : 842;
    },
    undefined,
    // 整行剥离干净的行 → 跳过 mask，避免白矩擦掉行内表格线
    stripResult.fullyStrippedLines,
  );

  return await pdf.save();
}

// ── 辅助函数 ──

/**
 * 解析行级样式
 */
function resolveLineStyle(
  line: EditableLine,
  styles: EditableStyle[]
): EditableStyle {
  if (line.style && Object.keys(line.style).length > 0) {
    return line.style;
  }
  const ref = line.glyphs[0]?.styleRef;
  if (ref !== undefined && styles[ref]) {
    return styles[ref];
  }
  return {};
}

/**
 * hex 颜色 → rgb
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16) / 255,
    g: parseInt(match[2], 16) / 255,
    b: parseInt(match[3], 16) / 255,
  };
}

/**
 * Sprint40: 清洗 WinAnsi 不可编码字符。
 *
 * pdf-lib 的 StandardFonts 用 WinAnsi（Latin-1）编码，遇到不可编码字符（控制字符 \u0000-\u001F、
 * \u007F-\u00A0 之外的 Latin-1 空白等）会抛 "WinAnsi cannot encode ..."。
 * 修复：把不可编码字符替换为空格（保留可显示字符，避免 Fidelity 大幅下降）。
 *
 * WinAnsi 可编码：0x20-0x7E（ASCII 可见）、0xA0-0xFF（Latin-1 补充）。
 * 控制字符 0x00-0x1F、0x7F 不可编码 → 替换为空格。
 */
function sanitizeWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // 可编码范围：0x20-0x7E（可见 ASCII）与 0xA0-0xFF（Latin-1 补充）
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch;
    } else {
      // 控制字符 / 超 Latin-1 字符 → 空格（保留宽度位置）
      out += " ";
    }
  }
  return out;
}

/**
 * M7.7-009C: 判断文本是否需要走 Unicode fallback（PNG 栅格化）。
 *
 * 与 sanitizeWinAnsi 一致：只有当文本包含 WinAnsi 不可编码字符时返回 true。
 * WinAnsi 可编码范围：0x20-0x7E（可见 ASCII）与 0xA0-0xFF（Latin-1 补充）。
 *
 * 欧洲语言（葡萄牙语/西班牙语/法语/德语等）的重音字符（á/ç/ã/é/ü 等）
 * 全部在 0xC0-0xFF 范围内，属于 WinAnsi 可编码，因此返回 false。
 *
 * 中文/日文/emoji 等超出 0xFF 的字符返回 true，走 PNG fallback。
 */
function needsUnicodeFallback(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // 可编码范围：0x20-0x7E（可见 ASCII）与 0xA0-0xFF（Latin-1 补充）
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      continue;
    }
    // 控制字符（0x00-0x1F、0x7F）以及 0x80-0x9F 虽可经 sanitize 空格化，不触发 PNG fallback
    if (code <= 0xa0) continue;
    // 超出 Latin-1 范围 → 需要 PNG fallback
    return true;
  }
  return false;
}

/**
 * Sprint39: 把 CSS font-family 字符串映射到 pdf-lib 标准 14 字体并嵌入。
 *
 * 修复"导出字体变了"根因：此前 page.drawText 不传 font，pdf-lib 默认回落 Helvetica，
 * 导致原 PDF 的 Times/Courier/SimSun 等在导出后全部变成 Helvetica。
 *
 * 标准 14 字体映射（含 Bold/Italic 变体）：
 *   - Helvetica / Arial / sans-serif        → Helvetica
 *   - Times / Times New Roman / serif       → TimesRoman
 *   - Courier / monospace                   → Courier
 *   - 其余未知字体                          → 不设置 font（回退 pdf-lib 默认 Helvetica）
 *
 * @param pdf      目标 PDFDocument
 * @param fontFamily CSS font-family 字符串（如 "Helvetica, Arial, sans-serif"）
 * @param fontWeight 字体粗细（"bold"/700 等）
 * @param fontStyle  字体样式（"italic"）
 * @param cache    字体缓存（同字体只嵌入一次）
 */
async function resolveEmbeddedFont(
  pdf: PDFDocument,
  fontFamily: string,
  fontWeight: string | number,
  fontStyle: string,
  cache: Map<string, PDFFont>,
): Promise<PDFFont | undefined> {
  const family = (fontFamily || "").toLowerCase();
  const isBold =
    String(fontWeight).toLowerCase() === "bold" ||
    String(fontWeight) === "700" ||
    String(fontWeight) === "800" ||
    String(fontWeight) === "900";
  const isItalic = String(fontStyle).toLowerCase() === "italic";
  const isOblique = String(fontStyle).toLowerCase() === "oblique";

  // 识别标准字体基名
  let base: StandardFonts;
  if (
    family.includes("helvetica") ||
    family.includes("arial") ||
    family.includes("sans-serif")
  ) {
    base = StandardFonts.Helvetica;
  } else if (
    family.includes("times") ||
    family.includes("serif") ||
    family.includes("georgia") ||
    family.includes("garamond")
  ) {
    base = StandardFonts.TimesRoman;
  } else if (
    family.includes("courier") ||
    family.includes("monospace") ||
    family.includes("consolas")
  ) {
    base = StandardFonts.Courier;
  } else {
    // 未知字体（含中文字体）：不设置 font，回退 pdf-lib 默认 Helvetica
    return undefined;
  }

  // 按 weight/style 选择变体
  const key =
    base + (isBold ? "-Bold" : "") + (isItalic || isOblique ? "-Italic" : "");

  const cached = cache.get(key);
  if (cached) return cached;

  // 选择标准 14 变体字体
  let std: StandardFonts;
  if (isBold && (isItalic || isOblique)) {
    std = base === StandardFonts.TimesRoman ? StandardFonts.TimesRomanBoldItalic : base === StandardFonts.Courier ? StandardFonts.CourierBoldOblique : StandardFonts.HelveticaBoldOblique;
  } else if (isBold) {
    std = base === StandardFonts.TimesRoman ? StandardFonts.TimesRomanBold : base === StandardFonts.Courier ? StandardFonts.CourierBold : StandardFonts.HelveticaBold;
  } else if (isItalic || isOblique) {
    std = base === StandardFonts.TimesRoman ? StandardFonts.TimesRomanItalic : base === StandardFonts.Courier ? StandardFonts.CourierOblique : StandardFonts.HelveticaOblique;
  } else {
    std = base;
  }

  const font = await pdf.embedFont(std);
  cache.set(key, font);
  return font;
}

/**
 * 将文本渲染为 PNG（用于非 ASCII 字符导出）
 *
 * 与 export-pdf.ts 的 textToPng 一致，独立维护避免循环依赖。
 */
async function textToPngForExport(
  text: string,
  fontSize: number,
  _blockId: string
): Promise<Uint8Array | null> {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const scale = 2;
    const font = `${fontSize * scale}px "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.font = font;

    // 计算文本宽度
    const textWidth = ctx.measureText(text).width;
    // M7.7-006B：overlay 文本（含 non-ASCII，如 "através" 的 ã）以 PNG 栅格导出后，pdf.js/OCR
    // 重解析得到的有效字号（本 PDF 实测 22.43）明显小于原行 CID 字体的有效字号（26.06）。
    // 根因：1.3em 行高在栅格画布内留下过多上下留白 → 字形只占放置盒约 68%，被重解析读小。
    const lineH = fontSize * scale * 1.12;

    canvas.width = Math.ceil(Math.max(textWidth, 1));
    canvas.height = Math.ceil(lineH);

    ctx.font = font;
    ctx.fillStyle = "rgb(0, 0, 0)";
    ctx.textBaseline = "top";
    ctx.fillText(text, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Sprint34.11: 用 canvas 预旋转图片，返回倾斜后的 PNG 字节。
 *
 * @param src 图片 data URL / URL
 * @param rotDeg 旋转角度（度，CSS 顺时针为正，与 glyph 一致）
 * @returns PNG bytes；失败返回 null
 */
async function rotateImageBytes(
  src: string,
  rotDeg: number,
): Promise<Uint8Array | null> {
  try {
    if (typeof document === "undefined") return null;
    const img = new Image();
    img.src = src;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("img load failed"));
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    const rad = (rotDeg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    // 旋转后外接矩形
    const cw = Math.max(1, Math.ceil(w * cos + h * sin));
    const ch = Math.max(1, Math.ceil(w * sin + h * cos));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // 绕中心旋转（canvas Y-down，rotate 顺时针为正，与 CSS 一致）
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -w / 2, -h / 2);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * M7.8-035-B Step 11：把 Type3 字体资源从 page/Form 的 Resources 提升到 page Resources。
 *
 * Type3 字体常挂在 Form XObject 的 /Resources/Font 下，page 级 overlay 内容流写
 * `Tf /F5 1` 时若 page /Resources/Font 无 /F5，PDF 查看器会回落默认字体（Helvetica）。
 * 本函数在原 PDF 中按 resourceName 找到该字体的 PDFRef，并插入到 page.Resources.Font。
 */
/**
 * M7.8-035-FIX · 把**实际使用到的** Type3 字体资源提升到 page /Resources/Font。
 *
 * 原 PDF 的 Type3 字体常常只挂在 Form XObject 的 /Resources 下，page 级 /Font **根本不存在**。
 * 旧实现在 `page Resources has no Font dict` / `no Resources` 时直接 return ——
 * 于是 overlay 里写出的 `Tf /F5` 指向一个不存在的资源，阅读器只能回落到 Helvetica，
 * 这正是用户看到的「编辑行字体全变」的直接成因之一。
 *
 * 现在：Resources / Font 缺失时按需新建（只提升实际用到的那几个资源，不做全量提升）。
 */
function elevateType3Font(pdf: PDFDocument, pageIndex: number, resourceName: string): void {
  try {
    if (pageIndex < 0 || pageIndex >= pdf.getPageCount()) return;
    const resources = collectFontResources(pdf, pageIndex);
    // collectFontResources 的 key 带前导 "/"，而调用方传入的 resourceName 可能已剥斜杠；两种写法都试。
    const key = resourceName.replace(/^\//, "");
    const entry = resources.get(`/${key}`) ?? resources.get(resourceName) ?? resources.get(key);
    if (!entry) {
      console.warn("[M7.8-035-FIX][ELEVATE] Type3 font not found in resources:", resourceName);
      return;
    }
    const page = pdf.getPage(pageIndex);

    // page /Resources 缺失 → 新建（继承来的资源字典也应就地创建，避免改到父节点）
    let pageRes = page.node.Resources() as PDFDict | undefined;
    if (!pageRes) {
      pageRes = pdf.context.obj({});
      page.node.set(PDFName.of("Resources"), pageRes);
    }

    // page /Resources/Font 缺失 → 新建（本 PDF 就是这种情况）
    let fontDict: PDFDict | undefined;
    try {
      fontDict = pageRes.lookup(PDFName.of("Font")) as PDFDict | undefined;
    } catch {
      fontDict = undefined;
    }
    if (!fontDict) {
      fontDict = pdf.context.obj({});
      pageRes.set(PDFName.of("Font"), fontDict);
    }

    if (fontDict.has(PDFName.of(key))) return; // 已存在（幂等）
    fontDict.set(PDFName.of(key), entry.ref);
    console.log(
      `[M7.8-035-FIX][ELEVATE] page=${pageIndex} resourceName=${key} obj=${entry.ref.objectNumber} → page /Resources/Font`,
    );
  } catch (e) {
    console.warn("[M7.8-035-FIX][ELEVATE] failed:", resourceName, e);
  }
}

// ─────────────────────────────────────────────────────────────
// M7.8-024 · EXPORT_COORDINATE_TRACE（只读诊断，不改变任何生产逻辑）
//
// 目的：不对 Y 做任何"应该等于多少"的假设（禁止用 lineIndex/pageLineCount 推算），
//       只把 line 的 Y 从「原始 PDF → mutation → export → cssToPdf → drawText」
//       逐节点打印出来，并给出每一步的 delta，从而定位
//       **Y 第一次发生异常变化的节点**（first divergence）。
//
// 本函数只读取数据结构并调用已存在的 cssToPdf / fontSizeCssToPt，
// 不修改任何既有函数；drawText baseline 用 pdfBox.y + pdfBox.height 复现（与 writeExportCommandsToPDF 一致）。
// ─────────────────────────────────────────────────────────────

export interface CoordinateTraceRow {
  node: string;
  x: number;
  y: number;
  width: number;
  height: number;
  baseline?: number;
  fontSize?: number;
}

/**
 * 只读地追踪单行从模型到 drawText 的完整坐标链。
 * 不假设 Y 应当是多少，只报告每一跳的实际 delta。
 */
export function traceExportCoordinate(
  line: {
    id: string;
    glyphs: Array<{
      char: string;
      originalChar?: string;
      bbox: { x: number; y: number; width: number; height: number };
      originalBBox?: { x: number; y: number; width: number; height: number };
      baseline?: number;
      styleRef?: number;
      modified?: boolean;
    }>;
  },
  styles: Array<{ fontSize?: number; fontFamily?: string; pdfjsFontFamily?: string }>,
  pageHeightCss: number,
  renderScale: number,
  cssScale: number,
  maskBox?: { x: number; y: number; width: number; height: number },
  neighborLines?: Array<{ id: string; bbox?: { y?: number; height?: number } }>,
  opts?: {
    lineBBox?: { x: number; y: number; width: number; height: number };
    canvas?: HTMLCanvasElement | null;
    prevLineBottom?: number;
    nextLineTop?: number;
    cssScale?: number;
  }
): {
  lineId: string;
  glyphCount: number;
  totalScale: number;
  pageHeightPt: number;
  rows: CoordinateTraceRow[];
  summary: Record<string, number | string>;
  horizontalWidthDelta: number;
  verticalPositionDelta: number;
  independenceProof: Record<string, number | string>;
  firstDivergence: string;
} {
  const totalScale = renderScale * cssScale;
  const ctx: ExportContext = {
    renderScale,
    cssScale,
    pageHeightPt: pageHeightCss / totalScale,
  };

  const g0 = line.glyphs[0];
  const gN = line.glyphs[line.glyphs.length - 1];
  const style = styles[g0?.styleRef ?? 0] ?? {};
  const rows: CoordinateTraceRow[] = [];

  // ① 原始 PDF glyph（originalBBox）
  if (g0?.originalBBox) {
    rows.push({
      node: "① 原始 PDF glyph (originalBBox)",
      x: g0.originalBBox.x,
      y: g0.originalBBox.y,
      width: g0.originalBBox.width,
      height: g0.originalBBox.height,
      baseline: g0.baseline,
      fontSize: style.fontSize,
    });
  }

  // ② mutation 后 glyph（bbox）
  rows.push({
    node: "② mutation 后 glyph (bbox)",
    x: g0.bbox.x,
    y: g0.bbox.y,
    width: g0.bbox.width,
    height: g0.bbox.height,
    baseline: g0.baseline,
    fontSize: style.fontSize,
  });

  // ③ export-renderer 接收到的几何（与 ② 同源，显式列出以证明无中间转换）
  rows.push({
    node: "③ export-renderer 接收 (glyph.bbox)",
    x: g0.bbox.x,
    y: g0.bbox.y,
    width: g0.bbox.width,
    height: g0.bbox.height,
    baseline: g0.baseline,
    fontSize: style.fontSize,
  });

  // ④ cssToPdf 输入
  const cssRect = {
    x: g0.bbox.x,
    y: g0.bbox.y,
    width: g0.bbox.width,
    height: g0.bbox.height,
  };
  rows.push({
    node: "④ cssToPdf 输入 cssRect",
    x: cssRect.x,
    y: cssRect.y,
    width: cssRect.width,
    height: cssRect.height,
  });

  // ⑤ cssToPdf 输出（PDF pt）
  const pdf = cssToPdf(cssRect, ctx);
  rows.push({
    node: "⑤ cssToPdf 输出 (PDF pt)",
    x: pdf.x,
    y: pdf.y,
    width: pdf.width,
    height: pdf.height,
  });

  // ⑥ 最终 drawText 参数（复现 writeExportCommandsToPDF 的取值）
  // 基线 = glyph 真实 baseline（与 native replay / 编辑器一致）；缺省退回 bbox 底部 (pdf.y)，
  // 不再用 pdf.y + pdf.height（那等于 bbox 顶部，会让文字整体上移一整行高）。
  const fontSizePt = fontSizeCssToPt(style.fontSize ?? 14, ctx);
  const baseCssY =
    typeof g0?.baseline === "number" && Number.isFinite(g0.baseline)
      ? g0.baseline
      : cssRect.y + cssRect.height;
  const drawY = pdf.y + (cssRect.y + cssRect.height - baseCssY) / totalScale;
  rows.push({
    node: "⑥ pdf-lib drawText",
    x: pdf.x,
    y: drawY,
    width: pdf.width,
    height: pdf.height,
    fontSize: fontSizePt,
  });

  const r1 = (n: number | undefined) => (n === undefined ? NaN : Math.round(n * 100) / 100);
  const origY = g0?.originalBBox?.y;
  const origH = g0?.originalBBox?.height;
  const origBottom = origY !== undefined && origH !== undefined ? origY + origH : NaN;
  const mutBottom = g0.bbox.y + g0.bbox.height;
  const cssBottom = cssRect.y + cssRect.height;
  const pdfBottom = pdf.y;

  const dMutation = r1(mutBottom - origBottom);
  const dCssRect = r1(cssBottom - mutBottom);
  // 语义校正：pdfBottom * totalScale 是「距页面底部的 CSS 距离」，
  // cssBottom 是「距页面顶部的 CSS 距离」，两者不可直接相减。
  // cssToPdf 保真时应满足：pdfBottom * totalScale === pageHeightCss - cssBottom
  const dCssToPdf = r1(pdfBottom * totalScale - (pageHeightCss - cssBottom));
  // drawText 相对 cssToPdf 输出引入的偏移（PDF pt → CSS，正值 = PDF 中向上）
  const dDrawText = r1((drawY - pdf.y) * totalScale);

  let firstDivergence = "无 Y 变化（整链 delta 全为 0）";
  if (Number.isNaN(dMutation)) firstDivergence = "无法判定：缺少 originalBBox（无法对比 mutation 前后）";
  else if (Math.abs(dMutation) > 0.01) firstDivergence = "①→② mutation 层（glyph.bbox 相对 originalBBox 发生 Y 变化）";
  else if (Math.abs(dCssRect) > 0.01) firstDivergence = "②→④ cssRect 组装层（cssRect 与 glyph.bbox 不一致）";
  else if (Math.abs(dCssToPdf) > 0.01) firstDivergence = "④→⑤ cssToPdf 转换层（Y 翻转后 CSS 语义不一致）";
  else if (Math.abs(dDrawText) > 0.01) firstDivergence = "⑤→⑥ drawText 层（baseline 偏移引入 Y 变化）";

  const horizontalWidthDelta = r1(g0.bbox.width - (g0?.originalBBox?.width ?? NaN));
  const verticalPositionDelta = r1(g0.bbox.y - (origY ?? NaN));

  // ── mask 追踪：mask 是「白色遮盖块」，若位置错误会导致
  //    原文露出（没盖住原行）+ 侵占下一行（压到邻行）。
  //    复现 renderBlockToExportCommands 的 mask 计算（只读，不修改它）。
  const MASK_PADDING_X = 2;
  const MASK_PADDING_Y = 2;
  const glyphUnion = (() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const g of line.glyphs) {
      minX = Math.min(minX, g.bbox.x);
      minY = Math.min(minY, g.bbox.y);
      maxX = Math.max(maxX, g.bbox.x + g.bbox.width);
      maxY = Math.max(maxY, g.bbox.y + g.bbox.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  })();
  const maskRaw = maskBox
    ? {
        x: maskBox.x - MASK_PADDING_X,
        y: maskBox.y - MASK_PADDING_Y,
        width: maskBox.width + MASK_PADDING_X * 2,
        height: maskBox.height + MASK_PADDING_Y * 2,
      }
    : null;
  const maskBottomRaw = maskRaw ? maskRaw.y + maskRaw.height : NaN;
  const maskTopRaw = maskRaw ? maskRaw.y : NaN;
  // 邻行顶部（mask 下沿不得越过）
  const neighborTop =
    neighborLines && neighborLines.length > 1 ? neighborLines[1]?.bbox?.y : undefined;
  const maskBottomClamped =
    maskRaw && neighborTop !== undefined
      ? Math.min(maskBottomRaw, neighborTop)
      : maskBottomRaw;

  // ── Phase C: 原 PDF canvas 实际 ink bbox（只读像素扫描，不写任何 state）──
  // 扫描纵向范围刻意限制在 [上一行底部, 邻行顶部]，确保只捕获本行完整墨迹
  // （含 ascender/descender），且不把邻行墨迹算进来。
  // 与 M7.7-026 一致地以 alpha > 8 判定墨迹（PDF canvas 背景透明）。
  const scanInk = (): { top: number; bottom: number; scanned: string } | null => {
    const canvas = opts?.canvas;
    if (!canvas) return null;
    const cs = opts?.cssScale ?? 1;
    const ctx2d = canvas.getContext?.("2d");
    if (!ctx2d) return null;
    const prevBottom = opts?.prevLineBottom;
    const nextTop = opts?.nextLineTop ?? neighborTop;
    const yTop = prevBottom !== undefined ? prevBottom : glyphUnion.y - 15;
    const yBot = nextTop !== undefined ? Math.min(nextTop, glyphUnion.y + glyphUnion.height + 15) : glyphUnion.y + glyphUnion.height + 15;
    const x0 = glyphUnion.x;
    const x1 = glyphUnion.x + glyphUnion.width;
    const sx = Math.max(0, Math.floor(x0 / cs));
    const sy = Math.max(0, Math.floor(yTop / cs));
    const sw = Math.min(canvas.width - sx, Math.max(1, Math.ceil((x1 - x0) / cs)));
    const sh = Math.min(canvas.height - sy, Math.max(1, Math.ceil((yBot - yTop) / cs)));
    if (sw <= 0 || sh <= 0) return null;
    let data: Uint8ClampedArray;
    try {
      data = ctx2d.getImageData(sx, sy, sw, sh).data;
    } catch {
      return null;
    }
    let topRow: number | null = null;
    let botRow: number | null = null;
    for (let r = 0; r < sh; r++) {
      for (let c = 0; c < sw; c++) {
        if (data[(r * sw + c) * 4 + 3] > 8) {
          if (topRow === null) topRow = r;
          botRow = r;
          break;
        }
      }
    }
    if (topRow === null || botRow === null) return null;
    return {
      top: (sy + topRow) * cs,
      bottom: (sy + botRow + 1) * cs,
      scanned: `x[${Math.round(x0)}..${Math.round(x1)}] y[${Math.round(yTop)}..${Math.round(yBot)}] 像素 ${sw}x${sh}`,
    };
  };
  const ink = scanInk();
  const lineBBox = opts?.lineBBox;
  const lineBBoxBottom = lineBBox ? lineBBox.y + lineBBox.height : NaN;
  // fallback mask = (line.bbox ∪ glyph 并集) + padding，再 clamp 到邻行顶部
  const fbUnion = (() => {
    if (!lineBBox) return glyphUnion;
    const minX = Math.min(lineBBox.x, glyphUnion.x);
    const minY = Math.min(lineBBox.y, glyphUnion.y);
    const maxX = Math.max(lineBBox.x + lineBBox.width, glyphUnion.x + glyphUnion.width);
    const maxY = Math.max(lineBBoxBottom, glyphUnion.y + glyphUnion.height);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  })();
  const fbMask = {
    x: fbUnion.x - MASK_PADDING_X,
    y: fbUnion.y - MASK_PADDING_Y,
    width: fbUnion.width + MASK_PADDING_X * 2,
    height: fbUnion.height + MASK_PADDING_Y * 2,
  };
  const fbMaskBottomClamped =
    neighborTop !== undefined ? Math.min(fbMask.y + fbMask.height, neighborTop) : fbMask.y + fbMask.height;

  return {
    lineId: line.id,
    glyphCount: line.glyphs.length,
    totalScale,
    pageHeightPt: ctx.pageHeightPt,
    rows,
    summary: {
      "Original PDF baseline (CSS)": r1(g0.baseline),
      "Mutation glyph baseline (CSS)": r1(g0.baseline),
      "Export glyph baseline (CSS)": r1(g0.baseline),
      "CSS rect bottom": r1(cssBottom),
      "cssToPdf bottom (pt)": r1(pdfBottom),
      "cssToPdf bottom 还原回 CSS": r1(pdfBottom * totalScale),
      "drawText baseline (pt)": r1(drawY),
      "drawText baseline 还原回 CSS": r1((ctx.pageHeightPt - drawY) * totalScale),
      "delta ①→② mutation": dMutation,
      "delta ②→④ cssRect": dCssRect,
      "delta ④→⑤ cssToPdf（Y 翻转保真，应为 0）": dCssToPdf,
      "delta ⑤→⑥ drawText（bbox-bottom→baseline +height，正值=PDF 中向上）": dDrawText,
      firstDivergence,
    },
    horizontalWidthDelta,
    verticalPositionDelta,
    independenceProof: {
      说明:
        "水平与垂直取自同一 glyph 的不同分量（width vs y），互不参与对方的计算；" +
        "Y 链上任何节点都不读取 width，X 链上任何节点都不读取 y 之外的高度分量",
      "horizontalWidthDelta = bbox.width - originalBBox.width": horizontalWidthDelta,
      "verticalPositionDelta = bbox.y - originalBBox.y": verticalPositionDelta,
      "首字符 char/originalChar": `${g0.char}/${g0.originalChar ?? ""}`,
      "整行宽度 (CSS)": r1(gN.bbox.x + gN.bbox.width - g0.bbox.x),
      "整行 Y 跨度 (CSS)": r1(
        Math.max(...line.glyphs.map((g) => g.bbox.y + g.bbox.height)) -
          Math.min(...line.glyphs.map((g) => g.bbox.y))
      ),
    },
    mask: {
      "editedLineBoxes 命中": !!maskBox,
      "mask 原始盒 (CSS)": maskBox
        ? `x=${r1(maskBox.x)} y=${r1(maskBox.y)} w=${r1(maskBox.width)} h=${r1(maskBox.height)}`
        : "无（将回退 line.bbox ∪ glyph 并集）",
      "mask padding 后 top": r1(maskTopRaw),
      "mask padding 后 bottom": r1(maskBottomRaw),
      "glyph 并集 (CSS)": `x=${r1(glyphUnion.x)} y=${r1(glyphUnion.y)} w=${r1(glyphUnion.width)} h=${r1(glyphUnion.height)}`,
      "glyph 并集 bottom": r1(glyphUnion.y + glyphUnion.height),
      "mask 下沿 - glyph 并集下沿": r1(maskBottomRaw - (glyphUnion.y + glyphUnion.height)),
      "邻行顶部 (clamp 边界)": r1(neighborTop),
      "mask clamp 后 bottom": r1(maskBottomClamped),
      "mask 是否越过邻行": r1(maskBottomRaw - (neighborTop ?? NaN)),
    },
    phaseC: {
      "① line.bbox": lineBBox
        ? `x=${r1(lineBBox.x)} y=${r1(lineBBox.y)} w=${r1(lineBBox.width)} h=${r1(lineBBox.height)}`
        : "未提供",
      "① line.bbox top/bottom/height": lineBBox
        ? `${r1(lineBBox.y)} / ${r1(lineBBoxBottom)} / ${r1(lineBBox.height)}`
        : "—",
      "② glyph union bbox": `x=${r1(glyphUnion.x)} y=${r1(glyphUnion.y)} w=${r1(glyphUnion.width)} h=${r1(glyphUnion.height)}`,
      "② glyph union top/bottom/height": `${r1(glyphUnion.y)} / ${r1(glyphUnion.y + glyphUnion.height)} / ${r1(glyphUnion.height)}`,
      "③ 原 PDF canvas ink bbox": ink
        ? `top=${r1(ink.top)} bottom=${r1(ink.bottom)} height=${r1(ink.bottom - ink.top)}`
        : "未扫描（无 canvas 或扫描失败）",
      "③ 扫描区域": ink ? ink.scanned : "—",
      "④ editedLineBoxes[line17]": maskBox
        ? `x=${r1(maskBox.x)} y=${r1(maskBox.y)} w=${r1(maskBox.width)} h=${r1(maskBox.height)}`
        : "未命中（false）",
      "⑤ fallback mask bbox (line.bbox ∪ glyphUnion + padding)": `x=${r1(fbMask.x)} y=${r1(fbMask.y)} w=${r1(fbMask.width)} h=${r1(fbMask.height)}`,
      "⑤ fallback mask top/bottom/height（clamp 后）": `${r1(fbMask.y)} / ${r1(fbMaskBottomClamped)} / ${r1(fbMaskBottomClamped - fbMask.y)}`,
      "⑥ 邻行顶部（不得越过）": r1(neighborTop),
      "⑦ 上缺口 = glyphUnion.top - ink.top": ink ? r1(glyphUnion.y - ink.top) : NaN,
      "⑦ 下缺口 = ink.bottom - glyphUnion.bottom": ink ? r1(ink.bottom - (glyphUnion.y + glyphUnion.height)) : NaN,
      "⑦ fallback mask 上缺口 = ink.top - mask.top": ink ? r1(ink.top - fbMask.y) : NaN,
      "⑦ fallback mask 下缺口 = mask.bottom(clamped) - ink.bottom": ink
        ? r1(fbMaskBottomClamped - ink.bottom)
        : NaN,
      "结论·glyph bbox 是否覆盖完整 ink": ink
        ? (glyphUnion.y <= ink.top + 0.01 && glyphUnion.y + glyphUnion.height >= ink.bottom - 0.01
            ? "是"
            : "否（存在缺口，见 ⑦）")
        : "无法判定",
      "结论·fallback mask 是否覆盖完整 ink": ink
        ? (fbMask.y <= ink.top + 0.01 && fbMaskBottomClamped >= ink.bottom - 0.01
            ? "是"
            : "否（存在缺口，见 ⑦）")
        : "无法判定",
    },
    firstDivergence,
  } as any;
}
