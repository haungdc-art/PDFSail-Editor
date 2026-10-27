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

import { isExportScaleAlignEnabled } from "./export-scale-align";
import { isFallbackBaselineAlignEnabled, resolveBaseCssY } from "./export-fallback-baseline-align";
import { isRawFallbackDirectBaselineEnabled, resolveDirectRawPdfY, isValidPdfTransform } from "./export-raw-fallback-direct-baseline";

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFStream,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  decodePDFRawStream,
  rgb,
  degrees,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { assembleCidFont } from "./export-cid-font";
// Step 5B：CID 路径复用既有 resolver 拿「该行原 PDF 内嵌字体」字节
// （不新建 embedded-font loader / cache，也不手写字节抽取）。
import { resolveFont, type ResolvedFont } from "./export-font-resolver";
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
  LineRedrawGeometry,
} from "./types";
import type {
  ExportCommand,
  DrawTextGlyphCommand,
  DrawLineCommand,
  DrawImageCommand,
  DrawRedrawLineCommand,
} from "./export-command";
import { groupExportCommands } from "./export-command";
// M7.8-035-FIX-5：复用已有的内容流解析/补丁能力做「文本层语义修复」
import {
  makeFontDictResolver,
  resolvePageShowTextWithXObjects,
  tokenizeContentStream,
  type TextShowRecord,
} from "./content-stream-resolver";
// F3B-6.28 · D-3B-7：编辑字符的**原字体**一致性 —— 原字体 /ToUnicode 反查（Unicode → CID）
import { buildReverseToUnicodeMap, reverseCidOf } from "./export-font-cid-reverse";
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
import {
  splitOriginalRawRuns,
  classifyGlyphForExport,
} from "./export-original-raw-split";

// Sprint40-fix（bug 3 通用修复）：Standard 14 回退字体缓存，避免逐 glyph 重复嵌入。
const stdFontCache = new Map<string, PDFFont>();
import {
  collectFontResources,
  findFontForChar,
  type PdfFontResource,
} from "./pdf-font-provenance";
import type { TransformMatrix } from "./types";
import fontkit from "fontkit";
// F3B-6.28 · D-3B-4：重绘写入资格门（清除完整性核验 + 拒绝型错误）
import {
  ExportRedrawGateError,
  collectShowTextOpsFromStream,
  findIncompletelyClearedLines,
  type StreamOpLike,
} from "./export-redraw-verify";

/**
 * 导出上下文（坐标转换参数）与 CSS→PDF 换算已抽到**中立纯模块**
 * `./export-coordinate-space`（F3B-6.28 · D-3B-2：Binding 层受 012-B 边界守卫约束
 * 不得 import 本文件，但重绘几何必须与这里使用同一套坐标口径）。
 * 此处 re-export 保持既有消费方（export-impact-analysis / export-scale-align /
 * CoordinateMapper / 各测试）的导入面不变。
 */
export { cssToPdf, cssToPdfX } from "./export-coordinate-space";
// F3B-6.28 · D-3B-4：document-space 契约（重绘几何专用；legacy overlay 契约不变）
export { cssToPdfXDocumentSpace } from "./export-coordinate-space";
export type { ExportContext } from "./export-coordinate-space";
import {
  cssToPdf,
  cssToPdfX,
  cssToPdfXDocumentSpace,
  type ExportContext,
} from "./export-coordinate-space";

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

/**
 * F3B-6.28 · D-3B-4：提取某页内容流里的全部 showText 算子（`(y, text)` 对）。
 *
 * 只服务「重绘前清除完整性核验」：判断某行原始 baseline 附近是否还有**非空**算子。
 * y 为 **CTM 合成后的有效 PDF 空间 y**（与 Sidecar `pdfTransform[5]` 同坐标系）；
 * 解析与剥离口径同源（同一 tokenizer、同一类算子形态）。
 *
 * ★ 历史缺陷（2026-10-19 修复）：旧实现用正则直取原始 Tm 的 f 分量，页面带
 *   y 翻转 cm 时与有效 y 差一个镜像 ⇒ 在镜像位置假阳性（详见
 *   `collectShowTextOpsFromStream` 头注与 export-redraw-verify.ts）。
 */
function collectShowTextOps(pdf: PDFDocument, page: PDFPage): StreamOpLike[] {
  const contents = page.node.get(PDFName.of("Contents"));
  if (!contents) return [];
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const ops: StreamOpLike[] = [];
  for (const ref of refs) {
    const text = readStreamText(pdf, ref as unknown as PDFRef);
    if (text === null) continue;
    for (const op of collectShowTextOpsFromStream(text)) ops.push(op);
  }
  return ops;
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
  // [STRIP-B2] 临时诊断计数器（可移除；仅观察，不改变逻辑）
  let writeBackCount = 0;
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
    // ★ 2026-10-22：strip 的 PDF 页定位 = **page.index - 1**（0-based PDF 页号）。
    //   **不能用数组下标**——懒加载子文档（pages=[第1页,第11页]）的下标 1 会把
    //   第 11 页的算子剥离落到 PDF 第 2 页 ⇒ 旧文字残留、重绘与之叠画。全量文档
    //   （index = 下标+1）二者等价 ⇒ 行为不变。缺 index ⇒ 退回下标（fail-open）。
    const pdfPageIdx =
      typeof (page as { index?: unknown }).index === "number" &&
      Number.isFinite((page as { index: number }).index) &&
      (page as { index: number }).index >= 1
        ? (page as { index: number }).index - 1
        : pageIdx;
    if (pdfPageIdx < 0 || pdfPageIdx >= pdf.getPageCount()) continue;

    const opIds = new Set<string>();

    // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
    console.log("[STRIP-B2] A-doc-traversal start", { pageIdx, pdfPageIdx });
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

        // M7.9-ORPHAN-FIX：并入「缩短编辑中被丢弃原 glyph」的孤儿算子。
        // 这些算子承载的原文仍留在 content stream 中，但其对应原 glyph 已不在
        // line.glyphs 里（新文本更短时被丢弃，如 "100%"→"99%" 的尾部 "%"），
        // 故上面遍历 line.glyphs 的循环永远收集不到它们 → 不剥离 → 旧文字与新绘制
        // 文本叠加成重影。行级 droppedOperatorIds 由 mutateLineText 累加，此处消费。
        //
        // ★ F3B-6.28 · D 第一阶段：**不再要求 isEditedLine**。
        //   `droppedOperatorIds` 的语义是「这一行的这些原算子必须被移除」的显式清单。
        //   段落重排会推移**后续原始行**（文本未变、未被标记 edited），Binding 投影
        //   （affected-source-projection 的 displacedLines）把它们登记进来 ⇒ 其旧位置
        //   原算子必须剥离，否则位移后新旧文字重叠（D2 实测：l7..l20 全不位移 + 注入行叠字）。
        //   legacy 路径（mutateLineText 写入）本就在 edited 行上，行为不变；
        //   非编辑行此前该字段恒空 ⇒ 本次放开只影响 Binding 的显式声明。
        if (line.droppedOperatorIds?.length) {
          for (const id of line.droppedOperatorIds) {
            opIds.add(id);
            const set = lineOpIds.get(key) ?? new Set<string>();
            set.add(id);
            lineOpIds.set(key, set);
          }
        }
      }
    }
    // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
    console.log("[STRIP-B2] A-doc-traversal done", { opIds: opIds.size, lines: lineOpIds.size });
    // ② 本页算子记录（streamRef 分组 / 文本匹配兜底）
    let metaRecords: TextShowRecord[] = [];
    // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
    console.log("[STRIP-B2] B-resolvePageShowTextWithXObjects start");
    try {
      metaRecords = resolvePageShowTextWithXObjects(pdf, pdfPageIdx);
    } catch {
      continue;
    }
    console.log("[STRIP-B2] B-resolvePageShowTextWithXObjects done", { records: metaRecords.length });
    const metaById = new Map<string, TextShowRecord>();
    for (const r of metaRecords) metaById.set(r.operatorId, r);

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
        // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
        console.log("[STRIP-B2] C-textFallback start");
        const ids = textFallbackStripLine(line, metaRecords);
        console.log("[STRIP-B2] C-textFallback done", { ids: ids.length });
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
    // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
    console.log("[STRIP-B2] D-targetsByStream start");
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
    // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
    console.log("[STRIP-B2] D-targetsByStream done", {
      streams: targetsByStream.size,
      opIds: opIds.size,
    });

    // ④ 按 stream 回填（从后往前，带 delta 偏移，避免漂移）
    for (const [streamRef, targets] of targetsByStream) {
      // M7.8-040R-3 Bug A：streamObjRef==="embedded" 为内联页面内容流（直接流对象），
      // 不能走 ctx.pdf.stream("embedded")（非法间接引用），需直接拿流对象解析/回写。
      // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
      console.log("[STRIP-B2] E-stream-read start", { streamRef });
      let original: string | null = null;
      let writeBack: ((text: string) => void) | null = null;
      if (streamRef === "embedded") {
        const obj = getEmbeddedContentStream(pdf, pdfPageIdx);
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
          // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
          console.log("[STRIP-B2] writeBack", { streamRef, n: ++writeBackCount, kind: "embedded" });
          const nb = new Uint8Array(text.length);
          for (let i = 0; i < text.length; i++) nb[i] = text.charCodeAt(i) & 0xff;
          const pg = pdf.getPage(pdfPageIdx) as any;
          pg.node.set(
            PDFName.of("Contents"),
            pdf.context.register(pdf.context.stream(nb)),
          );
          console.log("[STRIP-B2] writeBack-done", { streamRef, n: writeBackCount, kind: "embedded" });
        };
      } else {
        const refParts = streamRef.split(" ").map(Number);
        const ref = PDFRef.of(refParts[0], refParts[1] ?? 0);
        original = readStreamText(pdf, ref);
        if (original == null) continue;
        writeBack = (text: string) => {
          // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
          console.log("[STRIP-B2] writeBack", { streamRef, n: ++writeBackCount, kind: "ref" });
          try {
            writeStreamText(pdf, ref, text);
          } finally {
            console.log("[STRIP-B2] writeBack-done", { streamRef, n: writeBackCount, kind: "ref" });
          }
        };
      }
      // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
      console.log("[STRIP-B2] E-stream-read done", { streamRef, originalLen: original?.length ?? -1 });
      // [STRIP-B2] 临时诊断 marker —— 直接使用已存在的 original，不做额外计算
      console.log("[STRIP-B2] stream-start", {
        streamRef,
        targets: targets.length,
        originalLen: original.length,
      });
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
      // [STRIP-B2] 临时诊断 marker（可移除；仅观察）
      console.log("[STRIP-B2] stream-done", { streamRef });
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
function textFallbackStripLine(line: EditableLine, metaRecords: TextShowRecord[]): string[] {
  const ops = metaRecords
    .filter((r) => r.charCodes !== null && (r.unicodeText !== undefined || r.operatorText))
    .sort((a, b) => a.byteStart - b.byteStart);
  if (ops.length === 0) return [];
  // 拼完整流文本（保留原样用于区间映射），同时记录每个算子的 [start, end)
  let full = "";
  const ranges: { id: string; start: number; end: number }[] = [];
  for (const op of ops) {
    const t = op.unicodeText ?? op.operatorText ?? "";
    ranges.push({ id: op.operatorId, start: full.length, end: full.length + t.length });
    full += t;
  }
  const norm = (s: string) => s.replace(/\s+/g, "");
  // 重建「行原文字」：未编辑 glyph 直接用 char（即原文）；已编辑 glyph 用 originalChar
  // （插入字符的 originalChar 已为 undefined → 视为空，不污染匹配）；空格等布局字符照常。
  const target = norm(
    line.glyphs
      .map((g) => (!g.modified ? g.char : (g.originalChar ?? "")))
      .join(""),
  );
  if (!target) return [];
  const idx = norm(full).indexOf(target);
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
  return ranges.filter((r) => r.end > lo && r.start < hi).map((r) => r.id);
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
// ─────────────────────────────────────────────────────────────────────────────
// ★ 2026-10-26 · 显示层 segflow 链式位移的**导出对等**（窄口径）
//
// 结构事实（本轮探针 __dyline 实证）：Core Layout 按 TextBox 固定锚布局 —— 编辑段
// 折成 2 视觉行后，其第 2 行（Core y=857.02）**压进下一行（l26，Core 仍锚原位
// 860.04）的行带**（重叠 81%）。显示层由 segFlowOverlays 链式位移承担；导出此前
// 完全没有该机制 ⇒ 新增视觉行与下一行文字叠印、下一行被编辑后新旧文字错带分裂。
//
// 口径（与 PDFEditor segflow effect 同源，纯几何、无 padding 膨胀）：
//   · overflow = 编辑 legacy 行的 Core 布局底部 − 原始行带底部（≥ 0.6×行高才算）；
//   · 位移传播给**下方各行**（dy = overflow 起步），遇 dy ≤ 0.5 终止；
//   · **窄口径**：只有「本来就会被重绘的编辑行」消费 dy —— 未编辑行由原内容流承担、
//     其字形无法用原字体重绘（measured-only = Standard 14 会改字体），故链遇到
//     未编辑行即停（其行带间隙吸收位移，与本场景一致）。
// 缓存：按 pageBlocks 数组实例 WeakMap，保证同页各 block 计算一致且零重复开销。
// ─────────────────────────────────────────────────────────────────────────────
const pageDisplacementDyCache = new WeakMap<object, Map<EditableLine, number>>();

function pageDisplacementDyOf(pageBlocks: EditableBlock[]): Map<EditableLine, number> {
  const cached = pageDisplacementDyCache.get(pageBlocks);
  if (cached) return cached;
  const dyMap = new Map<EditableLine, number>();
  try {
    // ① 按 legacy lineId 聚合视觉行（Core 当前带 + 原始带）；同时保留视觉行对象引用
    type Agg = {
      id: string;
      coreTop: number;
      coreBottom: number;
      origTop: number;
      origBottom: number;
      h: number;
      edited: boolean;
    };
    const byId = new Map<string, Agg>();
    const visualLinesById = new Map<string, EditableLine[]>();
    for (const block of pageBlocks) {
      if (block.type !== "text") continue;
      for (const line of block.lines) {
        const coreTop = Math.min(line.bbox?.y ?? Infinity, ...line.glyphs.map((g) => g.bbox?.y ?? Infinity));
        const coreBottom = Math.max(
          (line.bbox?.y ?? -Infinity) + (line.bbox?.height ?? 0),
          ...line.glyphs.map((g) => (g.bbox?.y ?? -Infinity) + (g.bbox?.height ?? 0)),
        );
        if (!Number.isFinite(coreTop) || !Number.isFinite(coreBottom)) continue;
        const h = coreBottom - coreTop;
        if (!(h > 1)) continue;
        const edited = line.edited === true || line.glyphs.some((g) => g.modified);
        let origTop = coreTop;
        let origBottom = coreBottom;
        if (edited) {
          const eob = line.editedOriginalBounds?.[0];
          const obTops = line.glyphs.map((g) => g.originalBBox?.y).filter((v): v is number => typeof v === "number");
          const obBottoms = line.glyphs
            .map((g) => (g.originalBBox ? g.originalBBox.y + g.originalBBox.height : undefined))
            .filter((v): v is number => typeof v === "number");
          if (eob) {
            origTop = eob.y;
            origBottom = eob.y + eob.height;
          } else if (obTops.length > 0) {
            origTop = Math.min(...obTops);
            origBottom = Math.max(...obBottoms);
          }
          // ⚠️ 刻意**不做**「新折出视觉行」的 orig 替换：聚合按 legacy 行取 min/max，
          //   折出行携带的共享 eob（= legacy 原始带）正是聚合想要的原始带 ——
          //   在视觉行粒度替换会让聚合 origBottom 被抬到 coreBottom ⇒ 溢出恒 0（实测回归）。
          //   折出行自身不会被链位移（它属于 src.id，被 `s.id === src.id` 排除）。
        }
        const id = line.id ?? `__anon__${byId.size}`;
        const prev = byId.get(id);
        if (!prev) {
          byId.set(id, { id, coreTop, coreBottom, origTop, origBottom, h, edited });
          visualLinesById.set(id, [line]);
        } else {
          prev.coreTop = Math.min(prev.coreTop, coreTop);
          prev.coreBottom = Math.max(prev.coreBottom, coreBottom);
          prev.origTop = Math.min(prev.origTop, origTop);
          prev.origBottom = Math.max(prev.origBottom, origBottom);
          prev.h = Math.max(prev.h, h);
          prev.edited = prev.edited || edited;
          visualLinesById.get(id)!.push(line);
        }
      }
    }
    // ② 每个溢出的编辑行 → 链式位移其下方（仅编辑行消费；遇未编辑行终止）
    const sorted = [...byId.values()].sort((a, b) => a.origTop - b.origTop);
    for (const src of sorted) {
      if (!src.edited) continue;
      const overflow = src.coreBottom - src.origBottom;
      if (!(overflow >= src.h * 0.6)) continue; // 无实质溢出 ⇒ 零波及（与显示层同判据）
      let shift = overflow;
      let prevNewBottom = src.coreBottom;
      for (const s of sorted) {
        if (s.id === src.id) continue;
        if (s.origTop <= src.origTop + 1) continue; // 只看下方
        if (!s.edited) break; // 窄口径：未编辑行不重绘 ⇒ 链终止（间隙吸收）
        const newTop = Math.max(s.origTop + shift, prevNewBottom + 2);
        const dy = newTop - s.origTop;
        if (dy <= 0.5) break; // 与显示层同：位移被吸收 ⇒ 终止
        for (const vl of visualLinesById.get(s.id) ?? []) dyMap.set(vl, Math.max(dyMap.get(vl) ?? 0, dy));
        prevNewBottom = newTop + s.h;
        shift = dy;
      }
    }
  } catch {
    /* 位移判定失败 ⇒ 无位移（fail-open 回退既有行为） */
  }
  pageDisplacementDyCache.set(pageBlocks, dyMap);
  return dyMap;
}

export function renderBlockToExportCommands(
  block: EditableBlock,
  styles: EditableStyle[],
  ctx: ExportContext,
  pageIndex = 0,
  /** M7.7-006: 编辑态记录的真实墨迹覆盖盒（lineId → CSS bbox）。导出 mask 用它而非模型 bbox。 */
  editedLineBoxes?: Map<string, BBox>,
  /** M7.8-035R: 当前页所有 block，跨 block 找下一行顶。 */
  pageBlocks?: EditableBlock[],
  /** ★ 2026-10-26 组键碰撞修复：本 block 实例的唯一组键前缀（`blockId#bi`）。 */
  groupKeyBase?: string,
): ExportCommand[] {
  if (block.type !== "text") return [];
  // ★ 临时 freshness 标记（导出专项）：确认浏览器执行的是本文件
  console.log("[DYMARK-20261026]", String(block.id ?? "?").slice(-8));

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

  // ★ 2026-10-26：显示层 segflow 链式位移的导出对等（窄口径，见函数头注释）。
  const dyByLine = pageBlocks ? pageDisplacementDyOf(pageBlocks) : null;


  // 逐行导出：仅非 native-ready / 未触碰的行需要 overlay（per-line mask + glyph 重绘）
  for (let li = 0; li < block.lines.length; li++) {
    const line = block.lines[li];
    const lineKey = nativeLineKey(block.id, li);
    const lineEdited = line.glyphs.some((g) => g.modified) || line.edited === true;

    // ── F3B-6.28 · D-3B-2：整行重绘（flow 成员行 + 被推移的位移行）─────────
    //   唯一入口 = `line.redrawLines`（Binding 侧**只在** unit 编辑计划有效时挂载；
    //   未挂载 ⇒ 本段整体不执行 ⇒ 产物与既有实现逐字节一致）。
    //   ⚠️ 纪律：本段**不**参与既有写入资格判定（不改 `glyph.modified`、不放宽 raw-CID
    //     检查、不触发 native replay），只追加独立的重绘命令。
    //   ⚠️ 必须**先于** `skipOverlay`：`skipOverlay` 的语义是「原 PDF 内容流已承担该行
    //     新文本」，而显式重绘几何意味着「内容流已被剥离、必须由我们重绘」—— 二者互斥，
    //     不能让 skipOverlay 吃掉重绘（实测：单视觉行 block 的 lineKey 恒为
    //     `blockId:0`，一旦该 key 被判 native-replaced，l6..l20 的重绘会被全部跳过）。
    const redrawLines = (line as unknown as { redrawLines?: readonly LineRedrawGeometry[] | null })
      .redrawLines;
    const hasRedraw = !!redrawLines && redrawLines.length > 0;
    // 该行属于「已被重绘覆盖的 Core 段落」（几何被同段落的另一条视觉行认领）
    // ⇒ 文字已由 flow 重绘画出，绝不能再走既有 overlay（否则同一段文字画两遍）。
    const redrawCovered =
      !hasRedraw && (line as unknown as { redrawCovered?: boolean }).redrawCovered === true;
    if (redrawCovered) continue;
    if (hasRedraw) {
      for (const r of redrawLines!) {
        commands.push({
          type: "drawRedrawLine",
          pageIndex,
          blockId: block.id,
          lineIndex: li,
          lineId: line.id,
          role: r.role,
          flowIndex: r.flowIndex ?? null,
          text: r.text,
          box: { x: r.box.x, y: r.box.y, width: r.box.width, height: r.box.height },
          baselinePt: r.baselinePt,
          originalBaselinePt: r.originalBaselinePt,
          deltaCss: r.deltaCss,
          glyphs: r.glyphs.map((g) => ({
            char: g.char,
            sourceLineId: g.sourceLineId,
            sourceGlyphIndex: g.sourceGlyphIndex,
            pdfCharCode: g.pdfCharCode,
            fontRef: g.fontRef,
            pdfTransform: g.pdfTransform ? [...g.pdfTransform] : null,
            targetXPt: g.targetXPt,
            targetBaselinePt: g.targetBaselinePt,
            disposition: g.disposition,
          })),
        } as DrawRedrawLineCommand);
      }
      // 未编辑的位移行（l7..l20 等）只需重绘命令、**不需要** mask（原算子已由 drop 投影
      // 剥离；画 mask 只会白白擦掉行内表格线）⇒ 直接跳到下一行。
      if (!lineEdited) continue;
    }

    const skipOverlay =
      routing.replacedLines.has(lineKey) || routing.fullyReplacedBlocks.has(block.id);
    if (skipOverlay && !hasRedraw) {
      // ★ 2026-10-25（用户缺陷「修改后导出的 PDF 文本重复」）：native-replaced 行的
      //   新文本由内容流 native replay 承担，但**剥离**依赖 glyph provenance
      //   （operatorId）。再导出产物重导入 / OCR 文本层的 glyph 常无 operatorId
      //   ⇒ drop 投影 `droppedOperatorIds` 为空 ⇒ 原算子无法定位剥离 ⇒ 原文残留
      //   与 replay 新文本叠加 = 双层文本（实测复现 leak1024i：原两行 + 重绘两行）。
      //   此时 drop 投影的 `editedOriginalBounds`（原文真实区域，来自 Sidecar
      //   sourceBBoxes）仍然可用 ⇒ 强制区域遮盖：白块盖住原文本带（replay 新文本
      //   在流中先行绘制，本命令追加在后 ⇒ 只盖原文不盖新文本）。
      //   门控（极窄）：仅 `droppedOperatorIds` **为空**（剥离不可能）且
      //   `editedOriginalBounds` 非空（原文区域已知）的行；有算子的行走既有剥离，
      //   纯插入行（无 source glyph）无 bounds ⇒ 不触发 ⇒ 正常文档零波及。
      const residualOps = (line as unknown as { droppedOperatorIds?: readonly string[] }).droppedOperatorIds;
      const residualBounds = (line as unknown as { editedOriginalBounds?: readonly BBox[] }).editedOriginalBounds;
      if (
        residualOps !== undefined &&
        residualOps.length === 0 &&
        residualBounds !== undefined &&
        residualBounds.length > 0
      ) {
        for (const ob of residualBounds) {
          const pdfRect = cssToPdf(
            {
              x: ob.x - MASK_PADDING_X,
              y: ob.y - MASK_PADDING_Y,
              width: ob.width + MASK_PADDING_X * 2,
              height: ob.height + MASK_PADDING_Y * 2,
            },
            ctx,
          );
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
      }
      continue;
    }

    // M7.8-034 Phase B：只为「真正被编辑的行」生成 mask + 既有 overlay 重绘。
    // 未编辑的行完全不碰，由原 PDF 内容流原样呈现（像素级零损伤）。
    //（`lineEdited` 已在循环开头计算 —— 重绘分支先于此处使用。）
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
    // [TEMP-H1H2] l6 ink 判据诊断（只读）
    try {
      const lidH = line.id ?? "(no-id)";
      if (String(block.id ?? "").includes("block0")) {
        let bboxPresent = 0, bboxZero = 0, bboxNonFinite = 0;
        for (const g of line.glyphs) {
          const bb = g.originalBBox ?? g.bbox;
          if (!bb) continue;
          bboxPresent += 1;
          if (!(bb.width > 0) || !(bb.height > 0)) bboxZero += 1;
          if (!Number.isFinite(bb.x + bb.y + bb.width + bb.height)) bboxNonFinite += 1;
        }
        (window as any).__h12 ??= [];
        (window as any).__h12.push({
          lineId: lidH, glyphCount: line.glyphs.length,
          bboxPresent, bboxZero, bboxNonFinite,
          inkMinX: Number.isFinite(inkMinX) ? Math.round(inkMinX * 100) / 100 : null,
          inkMaxX: Number.isFinite(inkMaxX) ? Math.round(inkMaxX * 100) / 100 : null,
          inkMinY: Number.isFinite(inkMinY) ? Math.round(inkMinY * 100) / 100 : null,
          inkMaxY: Number.isFinite(inkMaxY) ? Math.round(inkMaxY * 100) / 100 : null,
          inkBranch: inkMaxX > inkMinX && inkMaxY > inkMinY,
          hasRealBox: Boolean(realBox),
        });
      }
    } catch { /* ignore */ }
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
      // ══ P0-2：multi-visual-line detection → bypass legacy line-level clamp ════
      //
      // ★ 结构性矛盾判据（无 magic threshold）：
      //   `nextTop` 定义为「本行墨迹【之下】的最近一行顶」，单视觉行时必然 ≥ inkMaxY；
      //   `prevBottom` 对称。若落入本行 ink 内部 ⇒ 唯一解释 = 本 legacy line 实际
      //   包含多个 visual rows（编辑 reflow / reload 拓扑改变）⇒ 行级钳制把 mask
      //   推到错误位置（实测：ink [364,431]，mask 被推到 [428,496] ⇒ 原文 100% 漏盖）。
      //
      // ★ fail-safe：让两个钳制输入失效（undefined）⇒ 走**既有路径**，
      //   mask 窗口自然退化为完整 ink union（inkTop/inkBottom + padding）。
      //   普通单视觉行 PDF 逐字节走旧路径（判据不触发）。
      const nextTopInside = nextTop !== undefined && nextTop > inkMinY + 0.001 && nextTop < inkMaxY - 0.001;
      const prevBottomInside = prevBottom !== undefined && prevBottom > inkMinY + 0.001 && prevBottom < inkMaxY - 0.001;
      if (nextTopInside || prevBottomInside) {
        if (process.env.MASK_DIAG === "1") {
          console.log(
            `[MASK_DIAG][P02-UNION] line=${line.id} inkMinY=${inkMinY.toFixed(2)} inkMaxY=${inkMaxY.toFixed(2)} ` +
            `nextTopInside=${nextTopInside} prevBottomInside=${prevBottomInside}`
          );
        }
        nextTop = undefined;
        prevBottom = undefined;
        // baseline 估算同样不可信（跨视觉行 ⇒ baseline 属于某一个 visual row），
        // 强制用真实 ink union：直接还原 inkTop/inkBottom 到墨迹极值。
        inkTop = inkMinY;
        inkBottom = inkMaxY;
        my = inkTop - MASK_PADDING_Y;
      }
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
      const rawRects: { x: number; y: number; width: number; height: number; src?: string }[] = [];
      // [TEMP-Db] D-b：li=0/1 glyph geometry 存在率 + 真实 guard 命中统计（只读）
      try {
        const lid = line.id ?? "";
        if (String(lid).includes("block0_l")) {
          const stats = { glyphCount: line.glyphs.length, bboxPresent: 0, originalBBoxPresent: 0, baselinePresent: 0, guard_noB1B2: 0, guard_nonFinite: 0, guard_rbLeRy: 0, guard_wideSpace: 0, passed: 0, missingSample: [] as any[] };
          line.glyphs.forEach((g: any, gi: number) => {
            if (g.bbox) stats.bboxPresent += 1;
            if (g.originalBBox) stats.originalBBoxPresent += 1;
            if (typeof g.baseline === "number" && Number.isFinite(g.baseline)) stats.baselinePresent += 1;
            const bw = g.bbox?.width ?? 0;
            const isWideSpace = (g.char === " " || g.originalChar === " ") && bw > maxNormalWidth;
            const b1 = g.originalBBox ?? g.bbox;
            const b2 = g.bbox;
            if (!b1 && !b2) { stats.guard_noB1B2 += 1; if (stats.missingSample.length < 3) stats.missingSample.push({ gi, char: g.char, bbox: g.bbox ?? null, originalBBox: g.originalBBox ?? null, baseline: g.baseline ?? null }); return; }
            const minX = Math.min(b1?.x ?? Infinity, b2?.x ?? Infinity);
            const minY = Math.min(b1?.y ?? Infinity, b2?.y ?? Infinity);
            const maxX = Math.max(b1 ? b1.x + b1.width : -Infinity, b2 ? b2.x + b2.width : -Infinity);
            const maxY = Math.max(b1 ? b1.y + b1.height : -Infinity, b2 ? b2.y + b2.height : -Infinity);
            if (!Number.isFinite(minX + minY + maxX + maxY)) { stats.guard_nonFinite += 1; return; }
            const ryD = Math.max(lineMaskTop, minY - MASK_PADDING_Y);
            const rbD = Math.min(lineMaskBottom, maxY + MASK_PADDING_Y);
            if (rbD <= ryD) { stats.guard_rbLeRy += 1; if (stats.guard_rbLeRy <= 2) stats.missingSample.push({ gi, char: g.char, minY: Math.round(minY * 100) / 100, maxY: Math.round(maxY * 100) / 100, reason: "rbLeRy" }); return; }
            if (isWideSpace) { stats.guard_wideSpace += 1; return; }
            stats.passed += 1;
          });
          (window as any).__db ??= [];
          (window as any).__db.push({ lineId: lid, li, ...stats, lineMaskTop: Math.round(lineMaskTop * 100) / 100, lineMaskBottom: Math.round(lineMaskBottom * 100) / 100 });
        }
      } catch { /* ignore */ }
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
        rawRects.push({ x: rx, y: ry, width: maxX - minX + MASK_PADDING_X * 2, height: rb - ry, src: "glyph" });
        // [TEMP-P02] per-rect 来源取证（只读）
        try {
          (window as any).__p02rects ??= [];
          (window as any).__p02rects.push({
            lineId: line.id ?? "?", src: "glyph", char: g.char, orig: g.originalChar ?? null,
            b1: b1 ? { x: Math.round(b1.x * 100) / 100, y: Math.round(b1.y * 100) / 100, w: Math.round(b1.width * 100) / 100, h: Math.round(b1.height * 100) / 100 } : null,
            b2: b2 ? { x: Math.round(b2.x * 100) / 100, y: Math.round(b2.y * 100) / 100, w: Math.round(b2.width * 100) / 100, h: Math.round(b2.height * 100) / 100 } : null,
            rect: { x: Math.round(rx * 100) / 100, y: Math.round(ry * 100) / 100, w: Math.round((maxX - minX + MASK_PADDING_X * 2) * 100) / 100, h: Math.round((rb - ry) * 100) / 100 },
          });
        } catch { /* ignore */ }
      }

      // M7.8-FIX：兜底覆盖「被替换子串的原始位置」。当一行被编辑、但原 PDF 文本算子既无法
      // 被剥离（provenance 缺失）也无法被 native replay 原位替换（字体子集缺口）时，旧文字
      // 仍残留在 content stream 中。此时上方逐字形 mask 只覆盖「新文本」位置，可能漏掉旧文本
      // （重影）。editedOriginalBounds 记录各段被替换子串的原始 bbox（由 mutateLineText 累加捕获），
      // 把它们作为额外 mask 矩形并入，即可盖住旧文本。水平只覆盖被替换的列内区域（不会误擦列间
      // 竖线），垂直被 lineMaskTop/Bottom 钳制（不会擦掉上下表格线）。
      if ((line.glyphs.some((g) => g.modified) || line.edited) && line.editedOriginalBounds?.length) {
        for (const ob of line.editedOriginalBounds) {
          // ★★ E-d-1（P0-2）：editedOriginalBounds = 原始 PDF 文字真实位置（覆盖责任的第一手事实），
          //   **不受 reflow 后 lineMaskTop/Bottom 垂直裁剪**。
          //   实测（E-c）：reload 重排后 para 行窗口 [382.61,410.07] 把原文 bbox (y364.15,h21.46)
          //   裁成 6px(4.5pt) 残片 ⇒ 原文 y364–382 段漏盖 ⇒ anchor×2。
          //   邻行保护语义只适用于 per-glyph 流水段（上方分支）；eob 是原文覆盖责任，完整保留。
          const rx = ob.x - MASK_PADDING_X;
          const ry = ob.y - MASK_PADDING_Y;
          const rb = ob.y + ob.height + MASK_PADDING_Y;
          if (rb > ry) {
            rawRects.push({ x: rx, y: ry, width: ob.width + MASK_PADDING_X * 2, height: rb - ry, src: "eob" });
          }
          // [TEMP-Ec] eob 分支取证（只读）：preClamp/postClamp 全量
          try {
            (window as any).__p02eob ??= [];
            (window as any).__p02eob.push({
              lineId: line.id ?? "?", lineIndex: li,
              sourceBBox: { x: Math.round(ob.x * 100) / 100, y: Math.round(ob.y * 100) / 100, w: Math.round(ob.width * 100) / 100, h: Math.round(ob.height * 100) / 100 },
              preClamp: { y: Math.round((ob.y - MASK_PADDING_Y) * 100) / 100, h: Math.round((ob.height + MASK_PADDING_Y * 2) * 100) / 100 },
              maskTop: Math.round(lineMaskTop * 100) / 100, maskBottom: Math.round(lineMaskBottom * 100) / 100,
              postClamp: { y: Math.round(ry * 100) / 100, h: Math.round((rb - ry) * 100) / 100 },
              clamped: ob.y - MASK_PADDING_Y < lineMaskTop || ob.y + ob.height + MASK_PADDING_Y > lineMaskBottom,
            });
          } catch { /* ignore */ }
        }
      }

      // 合并水平相邻/重叠的 mask，减少 PDF 小矩形数量。
      rawRects.sort((a, b) => a.x - b.x);
      // [TEMP-P02] 行级钳制参数取证（只读）：解释 h=1.5 细条
      try {
        (window as any).__p02line ??= [];
        (window as any).__p02line.push({
          lineId: line.id ?? "?", glyphN: line.glyphs.length,
          inkMinY: Math.round(inkMinY * 100) / 100, inkMaxY: Math.round(inkMaxY * 100) / 100,
          maxBaseline: Number.isFinite(maxBaseline) ? Math.round(maxBaseline * 100) / 100 : null,
          inkTop: Math.round(inkTop * 100) / 100, inkBottom: Math.round(inkBottom * 100) / 100,
          prevBottom: prevBottom !== undefined ? Math.round(prevBottom * 100) / 100 : null,
          nextTop: nextTop !== undefined ? Math.round(nextTop * 100) / 100 : null,
          maskTop: Math.round(lineMaskTop * 100) / 100, maskBottom: Math.round(lineMaskBottom * 100) / 100,
          mh: Math.round(mh * 100) / 100,
          editedOriginalBoundsN: line.editedOriginalBounds?.length ?? 0,
          // ★ E-b-0：editedOriginalBounds 内容（原文真实位置 vs mask 窗口对照）
          editedOriginalBounds: (line.editedOriginalBounds ?? []).map((ob: any) => ({
            x: Math.round(ob.x * 100) / 100, y: Math.round(ob.y * 100) / 100,
            w: Math.round(ob.width * 100) / 100, h: Math.round(ob.height * 100) / 100,
          })),
        });
      } catch { /* ignore */ }
      for (const r of rawRects) {
        const last = maskRects[maskRects.length - 1] as any;
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
          // [TEMP-Ed2] 观测：合并后 src 归属（不改合并行为）
          if (last.src !== r.src) last.src = "mixed";
        } else {
          maskRects.push({ ...r } as any);
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
      // [TEMP-Ed2] console 直打（与 C2 同机制，绕开 window 传输）
      if (typeof console !== "undefined") {
        console.log("[ED2CMD]", JSON.stringify({
          lineId: line.id ?? "?", lineIndex: li, src: (rect as any).src ?? "unknown",
          cssW: Math.round(rect.width * 100) / 100, cssH: Math.round(rect.height * 100) / 100,
        }));
      }
      // [TEMP-P02b] 最终 mask command 来源取证（只读）：rect → line → 阶段
      try {
        (window as any).__p02cmd ??= [];
        (window as any).__p02cmd.push({
          blockId: block.id, lineIndex: li, lineId: line.id ?? "?",
          src: (rect as any).src ?? "unknown",
          nMaskRects: maskRects.length,
          mode: (nextTop === undefined && prevBottom === undefined) ? "P02-UNION" : "legacy",
          css: { x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, w: Math.round(rect.width * 100) / 100, h: Math.round(rect.height * 100) / 100 },
          pdf: { x: Math.round(pdfRect.x * 100) / 100, y: Math.round(pdfRect.y * 100) / 100, w: Math.round(pdfRect.width * 100) / 100, h: Math.round(pdfRect.height * 100) / 100 },
        });
      } catch { /* ignore */ }
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
    // RAW-FALLBACK-01 · 修正 2 A-direct（受控分支，默认关）：预扫同行 raw glyph 的
    // `baseline` 字段（adapter L311 = pdfYToCssY(pdfY) 第一手 CSS 基线，零公式复用）。
    // 参考失效（无 raw glyph/重排）⇒ undefined ⇒ fail-closed 回退修正 1 兜底。
    let directRawCssBaseline: number | undefined;
    if (isRawFallbackDirectBaselineEnabled()) {
      const rawGlyph = line.glyphs.find((g: any) => Number.isFinite(g?.baseline));
      if (rawGlyph) directRawCssBaseline = rawGlyph.baseline;
    }
    // F3B-6.28 · D-3B-2：本行文字已由上面 push 的 `drawRedrawLine` 命令承担
    //   ⇒ 跳过既有逐 glyph overlay 与邻行重绘块（否则同一行被画两遍）。
    if (hasRedraw) continue;
    for (const glyph of line.glyphs) {
      // ★ 2026-10-25（用户缺陷「修改后导出的 PDF 文本重复」）：
      //   PRESERVE 模式原本优先 `originalBBox`（原 PDF 第一手位置）。对**未重排**的编辑
      //   行（原位=新位）二者一致；但段落被 Core 重排（折行点移动）后，后续视觉行的
      //   原字符 `originalBBox` 仍指向**原文旧视觉行**的位置（Sidecar sourceBBox 是
      //   import 期原文几何）——用它定位重绘会把整行新文本画回旧行带 ⇒ 与前一视觉行
      //   叠印（实测 leak1024i：行 1 "afastamento doX" 画在行 0 带 x=565.55 上）。
      //   判据（确定性、非启发式）：originalBBox 的垂直带与**本行当前行带**的重叠
      //   ≥ 自身高度的一半 ⇒ 原位在本行带内（原位=新位），沿用 originalBBox（保住
      //   未重排行的像素级原位，历史验收零波及）；重叠不足 ⇒ 该字符的原文位于其它
      //   视觉行（重排把后续内容挤到了新行）⇒ 用当前布局 glyph.bbox（Core Layout）。
      //   （贴边不算重叠：相邻行共享 y 边界，实测 leak1024i 行 1 的 originalBBox 底边
      //   恰好等于行 1 顶边 ⇒ 必须用重叠量而非区间包含。）
      //   原文区域的覆盖职责由 mask/editedOriginalBounds 承担（mask 管线不受影响）。
      //   （能走到这里的行都是编辑行——上方 `if (!lineEdited) continue`。）
      const ob = mode === "preserve" ? glyph.originalBBox : undefined;
      const obOverlap =
        ob && line.bbox
          ? Math.min(ob.y + ob.height, line.bbox.y + line.bbox.height) -
            Math.max(ob.y, line.bbox.y)
          : 0;
      const obInCurrentBand = !!ob && obOverlap >= ob.height * 0.5;
      const bbox = ob && obInCurrentBand ? ob : glyph.bbox;
      // ★ 2026-10-26：链式位移（窄口径）。dyLine > 0 ⇒ 本行被显示层 segflow 判定位移，
      //   导出必须同样下移，否则与上方溢出的新视觉行叠印（实测 dezembro 行分裂）。
      //   只平移 y：pdfRect 用**位移后 bbox**；基线相对式保持用**原 bbox**（baseCssY
      //   与 bbox.bottom 同源相对差不变）⇒ 基线自动随 pdfRect 下移，零双重换算。
      //   raw Tm（native replay / raw-CID 直发的第一手矩阵）同步平移 f 分量。
      const dyLine = dyByLine?.get(line) ?? 0;
      const bboxEff = dyLine > 0 ? { ...bbox, y: bbox.y + dyLine } : bbox;

      // ★ 同缺陷：X 契约。glyph.bbox（Core Layout）与 originalBBox（Sidecar sourceBBox）
      //   均为导入侧 CoordinateMapper 产物（×totalScale 空间，与 cssToPdf 的
      //   y/width/height 同口径）；cssToPdf 的 X 分量历史上走 ÷renderScale 特例
      //   （M7.8-048，cssScale===1 时两契约等价）。cssScale≠1 的文档（实测本例
      //   cssScale=0.2995）x 被缩小 cssScale 倍（22.17pt vs 正确 74.0pt）⇒ glyph 绘制
      //   改用 document-space 契约（cssToPdfXDocumentSpace），cssScale=1 时逐位不变。
      const pdfRect = {
        ...cssToPdf(bboxEff, ctx),
        x: cssToPdfXDocumentSpace(bbox.x, ctx),
      };
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
      // RAW-FALLBACK-01 · 修正 1（方案 i′，受控分支，默认关）：bridge glyph 无 baseline
      // 字段 ⇒ 旧兜底用 bbox 底部（bbox-top 语义）⇒ fallback 绘制与 raw 直发（pdfY 第一手）
      // 产生实测 4.47pt 差（a05 同逻辑基线样本，SPEC R5-B）。flag 开启时兜底改用行级
      // baseline（bridge L862 直通 layout CSS baseline；R3 已证同行混排共享基线）。
      // 优先级：glyph.baseline → (flag) line.baseline → bbox 底部（flag 关 = 现状逐位不变）。
      // 三层逻辑提取为 resolveBaseCssY（与专项测试共用，见 export-fallback-baseline-align.ts）。
      const baseCssY = resolveBaseCssY({
        glyphBaseline: glyph.baseline,
        lineBaseline: line.baseline,
        fallbackBaselineAlignEnabled: isFallbackBaselineAlignEnabled(),
        bboxBottom: bbox.y + bbox.height,
        directRawCssBaseline,
        rawFallbackDirectBaselineEnabled: isRawFallbackDirectBaselineEnabled(),
      });
      const baselinePdfY = pdfRect.y + (bbox.y + bbox.height - baseCssY) / totalScale;

      // ── M7.8-036 / BUG-COORD-Y-ROOT-001 只读诊断（临时，判 A/B 用，不改变任何业务逻辑）──
      if (typeof console !== "undefined") {
        console.log("[YDIAG]", {
          char: glyph.char,
          pdfTransform: glyph.metrics?.pdfTransform,
          pdfTransform5: glyph.metrics?.pdfTransform?.[5],
          baseline: glyph.baseline,
          bboxY: glyph.bbox.y,
          bboxHeight: bbox.height,
          pdfY: (glyph as any).pdfY,
          commandBaseline: baselinePdfY,
        });
      }
      // [TEMP-DY] 逐字符绘制来源取证（只读）：ob（原文）vs glyph.bbox（Core 当前）
      try {
        (window as any).__dydiag ??= [];
        (window as any).__dydiag.push({
          lineId: line.id ?? "?", lineIndex: li,
          char: glyph.char,
          modified: !!glyph.modified,
          hasOb: !!ob,
          obY: ob ? Math.round(ob.y * 100) / 100 : null,
          curY: glyph.bbox ? Math.round(glyph.bbox.y * 100) / 100 : null,
          lineY: line.bbox ? Math.round(line.bbox.y * 100) / 100 : null,
          inBand: obInCurrentBand,
          useOb: bbox === ob,
          outY: Math.round(baselinePdfY * 100) / 100,
        });
      } catch { /* ignore */ }

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
        // ★ Step 5B：**行级** export provenance（原字体身份）。
        //   ⚠️ 刻意与上面的 `fontIdentity` 分开：本字段只喂 CID/非 WinAnsi 重绘，
        //   绝不能参与 `isMeasuredOnly` 判定（否则会把普通 WinAnsi 行踢出
        //   M7.8-0XX 的整行单次 drawText，重新打开字距问题）。
        originalFontIdentity: line.originalFontIdentity,
        pdfCharCode: glyph.pdfCharCode ?? glyph.metrics?.pdfCharCode,
        // ★ P0-1：顶层 pdfTransform（bridge raw provenance 注入）与 metrics 同权。
        //   链式位移 ⇒ raw Tm 的 f 分量同步下移（native replay / raw-CID 直发落点一致）。
        pdfTransform: (() => {
          const rawTm = glyph.pdfTransform ?? glyph.metrics?.pdfTransform;
          if (!(dyLine > 0) || !Array.isArray(rawTm) || rawTm.length < 6) return rawTm;
          return [...rawTm.slice(0, 5), (rawTm[5] as number) - dyLine / totalScale] as typeof rawTm;
        })(),
        glyphMetrics: (() => {
          if (!(dyLine > 0) || !glyph.metrics) return glyph.metrics;
          const mt = glyph.metrics.pdfTransform;
          return Array.isArray(mt) && mt.length >= 6
            ? { ...glyph.metrics, pdfTransform: [...mt.slice(0, 5), (mt[5] as number) - dyLine / totalScale] as typeof mt }
            : glyph.metrics;
        })(),
        // ★ 2026-10-26 组键碰撞修复：写阶段按本键分组（block 实例唯一），杜绝
        //   同 legacy blockId 的不同 block 因 lineIndex 归零而并组。
        groupKey: groupKeyBase ? `${groupKeyBase}:${li}` : undefined,
      } as DrawTextGlyphCommand);
    }
    // ── M7.8-024 Step B: 编辑行 mask 若与邻行墨迹真实重叠，用原嵌入字体重绘受影响邻行 ──
    // 不写死 N+1：以 analyzeMaskImpact 的几何相交结果为准（spec §4.1）。
    //
    // ── 4B-4H-FIX（L1）：重绘**只针对**「本身不会被 per-glyph 重绘」的邻行 ──
    //   背景（export command provenance forensic，Case 2 实测）：
    //     编辑使一行折成两行后，两行互为邻行且**都走 per-glyph overlay**；
    //     本段把对方 glyph 再 push 一遍 ⇒ 每 glyph 恰好 ×2
    //     （实测 48→96、24→48；「长」40→80；commands 144 = 72×2）。
    //   语义：本段的存在理由是「native 承载的邻行被 mask 盖住、又没人重绘它」
    //     ⇒ 只有 `routing.replacedLines`（skip-overlay，原 PDF 承载）的邻行才需要重绘；
    //       走 per-glyph overlay 的邻行**本来就会**在本循环内被重绘，再发一遍是纯重复。
    //   ⚠️ 不改 native 邻行的重绘行为（那是本段的原用途）。
    {
      const impact = analyzeMaskImpact(bands, li);
      for (const aj of impact.affectedLineIndices) {
        if (aj === li) continue;
        // ★ L1 修复：邻行本身走 per-glyph overlay（非 skip-overlay）⇒ 会被正常重绘，跳过
        if (!routing.replacedLines.has(nativeLineKey(block.id, aj))) continue;
        const nLine = block.lines[aj];
        if (!nLine || nLine.glyphs.length === 0) continue;
        const nStyleRef = nLine.glyphs[0].styleRef ?? 0;
        const nStyle = styles[nStyleRef] || lineStyle;
        for (const glyph of nLine.glyphs) {
          const nb = mode === "preserve" && glyph.originalBBox ? glyph.originalBBox : glyph.bbox;
          // 邻行若被判链式位移 ⇒ 重绘落点同步下移（与自身行 glyph 循环同口径）
          const nDy = dyByLine?.get(nLine) ?? 0;
          const npdf = cssToPdf(nDy > 0 ? { ...nb, y: nb.y + nDy } : nb, ctx);
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
    // ★ 2026-10-22（用户缺陷「cell 修改提交后没有填写到表格里」）：命令的 pageIndex =
    //   **page.index - 1**（0-based PDF 页号，pdf.getPage 的定位口径）。**不能用数组
    //   下标**——bridge 产物/legacy 文档是懒加载的（跳页访问后 pages=[第1页,第11页]，
    //   下标 1 = 第 11 页）⇒ 下标当页号会把 mask/strip/重绘全部画到 PDF 第 2 页
    //   （实测：导出 PDF 第 2 页多出 20 个 item、第 11 页与原 PDF 逐字节一致）。
    //   全量文档（index = 下标+1）二者等价 ⇒ 行为不变。缺 index ⇒ 退回下标（fail-open）。
    const pageNo =
      typeof (page as { index?: unknown }).index === "number" &&
      Number.isFinite((page as { index: number }).index) &&
      (page as { index: number }).index >= 1
        ? (page as { index: number }).index - 1
        : pi;
    const pageCtx: ExportContext = {
      ...ctx,
      ...pageFlipBase(page, ctx),
    };
    // ★ 2026-10-26（用户缺陷「dezembro 行导出分裂/乱位」·组键碰撞根因）：
    //   bridge 每个 Core TextBox 产出一个 EditableBlock，但 block.id **全部沿用 legacy
    //   blockId**（整页 = "pdf_p1_block0"）⇒ 写阶段 `key = blockId:lineIndex` 中
    //   lineIndex 每 block 从 0 重数 ⇒ 不同 block 的第 1 行**碰撞成同一 key**
    //   （实测：l25-L0 59 glyph + l26 16 glyph 合并成 75-glyph 组，整组按首 glyph
    //   位置一次性绘制 ⇒ 输出乱位、文本层只剩孤立残片）。
    //   修复 = 组键加 **block 实例序号**（`blockId#bi:li`），对每 block 实例唯一；
    //   未携带 groupKey 的命令（legacy/签名路径）走旧键，行为不变。
    page.blocks.forEach((block: EditableBlock, bi: number) => {
      const groupKeyBase = `${block.id}#${bi}`;
      // B3-C-5-C：图片对象 → DrawImageCommand（字节经 EditableBlock.image 直接携带，不经 src/fetch）
      if (block.type === "image") {
        if (!block.image) return;
        const pt = cssToPdf(block.bbox, pageCtx);
        commands.push({
          type: "drawImage",
          pageIndex: pageNo,
          x: pt.x,
          y: pt.y,
          width: pt.width,
          height: pt.height,
          blockId: block.id,
          bytes: block.image.bytes,
          mime: block.image.mime,
        });
        return;
      }
      if (block.type !== "text") return;
      // Sprint 33.5.6: Skip signature blocks (rendered separately)
      if (sigBlockIds.has(block.id)) return;

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
        ...renderBlockToExportCommands(
          block,
          doc.styles,
          pageCtx,
          pageNo,
          editedLineBoxes,
          page.blocks,
          groupKeyBase,
        ),
      );
    });
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

// ─────────────────────────────────────────────────────────────────────────────
//  F3B-6.28 · D-3B-2：整行重绘（flow 成员行 + 位移行）
//
//  定位：**只消费** Binding 侧 `runExportRedrawPipeline` 已算好的目标几何
//  （PDF pt 域，与 `pdfTransform` 同域）。渲染器不重新布局、不重新断行、
//  不做字体/编码决策 —— 那些全在 Binding 侧完成并已由 3B-1 逐行诊断验证。
//
//  两条绘制路径（按字符是否有**完整原始来源**分流）：
//    ① raw-CID 直发：fontRef + CID + 目标 Tm 齐备 ⇒ 原字体 + 原字形 + 目标位置
//       （`emitRawCidGlyphs`，既有实现，零 fontkit 依赖）；
//    ② fallback：新增字符（原 PDF 无对应字形）⇒ 既有覆盖度管线
//       （CID/Type0 → PNG），**绝不伪造 CID / transform**。
// ─────────────────────────────────────────────────────────────────────────────

/** 重绘行的写入回执（验收取证：逐行可核对，绝不静默少画） */
export interface RedrawLineReport {
  readonly lineId: string;
  readonly role: "flow-member" | "displaced-successor";
  readonly flowIndex: number | null;
  /** 目标字符数（= payload 字符数） */
  readonly targetChars: number;
  /** 走 raw-CID（原字体 + 原字形）写入的字符数 */
  readonly rawChars: number;
  /** 走 fallback（CID 覆盖度 → PNG）写入的字符数 */
  readonly fallbackChars: number;
  /** 未写入字符数（必须可观测；> 0 即该行缺字） */
  readonly unwrittenChars: number;
  /**
   * F3B-6.28 · D-3B-4：被判定为「可证明的合成空白」而**有意不画**的字符数。
   * 这些字符在原 PDF 中没有字形（pdf.js 合成空白）⇒ 无墨迹；位置由相邻字符的
   * 绝对 Tm 保持。不计入 `unwrittenChars`（不算缺字）。
   */
  readonly skippedNoInkChars?: number;
  /**
   * F3B-6.28 · D-3B-7：新增字符经**原字体** /ToUnicode 反查 CID 后 raw 直发的数量
   * （`rawChars` 的子集）。> 0 ⇒ 这些编辑字符与原文**同字体**（不再走兜底字体）。
   */
  readonly reverseCidChars?: number;
  /** 实发字体资源名（raw 段；无 ⇒ null） */
  readonly fontRef: string | null;
  readonly targetBaselinePt: number | null;
  /** 实际写入的 baseline（raw 段 = 首个 Tm 的 f 分量；无 ⇒ null） */
  readonly writtenBaselinePt: number | null;
  /** 实际 − 目标（PDF pt） */
  readonly baselineErrorPt: number | null;
  readonly fallbackPath: "none" | "cid" | "png" | "failed";
  /** 跳过 / 失败原因（无 ⇒ null） */
  readonly reason: string | null;
}

function isFiniteTransform6(t: readonly number[] | null | undefined): boolean {
  return (
    !!t && t.length >= 6 && t.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * 行字号（PDF pt）。
 *
 * 优先级：① 原字形 Tm 的 `[a,b]` 模长（Tm 已含 fontSize 缩放 ⇒ 第一手事实）；
 *        ② 行盒高（**全部字符都是新增**时没有 Tm 可依；flow 行盒的 CSS 高
 *           = 该行 line-height ≈ 1em ⇒ 换算到 pt 后即字号。实测 gd-swim：
 *           盒高 15.95pt = 原文 21.457css/1.345 = 15.95pt = 真实字号）。
 */
function redrawFontSizePtOf(cmd: DrawRedrawLineCommand): number {
  for (const g of cmd.glyphs) {
    if (isFiniteTransform6(g.pdfTransform)) {
      const s = Math.hypot(g.pdfTransform![0]!, g.pdfTransform![1]!);
      if (Number.isFinite(s) && s > 0) return s;
    }
  }
  return Math.max(1, cmd.box.height);
}

async function drawRedrawLineToPdf(
  pdf: PDFDocument,
  cmd: DrawRedrawLineCommand,
): Promise<RedrawLineReport> {
  const page = pdf.getPage(Math.min(Math.max(cmd.pageIndex, 0), pdf.getPageCount() - 1));
  const size = redrawFontSizePtOf(cmd);

  let rawChars = 0;
  let fallbackChars = 0;
  /** D-3B-4：被判为「可证明合成空白」而不画的字符数（无墨迹，位置由相邻绝对 Tm 保持） */
  let skippedNoInk = 0;
  /**
   * F3B-6.28 · D-3B-7：新增字符经**原字体** /ToUnicode 反查 CID 后 raw 直发的数量
   * （rawChars 的子集；= 编辑字符与原文字体一致的数量）。
   */
  let reverseChars = 0;
  let writtenBaseline: number | null = null;
  let fontRefSeen: string | null = null;
  let fallbackPath: RedrawLineReport["fallbackPath"] = "none";
  const reasons: string[] = [];

  // ── ①-0 原字体反查预备（D-3B-7：编辑字符与原文字体一致）────────────────
  // 新增字符（disposition=fallback）若能在**原字体**里找到 CID，就用原字体
  // raw-CID 直发，而不是 Liberation/Noto 兜底（CJK 文档的原字体是 CID-keyed
  // 子集字体，fontkit 无 Unicode cmap ⇒ tryDrawNonWinAnsiAsCid 只能兜底）。
  // CID 来源优先级：① 同行原字形同字符（PDF 自己用过的 CID，最权威）
  //                ② 原字体 /ToUnicode 反查（单字符且无歧义才用，见模块头注）
  type G = DrawRedrawLineCommand["glyphs"][number];
  type Abcd = [number, number, number, number];
  /** 行内每个原字体的供体 a..d（= 该字体原字形的缩放/旋转，保字号一致） */
  const lineFontAbcd = new Map<string, Abcd>();
  /** 行内原字形「字符 → (cid, fontRef)」（同行同字符 = PDF 自己的用法） */
  const sameLineCid = new Map<string, { cid: number; fontRef: string }>();
  for (const g of cmd.glyphs) {
    if (
      g.disposition !== "raw" ||
      g.pdfCharCode === null ||
      !Number.isFinite(g.pdfCharCode) ||
      !g.fontRef ||
      !isFiniteTransform6(g.pdfTransform)
    ) {
      continue;
    }
    const t = g.pdfTransform!;
    if (!lineFontAbcd.has(g.fontRef)) lineFontAbcd.set(g.fontRef, [t[0]!, t[1]!, t[2]!, t[3]!]);
    if ([...g.char].length === 1 && !sameLineCid.has(g.char)) {
      sameLineCid.set(g.char, { cid: g.pdfCharCode, fontRef: g.fontRef });
    }
  }
  const reverseByFont = new Map<string, Map<string, number> | null>();
  const reverseFor = (fontRef: string): Map<string, number> | null => {
    const cached = reverseByFont.get(fontRef);
    if (cached !== undefined) return cached;
    let rev: Map<string, number> | null = null;
    try {
      const resolveFont = makeFontDictResolver(
        pdf,
        page.node.get(PDFName.of("Resources")) as unknown as PDFDict,
      );
      // fontRef 可能带前导斜杠（源自 String(PDFName)）；资源查找用去斜杠键
      // （与 emitRawCidGlyphs 的 `replace(/^\//, "")` 同规）
      rev = buildReverseToUnicodeMap(resolveFont(fontRef.replace(/^\//, "")), pdf);
    } catch {
      rev = null;
    }
    reverseByFont.set(fontRef, rev);
    return rev;
  };
  /** 为新增字符解析原字体 CID + 供体 a..d；找不到 ⇒ null（保持既有兜底链） */
  const resolveOriginalCid = (
    g: G,
  ): { cid: number; fontRef: string; abcd: Abcd } | null => {
    if ([...g.char].length !== 1) return null;
    const same = sameLineCid.get(g.char);
    // 字体选择：同行同字符的字体（最权威）⇒ 行内唯一字体 ⇒ 否则不猜（多字体且无同行同字符）
    const fontRef = same?.fontRef ?? (lineFontAbcd.size === 1 ? [...lineFontAbcd.keys()][0]! : null);
    if (!fontRef) return null;
    const abcd = lineFontAbcd.get(fontRef);
    if (!abcd) return null;
    const cid = same && same.fontRef === fontRef ? same.cid : reverseCidOf(reverseFor(fontRef), g.char);
    if (cid === null) return null;
    return { cid, fontRef, abcd };
  };

  // ── ① 分段：连续同源原字形 ⇒ 一组 raw；其余 ⇒ fallback 段 ──────────────
  type Seg =
    | { kind: "raw"; fontRef: string; items: { cid: number; transform: [number, number, number, number, number, number] }[] }
    | { kind: "fallback"; items: G[] };
  const segs: Seg[] = [];
  for (const g of cmd.glyphs) {
    // D-3B-4 决策一：可证明的合成空白 ⇒ **不画**（原 PDF 中本无字形，画空串只会引入噪声）。
    //   `fail` 处置已在进入本函数前由 Pass 1.5 前置校验拒绝（不会走到这里）。
    if (g.disposition === "skip") {
      skippedNoInk += 1;
      continue;
    }
    const rawable =
      g.disposition === "raw" &&
      g.pdfCharCode !== null &&
      Number.isFinite(g.pdfCharCode) &&
      !!g.fontRef &&
      isFiniteTransform6(g.pdfTransform);
    const last = segs[segs.length - 1];
    if (rawable) {
      const t = g.pdfTransform!;
      const item = {
        cid: g.pdfCharCode!,
        transform: [t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!] as [number, number, number, number, number, number],
      };
      if (last && last.kind === "raw" && last.fontRef === g.fontRef) last.items.push(item);
      else segs.push({ kind: "raw", fontRef: g.fontRef!, items: [item] });
    } else if (g.disposition === "fallback") {
      // D-3B-7：新增字符优先原字体反查 CID（同字体 raw 直发；位置用管道算好的目标 Tm）
      const orig = resolveOriginalCid(g);
      if (orig) {
        reverseChars += 1;
        const item = {
          cid: orig.cid,
          transform: [...orig.abcd, g.targetXPt, g.targetBaselinePt] as [
            number, number, number, number, number, number,
          ],
        };
        if (last && last.kind === "raw" && last.fontRef === orig.fontRef) last.items.push(item);
        else segs.push({ kind: "raw", fontRef: orig.fontRef, items: [item] });
      } else if (last && last.kind === "fallback") last.items.push(g);
      else segs.push({ kind: "fallback", items: [g] });
    } else {
      if (last && last.kind === "fallback") last.items.push(g);
      else segs.push({ kind: "fallback", items: [g] });
    }
  }

  for (const seg of segs) {
    if (seg.kind === "raw") {
      // 原字形直发：显式设黑色填充（避免继承到 mask 遗留的白色填充 ⇒ 白字不可见）。
      try {
        page.pushOperators(
          PDFOperator.of(PDFOperatorNames.NonStrokingColorRgb, ["0", "0", "0"]),
        );
      } catch {
        /* 显式填色失败不阻断绘制（既有 raw 路径亦不设色） */
      }
      emitRawCidGlyphs(page, seg.fontRef, seg.items);
      rawChars += seg.items.length;
      fontRefSeen = fontRefSeen ?? seg.fontRef;
      if (writtenBaseline === null) writtenBaseline = seg.items[0]!.transform[5];
      continue;
    }

    // ── ② fallback 段：新增字符（无原始 provenance）─────────────────────
    const text = seg.items.map((g) => g.char).join("");
    if (!text) continue;
    const first = seg.items[0]!;
    // 段宽：由相邻字符的目标 x 差推导逐字 advance（末字沿用前一个 advance）。
    let width = 0;
    for (let i = 0; i < seg.items.length - 1; i += 1) {
      width += seg.items[i + 1]!.targetXPt - seg.items[i]!.targetXPt;
    }
    const adv =
      seg.items.length > 1
        ? width / (seg.items.length - 1)
        : Math.max(size, cmd.box.height / 1.35);
    width += adv;

    let drawn = false;
    try {
      drawn = await tryDrawNonWinAnsiAsCid({
        pdf,
        page,
        pageIndex: cmd.pageIndex,
        text,
        fontIdentity: fontRefSeen ? ({ fontRef: fontRefSeen } as GlyphFontIdentity) : undefined,
        x: first.targetXPt,
        y: first.targetBaselinePt,
        size,
        color: { r: 0, g: 0, b: 0 },
      });
    } catch (e) {
      reasons.push(`CID fallback 异常：${String(e)}`);
    }
    if (drawn) {
      fallbackPath = fallbackPath === "png" ? "png" : "cid";
      fallbackChars += seg.items.length;
      if (writtenBaseline === null) writtenBaseline = first.targetBaselinePt;
      continue;
    }
    try {
      const png = await textToPngForExport(text, size, cmd.blockId);
      if (png) {
        const img = await pdf.embedPng(png);
        page.drawImage(img, {
          x: first.targetXPt,
          y: cmd.box.y,
          width: Math.max(1, width),
          height: Math.max(1, cmd.box.height),
        });
        drawn = true;
        fallbackPath = "png";
        fallbackChars += seg.items.length;
        if (writtenBaseline === null) writtenBaseline = first.targetBaselinePt;
      }
    } catch (e) {
      reasons.push(`PNG fallback 异常：${String(e)}`);
    }
    if (!drawn) reasons.push(`fallback 段未写入：${JSON.stringify(text.slice(0, 12))}`);
  }

  // 未写入 = 总数 − raw − fallback − **跳过的合成空白**（后者无墨迹，位置由相邻绝对 Tm 保持，
  // 不算缺字；3B-1 已证明这些字符在原 PDF 中没有字形）。
  const unwritten = Math.max(0, cmd.glyphs.length - rawChars - fallbackChars - skippedNoInk);
  if (unwritten > 0 && reasons.length === 0) {
    reasons.push(`${unwritten} 个字符既无原始来源也未写入（fallback 全部失败）`);
  }
  return {
    lineId: cmd.lineId,
    role: cmd.role,
    flowIndex: cmd.flowIndex,
    targetChars: cmd.glyphs.length,
    rawChars,
    fallbackChars,
    unwrittenChars: unwritten,
    skippedNoInkChars: skippedNoInk,
    reverseCidChars: reverseChars,
    fontRef: fontRefSeen,
    targetBaselinePt: cmd.baselinePt,
    writtenBaselinePt: writtenBaseline,
    baselineErrorPt:
      writtenBaseline === null ? null : Math.round((writtenBaseline - cmd.baselinePt) * 1000) / 1000,
    fallbackPath: unwritten > 0 ? "failed" : fallbackPath,
    reason: reasons.length > 0 ? reasons.join(" | ") : null,
  };
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
  const { textGlyphs, lines, images, redactions, redrawLines } = groupExportCommands(commands);
  /** F3B-6.28 · D-3B-2：逐条重绘行的写入回执（验收取证用，见 drawRedrawLineToPdf） */
  const redrawReports: RedrawLineReport[] = [];
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
  type LineKey = string; // "blockId:lineIndex"（或组键碰撞修复后的 "blockId#bi:li"）
  const lineGlyphs = new Map<LineKey, DrawTextGlyphCommand[]>();
  for (const cmd of textGlyphs) {
    // ★ 2026-10-26 组键碰撞修复：bridge 每个 Core TextBox 产出一个 block 且 block.id
    //   沿用 legacy blockId（整页同名）⇒ 旧键 `blockId:lineIndex` 中 lineIndex 每 block
    //   从 0 重数 ⇒ 不同 block 的第 1 行并成一组（实测 75-glyph 组整组按首 glyph 位置
    //   一次性绘制 ⇒ 乱位/文本层只剩残片）。携带 groupKey（block 实例唯一）的命令优先。
    const key =
      (cmd as { groupKey?: string }).groupKey ??
      (cmd.lineIndex !== undefined ? `${cmd.blockId}:${cmd.lineIndex}` : cmd.blockId);
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
  // F3B-6.28 · D-3B-4（决策三）：完整清除 + 成功重绘的行不再依赖 mask ⇒ mask 跳过。
  //   ⚠️ 必须**早于** mask 循环声明（TDZ：const 在声明前引用会抛 ReferenceError）。
  const redrawLineKeys = new Set<string>(
    redrawLines.map((r) => `${r.blockId}:${r.lineIndex}`),
  );
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
    const isType3 = firstGlyph.fontIdentity?.subtype === "Type3";
    const isEmbedded = firstGlyph.fontIdentity?.embedded && !isType3;
    const hasFontRef = !!firstGlyph.fontIdentity?.fontRef;
    const allHaveTransform = glyphs.every((g) => Array.isArray(g.glyphMetrics?.pdfTransform));
    if (hasFontRef && allHaveTransform && (isEmbedded || isType3)) {
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
    // F3B-6.28 · D-3B-4（决策三）：完整清除 + 成功重绘的行**不再依赖 mask**。
    //   这些行的原算子已被 strip 从内容流移除（Pass 1.5 落笔前已逐行核验），
    //   画 mask 只会白白擦掉行内表格线 / 边框线。
    if (maskKey && redrawLineKeys.has(maskKey)) continue;

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

  // ── Pass 1.5: F3B-6.28 · D-3B-2/D-3B-4 整行重绘（flow 成员行 + 位移行）─────
  //   · 只消费 Binding 侧算好的几何（**绝不在 renderer 内重新布局**）；
  //   · 原字符有完整来源 ⇒ raw-CID 直发（原字体 + 原字形 + 目标 Tm）；
  //   · 新增字符无来源 ⇒ 既有 fallback 覆盖度管线（CID/Type0 → PNG），**绝不伪造 CID/transform**；
  //   · D-3B-4（决策一）无 provenance 的原字符：可证明的合成空白 ⇒ 跳过；其它 ⇒ 拒绝导出。
  if (typeof console !== "undefined") {
    console.log(`[F3B-6.28][3B2-REDRAW-COUNT] drawRedrawLineCommands=${redrawLines.length}`);
  }
  try {
    (globalThis as unknown as Record<string, unknown>).__d3b2RedrawCount = redrawLines.length;
  } catch {
    /* ignore */
  }

  // ── D-3B-4 决策三：重绘落笔**之前**逐行核验「原算子已完整剥离」────────────
  //   为什么必须放在这里：此刻内容流里只有「已剥离的原始算子」（strip 在
  //   `exportEditableDocument` 里先于本函数执行，重绘尚未落笔）⇒ 该行原始 baseline
  //   附近的任何非空 showText 只能是**没剥干净**的原文。放到重绘之后就会与其它行的
  //   重绘算子混淆（位移行的目标 baseline 正好是下一行的原 baseline）。
  //   任一行不满足 ⇒ 抛 ExportRedrawGateError ⇒ **整体拒绝导出**（不产出 PDF），
  //   绝不「画 mask 盖住、再重绘」—— mask 是遮盖手段，不是清除完整性证明。
  if (redrawLines.length > 0) {
    const byPage = new Map<number, DrawRedrawLineCommand[]>();
    for (const rcmd of redrawLines) {
      const arr = byPage.get(rcmd.pageIndex) ?? [];
      arr.push(rcmd);
      byPage.set(rcmd.pageIndex, arr);
    }
    for (const [pageIdx, cmds] of byPage) {
      const page = pdf.getPage(Math.min(pageIdx, pdf.getPageCount() - 1));
      const ops = collectShowTextOps(pdf, page);
      const bad = findIncompletelyClearedLines(ops, cmds);
      if (bad.length > 0) {
        throw new ExportRedrawGateError(
          "clear-incomplete",
          `F3B-6.28 · D-3B-4：以下重绘行的原始算子未完整剥离（拒绝导出，不用 mask 掩盖）：${bad
            .map((b) => `${b.lineId.slice(-6)}@${b.atBaselinePt} 残留${b.residualChars}字符`)
            .join("; ")}`,
          { bad },
        );
      }
    }
    if (typeof console !== "undefined") {
      console.log("[F3B-6.28][3B4-CLEAR-VERIFY] 全部重绘行的原始算子已完整剥离");
    }
  }

  // D-3B-4 决策三（续）：清除完整 + 重绘完整的行**不再依赖 mask** ⇒ 其 mask 跳过
  // （`redrawLineKeys` 已在函数前段声明；原算子已从内容流消失，画 mask 只会白白擦掉行内表格线）。

  for (const rcmd of redrawLines) {
    // D-3B-4 决策一：fail 处置 ⇒ 该行拒绝（原字符缺来源且不是可证明的合成空白）
    const failedGlyphs = rcmd.glyphs.filter((g) => g.disposition === "fail");
    if (failedGlyphs.length > 0) {
      throw new ExportRedrawGateError(
        "glyph-missing-source",
        `F3B-6.28 · D-3B-4：行 ${rcmd.lineId.slice(-6)} 有 ${failedGlyphs.length} 个原字符缺来源且非合成空白（${failedGlyphs
          .slice(0, 3)
          .map((g) => JSON.stringify(g.char))
          .join(",")}）⇒ 拒绝导出（不得默认跳过）`,
        { lineId: rcmd.lineId, chars: failedGlyphs.map((g) => g.char) },
      );
    }
    try {
      const report = await drawRedrawLineToPdf(pdf, rcmd);
      redrawReports.push(report);
      if (typeof console !== "undefined") {
        console.log(
          `[F3B-6.28][3B2-REDRAW] ${report.lineId.slice(-6)} role=${report.role} flow=${report.flowIndex} ` +
            `chars=${report.targetChars} raw=${report.rawChars} fallback=${report.fallbackChars} ` +
            `unwritten=${report.unwrittenChars} font=${report.fontRef ?? "none"} ` +
            `cid=${report.rawChars}/${report.targetChars} fallbackPath=${report.fallbackPath} ` +
            `reverseCid=${report.reverseCidChars ?? 0} ` +
            `targetBase=${report.targetBaselinePt} writtenBase=${report.writtenBaselinePt} ` +
            `err=${report.baselineErrorPt} reason=${report.reason ?? "-"}`,
        );
      }
    } catch (e) {
      redrawReports.push({
        lineId: rcmd.lineId,
        role: rcmd.role,
        flowIndex: rcmd.flowIndex,
        targetChars: rcmd.glyphs.length,
        rawChars: 0,
        fallbackChars: 0,
        unwrittenChars: rcmd.glyphs.length,
        fontRef: null,
        targetBaselinePt: rcmd.baselinePt,
        writtenBaselinePt: null,
        baselineErrorPt: null,
        fallbackPath: "failed",
        reason: `重绘异常：${String(e)}`,
      });
      console.warn("[F3B-6.28][3B2-REDRAW] 重绘失败（该行不会出现在导出中）：", rcmd.lineId, e);
    }
  }
  // D-3B-4：任一行未写入 ⇒ 该行会缺字 ⇒ **整体拒绝导出**（不产出缺行 PDF）
  const notDrawn = redrawReports.filter((r) => r.unwrittenChars > 0 || r.fallbackPath === "failed");
  if (notDrawn.length > 0) {
    throw new ExportRedrawGateError(
      "line-not-drawn",
      `F3B-6.28 · D-3B-4：以下重绘行未完整写入（拒绝导出）：${notDrawn
        .map((r) => `${r.lineId.slice(-6)}(unwritten=${r.unwrittenChars},path=${r.fallbackPath})`)
        .join("; ")}`,
      { notDrawn: notDrawn.map((r) => r.lineId) },
    );
  }
  try {
    (globalThis as unknown as Record<string, unknown>).__d3b2Redraw = redrawReports;
  } catch {
    /* ignore */
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
      } catch {
        /* 诊断日志绝不能影响渲染 */
      }
    }

    if (requiresFallback) {
      // ── F3B-6.17-3C-10C.3B-F2-A：优先尝试 **CID/Type0 矢量文本**（可搜索/可复制）──
      //   背景（F1 已锁定）：非 WinAnsi 一律走 PNG ⇒ 文本层丢失（不可搜索/复制）。
      //   F2 Phase 1 PoC 已证明：
      //     · CID 管线本身成立（Type0 + Identity-H + ToUnicode + FontFile2）
      //     · 但 005D 的 hex（Unicode-as-CID）与 pdf-lib subset 的真实 CID **不兼容**
      //     · 手写 BT/Tf/Tm/Tj 算子也**不可提取**
      //     ⇒ 正确承接 = pdf-lib 的字形编码 + 资源注册路径（assembleCidFont + drawText）
      //   字体覆盖不到的字符类（CJK / emoji / Arabic）⇒ 返回 false，**保持 PNG 兜底**。
      //
      // ★ Step 5B：把该行的**原 PDF 字体身份**一并传下去。
      //   此前调用点只有 {pdf,page,text,x,y,size,color} —— 完全没有字体信息，
      //   于是 CJK 被 CID_FALLBACK_FONTS 里的 NotoSansSC 无条件接管（导出产物多出一个
      //   字体、字形与原 FangSong 不一致）。此处只补字体来源，**x/y/size 定位语义不变**。
      //   来源优先级：行级 export provenance（编辑行唯一可得）→ glyph 级测量 provenance（未编辑行）。
      const fontIdentity =
        firstGlyph.originalFontIdentity ??
        firstGlyph.fontIdentity ??
        firstGlyph.glyphMetrics?.fontIdentity;
      let cidDrawn = false;
      // ── P0-EXPORT-FONT-2 ②：original-raw / fallback 分片接线（FONT-1 判定 B）──
      //   fontkit 无法解析原 CID Type0 子集 ⇒ 原字符不能走 assembleCidFont；
      //   但原 glyph 自带第一手 raw-CID 事实（pdfCharCode + pdfTransform）
      //   ⇒ 原字符段直发 emitRawCidGlyphs（绝对矩阵，零 fontkit 依赖，provenance 保留），
      //     新字符段仍走既有 fallback 覆盖度管线（planCidCoverageRuns 语义不变）。
      //
      //   ★ 顺序安全：raw 用绝对 Tm ⇒ 与绘制先后无关；先画 fallback 段（可能失败），
      //     任一失败 ⇒ 整行放弃（交回 PNG 兜底），绝不出现「半行已画」的双写。
      //   ★ 几何不变量：raw 段 cid/transform/x/y 与 glyph 第一手值逐位相等。
      // ★ 输入投影：与 renderer 既有读取口径一致（顶层 ?? glyphMetrics）——
      //   浏览器 glyph 的 raw-CID 事实可能在 glyphMetrics 里，缺这一步 ⇒ 全误判 fallback。
      const __splitInput = glyphs.map((g: any) => ({
        char: g.char,
        pdfCharCode: g.pdfCharCode ?? g.glyphMetrics?.pdfCharCode,
        pdfTransform: g.pdfTransform ?? g.glyphMetrics?.pdfTransform,
      }));
      const __splitRuns = splitOriginalRawRuns(__splitInput);
      const __hasRaw = __splitRuns.some((r) => r.kind === "original-raw");
      if (__hasRaw) {
        const rawFontRef = (
          firstGlyph.originalFontIdentity?.fontRef ??
          firstGlyph.fontIdentity?.fontRef ??
          ""
        ).replace(/^\//, "");
        let fbOk = true;
        let gi = 0;
        // RAW-FALLBACK-01 · 修正 2 A-direct（受控分支，默认关）：同行 raw glyph 的
        // pdfTransform[5] = 第一手 PDF 基线 ⇒ drawText y 直通（PDF 域，零换算），
        // 与 raw 直发共用同一基线定义。参考缺失 ⇒ undefined ⇒ 回退既有 y 语义。
        const directRawPdfY = isRawFallbackDirectBaselineEnabled()
          ? resolveDirectRawPdfY(glyphs)
          : undefined;
        for (const r of __splitRuns) {
          if (r.kind === "original-raw") {
            gi += r.glyphs.length;
            continue;
          }
          // fallback 段：取该段首个 glyph 的定位（既有 tryDrawNonWinAnsiAsCid 语义）
          const seg: typeof glyphs = [];
          while (gi < glyphs.length && classifyGlyphForExport(glyphs[gi]!) === "fallback") {
            seg.push(glyphs[gi]!);
            gi += 1;
          }
          const segFirst = seg[0]!;
          const ok = await tryDrawNonWinAnsiAsCid({
            pdf,
            page,
            pageIndex: pageIdxForLine,
            text: r.text,
            fontIdentity,
            x: segFirst.x,
            y:
              typeof directRawPdfY === "number"
                ? directRawPdfY
                : typeof segFirst.baseline === "number" && Number.isFinite(segFirst.baseline)
                  ? segFirst.baseline
                  : segFirst.y,
            size: segFirst.fontSize,
            color: hexToRgb(segFirst.color) || { r: 0, g: 0, b: 0 },
          });
          if (!ok) {
            fbOk = false;
            break;
          }
        }
        if (fbOk) {
        for (const r of __splitRuns) {
          if (r.kind !== "original-raw") continue;
          if (!rawFontRef) {
              fbOk = false; // 无 fontRef ⇒ raw 无法直发，交回整行兜底（绝不半行）
              break;
            }
            emitRawCidGlyphs(
              page,
              rawFontRef,
              r.glyphs.map((g) => ({
                cid: g.cid,
                transform: [...g.transform] as [number, number, number, number, number, number],
              }))
            );
          }
          if (fbOk) cidDrawn = true;
        }
      }
      if (!cidDrawn) {
        try {
          cidDrawn = await tryDrawNonWinAnsiAsCid({
          pdf,
          page,
          pageIndex: pageIdxForLine,
          text,
          fontIdentity,
          x: firstGlyph.x,
          y:
            typeof firstGlyph.baseline === "number" && Number.isFinite(firstGlyph.baseline)
              ? firstGlyph.baseline
              : firstGlyph.y,
          size: firstGlyph.fontSize,
          color: hexToRgb(firstGlyph.color) || { r: 0, g: 0, b: 0 },
        });
      } catch (e) {
        console.warn("[ExportRenderer] CID text export failed, fallback to PNG:", key, e);
      }
      } // ★ P0-EXPORT-FONT-2 ②：if (!cidDrawn) 分片回退闭合
      if (cidDrawn) continue; // ★ 已用矢量文本绘制（文本层存在）⇒ 不做 PNG 栅格化

      // Unicode fallback（超出 WinAnsi 范围 且 无字体覆盖）：Canvas → PNG → embedPng
      // 用于 CJK、emoji、Arabic 等「当前字体资产无法覆盖」的字符。
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
      // RAW-CID-01：transform 读取契约统一（与 L2473 同口径）——g.pdfTransform
      // （rawProv 推进值）优先，缺失/无效时回退 glyphMetrics；两者均无效 ⇒ 该行
      // 不满足 raw 直发前提 ⇒ fail-closed 走下方 Standard 14 兜底（不发出坏 Tm）。
      const allHaveTransform = glyphs.every(
        (g) => isValidPdfTransform(g.pdfTransform) || isValidPdfTransform(g.glyphMetrics?.pdfTransform),
      );

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
            const rawGlyphs = glyphs.map((g) => {
              // RAW-CID-01：g.pdfTransform（rawProv 推进后的绝对逐字符坐标）优先，
              // 回退 glyphMetrics（旧通道）。allHaveTransform 已保证至少一个有效。
              const t = isValidPdfTransform(g.pdfTransform)
                ? g.pdfTransform
                : g.glyphMetrics!.pdfTransform;
              return {
                cid: (g.pdfCharCode ?? g.glyphMetrics!.pdfCharCode)!,
                transform: [...t] as [number, number, number, number, number, number],
              };
            });
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
        page.drawText(gt, gOpts);
      }
    }
  }

  // 写入图片
  for (const cmd of images) {
    try {
      // B3-C-5-C：优先走 bytes 路径（Core 图片导出，assetRef 解析后的原始字节）；
      // legacy / 签名路径仍走 src（fetch）。两条路径互不干扰。
      let bytes: Uint8Array | null = null;
      let isPng = true;
      if (cmd.bytes) {
        bytes = cmd.bytes;
        isPng = (cmd.mime ?? "image/png").toLowerCase() === "image/png";
      } else if (cmd.src) {
        const resp = await fetch(cmd.src);
        bytes = new Uint8Array(await resp.arrayBuffer());
        isPng = resp.headers.get("content-type")?.includes("png") ?? true;
      }
      if (!bytes) {
        console.warn("[ExportRenderer] Image export skipped (no bytes/src):", cmd.blockId);
        continue;
      }
      const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const page = pdf.getPage(Math.min(cmd.pageIndex ?? 0, pdf.getPageCount() - 1));
      const rot = (cmd as DrawImageCommand).rotation ?? 0;
      if (Math.abs(rot) > 0.01 && cmd.src) {
        // Sprint34.11: 图片绕 bbox 左上角 (cmd.x, cmd.y) 旋转。
        // 与 glyph 一致：CSS 顺时针为正 → PDF 逆时针为负（取 -rotation）。
        // pdf-lib drawImage 不支持任意 transform 矩阵，改用 canvas 预旋转出新的倾斜 PNG，
        // 再平铺 drawImage（图片内容方向已正确）。旋转仅 legacy src 路径支持；
        // bytes 路径旋转留待 C5-D / C5-E（默认 import 图片 rotation=0，不受影响）。
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
    // ★ native rewrite **恒禁用**（用户裁决，固化禁用策略；勿改回表达式形式重新启用）。
    //   禁用原因（M7.8-022A）：
    //   · composeReplacementOperator（replace-text-operator.ts）无条件把 TJ 重建为
    //     单元素数组 `[(全文)] TJ`，原 PDF TJ 数组中的字距调整（kerning）数字全部丢失；
    //   · 且改写的行会被 deriveNativeRoutingFromBlock 判为 native-ready → skipOverlay，
    //     不再生成任何 overlay 命令 → 导出既无 mask 也无重绘，错位的文字直接来自被改写的
    //     内容流（用户报告：修改行下移 / 换行 / 露出原文 / 侵占下一行 / 表格列错位）。
    //   · 该缺陷与替换是否等长无关（等长同样丢字距），故不能仅按长度放行。
    //   依据既有 ee53f17 回滚裁决，**不得**通过修复比较表达式或设置运行时开关重新启用；
    //   重新启用前必须先修 composeReplacementOperator 的 TJ kerning 重建，并补齐回归测试。
    //   （历史：曾用 globalThis.__nativeRewrite / __forceOverlay 作 opt-in/测试门，
    //     后被误写成 `x === process.env.STRIP_DIAG === "1"` 链式比较 ⇒ 恒 false；
    //     恰与禁用意图一致，现已显式固化。两者全仓 0 写入方，已随本次清理移除。）
    const nativeRewriteEnabled = false;
    const forceOverlay = true;
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

  const savedBytes = await pdf.save();
  return savedBytes;
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
// ─────────────────────────────────────────────────────────────────────
//  F3B-6.17-3C-10C.3B-F2-A · 非 WinAnsi 的 CID/Type0 承接
// ─────────────────────────────────────────────────────────────────────
//
//  ★ 设计原则（用户裁决，不得违反）：**不要**把 PNG fallback 简单替换成「手写 CID 算子」。
//    F2 Phase 1 PoC（`document-model/export-cid-readiness.test.ts`）已证明：
//      1. `assembleCidFont`（005E-B）能产出完整 Type0/Identity-H/ToUnicode/FontFile2 ✓
//      2. 005D 的 hex（Unicode-as-CID）≠ pdf-lib subset 的真实 CID ⇒ **不可直接接线**
//      3. 手写 `BT /F1 Tf … <hex> Tj ET` ⇒ pdf.js **提取不到文本**
//      4. 只有 pdf-lib 的字形编码 + 资源注册路径（`drawText`）能闭环
//    ⇒ 本函数走 4；且**只在字体覆盖该文本时**启用，否则返回 false 保持 PNG 兜底。
//
//  字体资产：仓库内目前只有 Liberation Sans（Latin-1 + Cyrillic + Greek）。
//    ⇒ Cyrillic 现在就能修；CJK / emoji / Arabic 覆盖不到 ⇒ 仍走 PNG（G3 资产问题，
//       不在本轮解决，不得为此临时引入 Noto）。

/**
 * CID 候选字体资产（Export-only；`public/` 目录 ⇒ **导出时按需 fetch**，
 * 不进 JS bundle、不影响 App 打开成本）。
 *
 * ★ 选择策略：**按字符覆盖**逐个候选试（**不是**「> U+00FF 就上 CJK 字体」）——
 *   否则会把不同字符类别错误地绑到同一字体（Cyrillic/Arabic/Emoji 各有自己的问题）。
 *
 * G3-A 资产裁决（用户）：OTF/CFF 作为 Export 资产（subset 后 PDF 增量稳定 ~42 KB）；
 *   WOFF2 候选的 subset 异常增量（首例 +1.28 MB）已单独登记 **G3-A-FONT-001**，本轮不处理。
 */
const CID_FALLBACK_FONTS: ReadonlyArray<{ url: string; baseFont: string; subtype: "TrueType" | "OpenType" }> = [
  { url: "/standard_fonts/LiberationSans-Regular.ttf", baseFont: "LiberationSans", subtype: "TrueType" },
  { url: "/standard_fonts/NotoSansSC-Regular.otf", baseFont: "NotoSansSC", subtype: "OpenType" },
];

const cidFontBytesCache = new Map<string, Uint8Array | null>();
let cidFontkit: unknown | null = null;
let cidFontSeq = 0;

/** 浏览器版 fontkit（@pdf-lib/fontkit）；加载失败 ⇒ 不承接（保持 PNG） */
async function loadCidFontkit(): Promise<unknown | null> {
  if (cidFontkit) return cidFontkit;
  try {
    const mod: unknown = await import("@pdf-lib/fontkit");
    const candidate = (mod as { default?: unknown }).default ?? mod;
    cidFontkit = candidate ?? null;
  } catch (e) {
    console.warn("[ExportRenderer][CID] fontkit 加载失败 ⇒ 保持 PNG fallback", e);
    cidFontkit = null;
  }
  return cidFontkit;
}

/** 按需加载（含失败缓存，避免每次导出重试） */
async function loadCidFontBytes(url: string): Promise<Uint8Array | null> {
  if (cidFontBytesCache.has(url)) return cidFontBytesCache.get(url) ?? null;
  try {
    const res = await fetch(url);
    const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    cidFontBytesCache.set(url, bytes);
    return bytes;
  } catch (e) {
    console.warn("[ExportRenderer][CID] 字体资产加载失败 ⇒ 保持 PNG fallback", url, e);
    cidFontBytesCache.set(url, null);
    return null;
  }
}

/**
 * 尝试用 **CID/Type0 嵌入子集字体**绘制非 WinAnsi 文本（矢量 + 可搜索文本层）。
 *
 * Step 5B 形状：
 *   firstGlyph 的原字体身份
 *        └─ resolveFont()（既有 resolver）→ embeddedData
 *              └─ 逐字符 coverage（fontkit.hasGlyphForCodePoint）
 *                    ├─ covered   → 原字体
 *                    └─ uncovered → 既有 CID_FALLBACK_FONTS（NotoSansSC 永远保留）
 *
 * @returns true ⇒ 已绘制（调用方必须跳过 PNG 栅格化）
 */
async function tryDrawNonWinAnsiAsCid(args: {
  pdf: PDFDocument;
  page: PDFPage;
  /** 目标页下标（`resolveFont` 抽取内嵌字体流时用；与 `args.page` 同页） */
  pageIndex: number;
  text: string;
  /** ★ Step 5B：该行原 PDF 字体身份（`glyph.fontIdentity ?? glyph.metrics?.fontIdentity`） */
  fontIdentity?: GlyphFontIdentity;
  x: number;
  y: number;
  size: number;
  color: { r: number; g: number; b: number };
}): Promise<boolean> {
  if (!args.text) return false;
  const fontkit = await loadCidFontkit();
  if (!fontkit) return false;

  // ── Step 5B ①：原 PDF 内嵌字体优先（字节来自既有 resolver，不新建 loader / cache）──
  //   任何一步失败都只是「该来源不参与候选」，绝不因此抛弃整个导出：
  //   非 embedded / embeddedData 缺失 / fontkit 解析失败 / 覆盖不足 ⇒ 落到下面兜底表。
  let originalResolved: ResolvedFont | undefined;
  if (args.fontIdentity) {
    try {
      originalResolved = resolveFont({
        identity: args.fontIdentity,
        pdf: args.pdf,
        pageIndex: args.pageIndex,
      });
    } catch (e) {
      console.warn("[ExportRenderer][CID] 原字体 resolveFont 失败 ⇒ 仅用兜底字体", e);
      originalResolved = undefined;
    }
  }
  const originalSource = createCidFontSource({
    label: `original:${originalResolved?.baseFont ?? "unknown"}`,
    resolved: originalResolved,
    fontkit,
  });


  // ── Step 5B ②：既有兜底资产（顺序与内容不变：Liberation → NotoSansSC）──
  const fallbackSources: CidFontSource[] = [];
  for (const candidate of CID_FALLBACK_FONTS) {
    const bytes = await loadCidFontBytes(candidate.url);
    if (!bytes) continue;
    const source = createCidFontSource({
      label: `fallback:${candidate.baseFont}`,
      resolved: {
        source: "embedded",
        baseFont: candidate.baseFont,
        subtype: candidate.subtype,
        embedded: true,
        embeddedData: bytes,
      },
      fontkit,
    });
    if (source) fallbackSources.push(source);
  }

  const drawArgs = {
    pdf: args.pdf,
    page: args.page,
    text: args.text,
    x: args.x,
    y: args.y,
    size: args.size,
    color: args.color,
    fontkit,
  };

  // ── Step 5B ③：先按「原字体 + 兜底」分段绘制 ──
  if (originalSource) {
    if (
      await drawCidCoverageRuns({ ...drawArgs, sources: [originalSource, ...fallbackSources] })
    ) {
      return true;
    }
    // 原字体方案整体失败（装配/绘制异常）⇒ 退回纯兜底分段（= Step 5B 之前的行为）
    if (await drawCidCoverageRuns({ ...drawArgs, sources: fallbackSources })) return true;
    return false;
  }

  return drawCidCoverageRuns({ ...drawArgs, sources: fallbackSources });
}

/**
 * Step 5B：一个可用于 CID 矢量绘制的字体来源。
 *
 * 只有两类来源，**没有第三类**：
 *   ① `original:…` —— 该行原 PDF 内嵌字体（字节来自既有 `resolveFont` / `extractEmbeddedFont`）
 *   ② `fallback:…` —— `CID_FALLBACK_FONTS` 资产（Export-only，按需 fetch，行为不变）
 *
 * `covers` 是逐字符覆盖判定的唯一实现（内部即 `fontkit.hasGlyphForCodePoint`）。
 */
interface CidFontSource {
  label: string;
  resolved: ResolvedFont;
  /** 逐字符覆盖判定；解析失败时该来源直接不进候选（fail-open） */
  covers: (codePoint: number) => boolean;
}

/**
 * 用既有 fontkit 建立覆盖判定。
 *
 * ⚠️ **canary 校验是必需的，不是防御性冗余**：`fontkit.create(bytes)` 对某些字体
 * **不抛异常但返回不可用对象**（真实案例：Type0/Identity-H 的 CID-keyed FontFile2 子集，
 * 例如 gd-swim-2026.pdf 的 `NREKVL+FangSong_GB2312` —— 之后每次 `hasGlyphForCodePoint`
 * 都抛 `Cannot read properties of undefined (reading 'tables')`）。
 * 若不在此处 canary 校验，该来源会被当成合法候选进入优先级列表，而每次覆盖判定都被
 * `planCidCoverageRuns` 的 try/catch 吞成「不覆盖」⇒ **静默**退化成既有兜底字体，
 * 表现为「修复没生效」且没有任何线索。
 *
 * 解析失败 / 无嵌入字节 / 非 embedded 来源 ⇒ 返回 null（该来源不参与，**绝不抛弃整个导出**）。
 */
function createCidFontSource(args: {
  label: string;
  resolved: ResolvedFont | undefined;
  fontkit: unknown;
}): CidFontSource | null {
  if (!args.resolved) return null;
  const bytes = args.resolved.embeddedData;
  // 只接受真正拿到字节的 embedded 来源（standard14 / system-fallback 无字节可嵌）。
  if (args.resolved.source !== "embedded" || !bytes || bytes.length === 0) return null;
  let covers: (cp: number) => boolean;
  try {
    const font = (
      args.fontkit as {
        create: (b: Uint8Array) => { hasGlyphForCodePoint: (cp: number) => boolean };
      }
    ).create(bytes);
    covers = (cp) => font.hasGlyphForCodePoint(cp);
  } catch (e) {
    console.warn(`[ExportRenderer][CID] ${args.label} 字体创建失败 ⇒ 该来源不参与`, e);
    return null;
  }
  // ★ canary：立刻试跑一次覆盖判定，确认这个来源**真的可用**（而不是每次判定时才抛）
  try {
    covers(0x41); // "A"
    covers(0x5e7f); // "广"
  } catch (e) {
    console.warn(
      `[ExportRenderer][CID] ${args.label} 字体无法做覆盖判定（fontkit 解析不完整）⇒ 该来源不参与，落既有兜底`,
      e
    );
    return null;
  }
  return { label: args.label, resolved: args.resolved, covers };
}

/** coverage run：一段连续使用同一来源的文本 */
interface CidCoverageRun {
  text: string;
  source: CidFontSource;
}

/**
 * ★ coverage-aware 分段（Step 5B 的核心）。
 *
 * 逐字符取「优先级最高且覆盖它」的来源，相邻同来源合并成一个 run：
 *   `广东省体育局ABC😀`
 *     → [FangSong] 广东省体育局ABC   （原字体子集覆盖得到）
 *     → [Noto]     😀                  （原字体子集没有该字形 ⇒ 落兜底）
 *
 * ★ 任何一个字符没有任何来源覆盖 ⇒ 返回 null（整行交回 PNG 兜底，**绝不半途丢字**）。
 * 按码点迭代（`for…of` string），emoji 等增补平面字符不会被拆成孤立 surrogate。
 */
function planCidCoverageRuns(
  text: string,
  sources: readonly CidFontSource[]
): CidCoverageRun[] | null {
  if (sources.length === 0) return null;
  const runs: CidCoverageRun[] = [];
  let current: CidCoverageRun | null = null;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0)!;
    let picked: CidFontSource | undefined;
    for (const source of sources) {
      let covered = false;
      try {
        covered = source.covers(codePoint);
      } catch {
        covered = false; // 单个来源判定异常 ⇒ 当作不覆盖，继续问下一个
      }
      if (covered) {
        picked = source;
        break;
      }
    }
    if (!picked) return null;
    if (current && current.source === picked) current.text += ch;
    else {
      current = { text: ch, source: picked };
      runs.push(current);
    }
  }
  return runs.length > 0 ? runs : null;
}

/**
 * 把 coverage runs 画到页面上。
 *
 * 分两阶段（★ 这是回退安全的关键）：
 *   阶段 1 逐 run 装配字体 —— `assembleCidFont` **不写页面**，所以任一 run 装配失败都可以
 *           整段放弃并退回兜底方案，不会留下「前半段已画、后半段换字体」的重复文字。
 *   阶段 2 按 run 顺序绘制，游标从 `args.x` 起按**已绘制文本的真实 advance** 逐段累加 ——
 *           换字体只影响后续 run 的起点，不会把整段文本重新从 x 画一遍（定位语义不变）。
 */
async function drawCidCoverageRuns(args: {
  pdf: PDFDocument;
  page: PDFPage;
  text: string;
  x: number;
  y: number;
  size: number;
  color: { r: number; g: number; b: number };
  fontkit: unknown;
  sources: readonly CidFontSource[];
}): Promise<boolean> {
  const runs = planCidCoverageRuns(args.text, args.sources);
  if (!runs) return false;

  // 阶段 1：装配（不落页面）
  const staged: Array<{ run: CidCoverageRun; font: PDFFont }> = [];
  for (const run of runs) {
    try {
      const assembled = await assembleCidFont(args.pdf, run.source.resolved, {
        fontkit: args.fontkit,
        resourceName: `FCID${++cidFontSeq}`,
        glyphText: run.text,
        // ★ 真实导出必须单次 save（005E-B 契约）⇒ noMaterialize=true
        noMaterialize: true,
      });
      staged.push({ run, font: assembled.font });
    } catch (e) {
      console.warn(
        `[ExportRenderer][CID] run 装配失败（source=${run.source.label}）⇒ 交回既有兜底`,
        e
      );
      return false;
    }
  }

  // 阶段 2：绘制（游标累加，绝不因换字体回到 x）
  let cursorX = args.x;
  for (const { run, font } of staged) {
    try {
      args.page.drawText(run.text, {
        x: cursorX,
        y: args.y,
        size: args.size,
        font,
        color: rgb(args.color.r, args.color.g, args.color.b),
        maxWidth: 100000,
      });
      cursorX += font.widthOfTextAtSize(run.text, args.size);
    } catch (e) {
      console.warn(
        `[ExportRenderer][CID] run 绘制失败（source=${run.source.label}）`,
        e
      );
      return false;
    }
  }
  return true;
}


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
