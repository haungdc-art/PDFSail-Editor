/**
 * F3B-6.3B — Sprint34 Audit Debug Registry
 *
 * 从 PDFEditor.tsx 抽离的 Sprint34.17–34.27 audit cluster（原 PDFEditor.tsx:2681-3849）。
 * 本轮为**逐字搬移**（verbatim move），未修改任何一行逻辑。
 *
 * 硬约束（F3B-6.3B 授权）：
 *   1. 11 个 useEffect **1:1 保留** —— 未合并、未重排、依赖数组各自独立；
 *   2. 契约不使用 any（docTextItemsRef 沿用原 useRef<any[]> 的元素类型，非新增 any）；
 *   3. `__signatureTransformContexts` 继续从 window 读取（inbound 依赖不在本轮改造为注入）；
 *   4. 未修任何遗留问题（__sigBlockPositionAuditResult 无 cleanup / stale closure /
 *      "jefferson" hardcode）。
 *
 * 审计依据（docs/editor-core-012f3b6.3b-sprint34-debug-boundary.md）：
 *   0 document mutation / 0 ref write / 0 state setter / 0 hidden side effect
 *   / 0 PDFEditor-local function dependency / 13-13 PURE_DEBUG。
 */

import { useEffect } from "react";
import type { MutableRefObject } from "react";
import { buildLayoutDocument, renderPageToCommands } from "../../document-model";
import type { EditableDocument } from "../../document-model";
// 注意：SignatureTransformContext 未从 document-model/index 再导出，须直连定义模块
import type { SignatureTransformContext } from "../../document-model/signature-transform-context";
import type { RenderCommand } from "../../document-model/render-command";
import type { DocumentState } from "../core/editorTypes";

/**
 * F3B-6.3B 显式依赖契约 —— 禁止把整个组件上下文对象传进来。
 *
 * 标记：
 *   PURE_DEBUG          仅用于诊断输出，无生产消费方
 *   OWNERSHIP_SENSITIVE 读取 EditableDocument 真相（只读）
 */
export interface Sprint34AuditDebugDependencies {
  /** OWNERSHIP_SENSITIVE —— EditableDocument 真相（只读） */
  editableDocumentRef: MutableRefObject<EditableDocument | null>;
  /** PURE_DEBUG —— PDF textItems 快照（沿用原 useRef<any[]> 的元素类型） */
  docTextItemsRef: MutableRefObject<any[]>;
  /** PURE_DEBUG */
  suppressedGlyphIdsRef: MutableRefObject<Set<string>>;
  /** PURE_DEBUG —— blockId → rotation（只读） */
  signatureRotationRef: MutableRefObject<Map<string, number>>;
  /** PURE_DEBUG —— Sprint34.15 useMemo 产物（blockId → SignatureTransformContext） */
  signatureTransformContexts: Map<string, SignatureTransformContext>;
  /** PURE_DEBUG */
  editableDocVersion: number;
  /** PURE_DEBUG —— LayoutTree（构建失败时为 null） */
  layoutDocument: ReturnType<typeof buildLayoutDocument> | null;
  /** PURE_DEBUG */
  glyphCommands: RenderCommand[] | undefined;
  /** PURE_DEBUG */
  pdfDoc: DocumentState["pdfDoc"];
  /** PURE_DEBUG */
  page: DocumentState["page"];
}

/**
 * 注册 Sprint34.17–34.27 audit debug API 簇（11 个 useEffect / 13 个 window 写入）。
 *
 * Rules of Hooks：
 *   · 每次 render 无条件调用（调用方不得置于条件分支内）；
 *   · 内部 11 个 useEffect **1:1 保留**抽离前的顺序与各自依赖数组；
 *   · 注册与 cleanup 均在 hook 内部完成。
 */
export function useSprint34AuditDebugRegistry(deps: Sprint34AuditDebugDependencies): void {
  const {
    editableDocumentRef,
    docTextItemsRef,
    suppressedGlyphIdsRef,
    signatureRotationRef,
    signatureTransformContexts,
    editableDocVersion,
    layoutDocument,
    glyphCommands,
    pdfDoc,
    page,
  } = deps;

  // ── Sprint34.17: Signature Glyph Coordinate Alignment Debug ──
  // 对比 Editor signature glyph 与原 PDF textItem 的位置差异，定位 baseline/坐标系偏移。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__sigGlyphCoordDebug = () => {
      const doc = editableDocumentRef.current;
      const items = docTextItemsRef.current || [];
      if (!doc) {
        console.warn("[Sprint34.17] No EditableDocument.");
        return null;
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = block.lines
          .map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
          .join(" ")
          .trim();
        const g0 = block.lines?.[0]?.glyphs?.[0];
        const glyphBBox = g0?.bbox
          ? { x: g0.bbox.x, y: g0.bbox.y, w: g0.bbox.width, h: g0.bbox.height }
          : block.bbox;
        // 原 PDF textItem（按文本包含匹配；扫描件无原生文本时为 null）
        const item =
          (text &&
            items.find((ti: any) => ti.text && text.includes(ti.text.trim()))) ||
          null;
        // DOM: 签名 span 的 getBoundingClientRect，并转换到文档坐标（与 glyphBBox 同系）。
        // 文档坐标 = span相对wrapper像素 × (文档宽 / wrapper.clientWidth)
        let domRect: any = null;
        let docCoords: any = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          const wrapperEl = document.querySelector(
            '[data-layer="wrapper"]',
          ) as HTMLElement | null;
          if (el && wrapperEl) {
            const r = el.getBoundingClientRect();
            const wRect = wrapperEl.getBoundingClientRect();
            const wrapperW = wrapperEl.clientWidth || 1;
            // 页面文档宽：从 doc 里包含该 block 的 page（CSS 文档坐标宽度）
            const ownerPage = doc.pages.find((p: any) =>
              p.blocks.some((b: any) => b.id === blockId),
            );
            const pageDocWidth = ownerPage?.width || wrapperW;
            const scale = wrapperW / pageDocWidth; // 显示缩放
            const docX = (r.x - wRect.x) / scale;
            const docY = (r.y - wRect.y) / scale;
            domRect = {
              x: r.x, y: r.y, width: r.width, height: r.height,
              offsetLeft: (el as any).offsetLeft,
              offsetTop: (el as any).offsetTop,
            };
            docCoords = { x: docX, y: docY, w: r.width / scale, h: r.height / scale };
          }
        } catch {
          domRect = null;
        }
        rows.push({
          blockId,
          text: text.substring(0, 40),
          rotation: ctx.rotation,
          pivot: { x: ctx.pivot.x, y: ctx.pivot.y },
          glyphBBox,
          domRect,
          docCoords,
          pdfItem: item ? { text: item.text, x: item.x, y: item.y, w: item.w, h: item.h } : null,
          deltaX: item ? glyphBBox.x - item.x : null,
          deltaY: item ? glyphBBox.y - item.y : null,
          // 重绘 span 文档坐标 vs OCR 目标坐标的差异
          domDeltaX: docCoords ? glyphBBox.x - docCoords.x : null,
          domDeltaY: docCoords ? glyphBBox.y - docCoords.y : null,
        });
      }
      // Sprint34.17: 可读逐行输出（避免嵌套对象需手动展开），直接显示 deltaX/deltaY
      if (typeof console !== "undefined") {
        console.log(
          "%c[Sprint34.17][SigGlyphCoord]",
          "font-weight:bold;color:#06b6d4;",
          rows,
        );
        for (const r of rows) {
          const g = r.glyphBBox;
          const p = r.pdfItem;
          const d = r.docCoords;
          console.log(
            `%c[Sprint34.17][Row] ${r.text} rot=${r.rotation} ` +
              `glyph=(x=${g?.x?.toFixed?.(1)},y=${g?.y?.toFixed?.(1)}) ` +
              `dom=(x=${d?.x?.toFixed?.(1)},y=${d?.y?.toFixed?.(1)}) ` +
              `domDeltaX=${r.domDeltaX?.toFixed?.(1) ?? "n/a"} domDeltaY=${r.domDeltaY?.toFixed?.(1) ?? "n/a"} ` +
              `pdf=${p ? `(x=${p.x.toFixed(1)},y=${p.y.toFixed(1)})` : "(none)"} ` +
              `deltaX=${r.deltaX?.toFixed?.(1) ?? "n/a"} deltaY=${r.deltaY?.toFixed?.(1) ?? "n/a"}`,
            "color:#22d3ee;",
          );
        }
      }
      return rows;
    };
    return () => {
      delete (window as any).__sigGlyphCoordDebug;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.27: __sigBlockPositionAudit ──
  // 普适性诊断：枚举整页所有 OCR block，输出每个 block 的文本/坐标/suppress/editable/rotation。
  // 纯只读，不改任何检测/渲染/判定逻辑。仅限本次（Sprint34.27）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__sigBlockPositionAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.27][SigBlockPositionAudit] No EditableDocument.");
        return null;
      }
      const suppressed = suppressedGlyphIdsRef.current;
      const editableIds = new Set(signatureTransformContexts.keys());

      const rows: any[] = [];
      for (const page of doc.pages) {
        for (const block of page.blocks) {
          const text = (block.lines ?? [])
            .map((l: any) => (l.glyphs ?? []).map((g: any) => g.char).join(""))
            .join(" ")
            .trim();
          const ob = block.originalBounds as any;
          const bb = block.bbox as any;
          rows.push({
            blockId: block.id,
            page: page.index,
            text: text.substring(0, 60),
            bbox_y: bb?.y != null ? +bb.y.toFixed(1) : null,
            bbox: bb ? { x: +bb.x.toFixed(1), y: +bb.y.toFixed(1), w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) } : null,
            originalBounds_y: ob?.y != null ? +ob.y.toFixed(1) : null,
            originalBounds: ob ? { x: +ob.x.toFixed(1), y: +ob.y.toFixed(1), w: +ob.width.toFixed(1), h: +ob.height.toFixed(1) } : null,
            regionType: block.regionType ?? "-",
            suppressed: suppressed.has(block.id) ? "YES" : "no",
            editable: editableIds.has(block.id) ? "YES" : "no",
            rotation: signatureRotationRef.current.get(block.id) ?? 0,
          });
        }
      }
      rows.sort((a, b) => (a.originalBounds_y ?? a.bbox_y ?? 0) - (b.originalBounds_y ?? b.bbox_y ?? 0));
      if (typeof console !== "undefined") {
        console.group(
          "%c[Sprint34.27][SigBlockPositionAudit]",
          "font-weight:bold;color:#f59e0b;",
        );
        console.log(`totalBlocks=${rows.length} suppressed=${suppressed.size} editableCtx=${editableIds.size}`);
        console.table(rows.map((r) => ({
          y: r.originalBounds_y ?? r.bbox_y,
          regionType: r.regionType,
          suppressed: r.suppressed,
          editable: r.editable,
          rot: r.rotation,
          text: r.text,
        })));
        console.groupEnd();
        console.log("Full rows: window.__sigBlockPositionAuditResult");
      }
      (window as any).__sigBlockPositionAuditResult = rows;
      return rows;
    };
    return () => {
      delete (window as any).__sigBlockPositionAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.17: Rotation Source Audit ──
  // 对比 EditableBlock.rotation（来自 detectRegionRotation 线性回归）与 PDF 原生 textItem transform 角度。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__rotationAudit = async () => {
      if (!pdfDoc) {
        console.warn("[Sprint34.17][RotationAudit] No pdfDoc");
        return null;
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const blockText = (ctx.blocks[0]?.text ?? "").trim();
        if (!blockText) continue;
        // 找到 block 所在页（blockId 在 doc 中）
        const ownerPageIndex = editableDocumentRef.current?.pages.findIndex((p: any) =>
          p.blocks.some((b: any) => b.id === blockId),
        );
        let item: any = null;
        try {
          const pg = await pdfDoc.getPage((ownerPageIndex ?? 0) + 1);
          const tc = await pg.getTextContent();
          // 按文本包含匹配原 PDF textItem
          item = tc.items.find(
            (ti: any) => ti.str && blockText.includes(ti.str.trim()),
          );
        } catch (e) {
          item = null;
        }
        const transform = item?.transform as number[] | undefined;
        const pdfAngle1 = transform
          ? (Math.atan2(transform[1], transform[0]) * 180) / Math.PI
          : null;
        const pdfAngle2 = transform
          ? (Math.atan2(transform[2], transform[3]) * 180) / Math.PI
          : null;
        rows.push({
          blockId,
          text: blockText.substring(0, 40),
          editableRotation: ctx.rotation,
          textItemTransform: transform ? [...transform] : null,
          pdfAngle1_atan2_t1_t0: pdfAngle1,
          pdfAngle2_atan2_t2_t3: pdfAngle2,
        });
      }
      console.log(
        "%c[Sprint34.17][RotationAudit]",
        "font-weight:bold;color:#06b6d4;",
        rows,
      );
      for (const r of rows) {
        console.log(
          `%c[Sprint34.17][RotRow] ${r.text} editableRotation=${r.editableRotation} ` +
            `transform=${r.textItemTransform ? JSON.stringify(r.textItemTransform.map((n: number) => +n.toFixed(3))) : "null"} ` +
            `angle1(atan2 t1,t0)=${r.pdfAngle1_atan2_t1_t0?.toFixed?.(2) ?? "n/a"} ` +
            `angle2(atan2 t2,t3)=${r.pdfAngle2_atan2_t2_t3?.toFixed?.(2) ?? "n/a"}`,
          "color:#f59e0b;",
        );
      }
      return rows;
    };
    return () => {
      delete (window as any).__rotationAudit;
    };
  }, [pdfDoc, page, signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.18: Signature Overlay Alignment Audit ──
  // 对比三层几何：Source OCR → EditableBlock → DOM render，定位坐标/rotation 偏移。
  // ── P0-008: Find First Identity ──
  // 定位第一处把 OCR transform 变成 Identity Matrix 的代码。
  // 打印 Editable 阶段（glyph.transform）与 Command 阶段（DrawGlyphCommand.transform），
  // 对比判断 transform 在哪丢失。只读诊断，不修改任何旋转逻辑。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__findFirstIdentity = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[P0-008] No EditableDocument.");
        return null;
      }
      const rows: any[] = [];
      for (const page of doc.pages) {
        for (const block of page.blocks) {
          const text = (block.lines ?? [])
            .map((l: any) => (l.glyphs ?? []).map((g: any) => g.char).join(""))
            .join(" ")
            .trim();
          if (!text) continue;
          const glyph = block.lines?.[0]?.glyphs?.[0];
          if (!glyph) continue;
          const isIdentity = (t?: any) =>
            !t ||
            (t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0);
          rows.push({
            text: text.substring(0, 40),
            blockId: block.id,
            regionType: block.regionType ?? "-",
            layoutMode: block.layoutMode ?? "-",
            editable_transform: glyph.transform ?? "IDENTITY",
            editable_isIdentity: isIdentity(glyph.transform),
            editable_originalChar: glyph.originalChar ?? glyph.char,
          });
        }
      }
      // Command 阶段：通过 renderPageToCommands 读取 DrawGlyphCommand.transform
      const cmdRows: any[] = [];
      try {
        const suppressed = suppressedGlyphIdsRef.current;
        for (const page of doc.pages) {
          const cmds = renderPageToCommands(doc, page, suppressed, signatureRotationRef.current);
          for (const c of cmds) {
            if (c.type !== "drawGlyph") continue;
            const g = c as any;
            cmdRows.push({
              text: g.char,
              blockId: g.blockId,
              transform: g.transform ?? "IDENTITY",
            });
          }
        }
      } catch (e) {
        console.warn("[P0-008] Command audit failed", e);
      }
      console.log(
        "%c[P0-008][Editable Stage] (EditableBlock.glyph.transform)",
        "font-weight:bold;color:#22d3ee;",
        rows.filter((r) => r.text.toLowerCase().includes("jefferson") || r.text.toLowerCase().includes("jeferson")),
      );
      console.log(
        "%c[P0-008][Command Stage] (DrawGlyphCommand.transform) 前 10 条",
        "font-weight:bold;color:#f59e0b;",
        cmdRows.slice(0, 10),
      );
      return { editable: rows, command: cmdRows };
    };
    return () => {
      delete (window as any).__findFirstIdentity;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__sigGeometryAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.18] No EditableDocument.");
        return null;
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim();
        // 1. Source OCR geometry
        const sourceBBox = block.originalBounds ?? block.bbox;
        const sourceCenter = {
          x: sourceBBox.x + sourceBBox.width / 2,
          y: sourceBBox.y + sourceBBox.height / 2,
        };
        // 2. EditableBlock geometry
        const editableBBox = block.bbox;
        // 3. DOM render geometry (转文档坐标)
        let domBBox: any = null;
        let containerBBox: any = null;
        let computedTransform: string | null = null;
        let transformOrigin: string | null = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          const wrapperEl = document.querySelector(
            '[data-layer="wrapper"]',
          ) as HTMLElement | null;
          if (el && wrapperEl) {
            const r = el.getBoundingClientRect();
            const wRect = wrapperEl.getBoundingClientRect();
            const wrapperW = wrapperEl.clientWidth || 1;
            const pageDocWidth =
              doc.pages.find((p: any) =>
                p.blocks.some((b: any) => b.id === blockId),
              )?.width || wrapperW;
            const scale = wrapperW / pageDocWidth;
            domBBox = {
              x: (r.x - wRect.x) / scale,
              y: (r.y - wRect.y) / scale,
              width: r.width / scale,
              height: r.height / scale,
            };
            containerBBox = {
              x: wRect.x, y: wRect.y,
              width: wRect.width, height: wRect.height,
            };
            computedTransform = getComputedStyle(el).transform;
            transformOrigin = getComputedStyle(el).transformOrigin;
          }
        } catch {
          // ignore
        }
        // 4. 自动偏移
        const deltaX = domBBox ? domBBox.x - sourceBBox.x : null;
        const deltaY = domBBox ? domBBox.y - sourceBBox.y : null;
        rows.push({
          text: text.substring(0, 40),
          blockId,
          sourceBBox: { x: sourceBBox.x, y: sourceBBox.y, width: sourceBBox.width, height: sourceBBox.height },
          sourceCenter,
          sourceRotation: ctx.rotation,
          editableBBox: { x: editableBBox.x, y: editableBBox.y, width: editableBBox.width, height: editableBBox.height },
          editableRotation: ctx.rotation,
          domBBox,
          containerBBox,
          computedTransform,
          transformOrigin,
          deltaX,
          deltaY,
        });
      }
      console.log(
        "%c[Sprint34.18][SigSourceGeometry]",
        "font-weight:bold;color:#06b6d4;",
        rows.map((r) => ({ text: r.text, id: r.blockId, sourceBBox: r.sourceBBox, sourceCenter: r.sourceCenter, sourceRotation: r.sourceRotation })),
      );
      console.log(
        "%c[Sprint34.18][SigEditableGeometry]",
        "font-weight:bold;color:#22d3ee;",
        rows.map((r) => ({ text: r.text, editableBBox: r.editableBBox, editableRotation: r.editableRotation, transformOrigin: r.transformOrigin })),
      );
      console.log(
        "%c[Sprint34.18][SigDOMGeometry]",
        "font-weight:bold;color:#f59e0b;",
        rows.map((r) => ({ text: r.text, domBBox: r.domBBox, containerBBox: r.containerBBox, computedTransform: r.computedTransform })),
      );
      console.log(
        "%c[Sprint34.18][SigAlignmentDiff]",
        "font-weight:bold;color:#ef4444;",
        rows.map((r) => ({ text: r.text, deltaX: r.deltaX, deltaY: r.deltaY, rotationDiff: r.sourceRotation })),
      );
      return rows;
    };
    return () => {
      delete (window as any).__sigGeometryAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.20: Glyph Geometry Audit ──
  // 对比 EditableBlock bbox 与实际 glyph 绘制坐标，重点验证 baseline / font ascent-descent 偏移。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__glyphGeometryAudit = () => {
      const doc = editableDocumentRef.current;
      // Sprint34.20 diagnostic: context / doc 状态
      if (typeof console !== "undefined") {
        console.log(
          `%c[GlyphGeometryAudit] ctxSize=${signatureTransformContexts.size} doc=${!!doc} pages=${doc?.pages?.length} layoutDoc=${!!layoutDocument}`,
          "color:#ef4444;",
        );
        if (typeof window !== "undefined") {
          const dbg = (window as any).__signatureTransformContexts;
          console.log("[GlyphGeometryAudit] __signatureTransformContexts size=", dbg?.size ?? "n/a");
        }
      }
      if (!doc) {
        console.warn("[Sprint34.20] No EditableDocument.");
        return null;
      }
      // Sprint34.20 DOM 全局诊断（必定输出，确认 wrapper / 签名 span / glyphCommands 状态）
      if (typeof console !== "undefined") {
        try {
          const wrapperN = document.querySelectorAll('[data-layer="wrapper"]').length;
          const sigSpanN = document.querySelectorAll("[data-sig-block]").length;
          const dataLayers = Array.from(document.querySelectorAll("[data-layer]"))
            .map((el) => (el as HTMLElement).getAttribute("data-layer"))
            .slice(0, 20)
            .join(",");
          console.log(
            `%c[GlyphGeometryAudit][DOM] wrapper=${wrapperN} data-sig-block=${sigSpanN} data-layers=[${dataLayers}]`,
            "background:#7c3aed;color:#fff;font-weight:bold;",
          );
        } catch (e) {
          console.warn("[GlyphGeometryAudit][DOM] diag failed", e);
        }
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim();
        // Sprint34.20 diagnostic: suppressed 状态 + 该 block 是否有 glyph 渲染命令
        if (typeof console !== "undefined") {
          const isSuppressed = suppressedGlyphIdsRef.current?.has(blockId);
          const gCount = (glyphCommands ?? []).filter(
            (c: any) => c.type === "drawGlyph" && c.blockId === blockId,
          ).length;
          console.log(
            `%c[GlyphGeometryAudit][RenderDiag] ${text} suppressed=${isSuppressed} glyphCmds=${gCount}`,
            isSuppressed ? "color:#ef4444;" : "color:#22d3ee;",
          );
        }
        const sourceBBox = block.originalBounds ?? block.bbox;
        const editableBBox = block.bbox;
        const style = (block.lines?.[0] as any)?.style || {};
        const fontSize = style.fontSize || 14;
        const fontFamily = style.fontFamily || "sans-serif";
        const lineHeight = fontSize * 1.3;
        // DOMRect（第一个字符 span，转文档坐标）
        let domRect: any = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          const wrapperEl = document.querySelector(
            '[data-layer="wrapper"]',
          ) as HTMLElement | null;
          // Sprint34.20 diagnostic: 若找不到 span/wrapper，输出原因
          if (!el) {
            const spans = Array.from(document.querySelectorAll("[data-sig-block]"));
            const n = spans.length;
            const ids = spans
              .map((s) => (s as HTMLElement).dataset.sigBlock)
              .slice(0, 10)
              .join(",");
            console.log(
              `%c[GlyphGeometryAudit][DomDiag] ${text} span NOT FOUND (total [data-sig-block]=${n}; ids=[${ids}])`,
              "color:#ef4444;",
            );
          }
          if (!wrapperEl) {
            console.log(
              `%c[GlyphGeometryAudit][DomDiag] wrapper NOT FOUND (total [data-layer] = ${document.querySelectorAll("[data-layer]").length})`,
              "color:#ef4444;",
            );
          }
          if (el && wrapperEl) {
            const r = el.getBoundingClientRect();
            const wRect = wrapperEl.getBoundingClientRect();
            const pageDocWidth =
              doc.pages.find((p: any) =>
                p.blocks.some((b: any) => b.id === blockId),
              )?.width || wrapperEl.clientWidth || 1;
            const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
            domRect = {
              x: (r.x - wRect.x) / scale,
              y: (r.y - wRect.y) / scale,
              width: r.width / scale,
              height: r.height / scale,
            };
          }
        } catch {
          domRect = null;
        }
        // font metrics（ascent / descent）
        let ascent: number | null = null;
        let descent: number | null = null;
        try {
          const cv = document.createElement("canvas");
          const cctx = cv.getContext("2d");
          if (cctx) {
            cctx.font = `${fontSize}px ${fontFamily}`;
            const m = cctx.measureText("Mg");
            if (typeof m.actualBoundingBoxAscent === "number") ascent = m.actualBoundingBoxAscent;
            if (typeof m.actualBoundingBoxDescent === "number") descent = m.actualBoundingBoxDescent;
          }
        } catch {
          // ignore
        }
        const deltaX = domRect ? domRect.x - sourceBBox.x : null;
        const deltaY = domRect ? domRect.y - sourceBBox.y : null;
        // baselineOffset: 文字底部 vs bbox 底部
        const baselineOffset =
          domRect && sourceBBox
            ? domRect.y + domRect.height - (sourceBBox.y + sourceBBox.height)
            : null;
        rows.push({
          text: text.substring(0, 40),
          blockId,
          sourceBBox: { x: sourceBBox.x, y: sourceBBox.y, width: sourceBBox.width, height: sourceBBox.height },
          editableBBox: { x: editableBBox.x, y: editableBBox.y, width: editableBBox.width, height: editableBBox.height },
          domRect,
          fontSize,
          lineHeight,
          baselineOffset,
          ascent,
          descent,
          deltaX,
          deltaY,
        });
      }
      console.log(
        "%c[GlyphGeometryAudit]",
        "font-weight:bold;color:#06b6d4;",
        rows,
      );
      for (const r of rows) {
        console.log(
          `%c[GlyphGeometryAudit] ${r.text} ` +
            `font=${r.fontSize} lineH=${r.lineHeight} ` +
            `ascent=${r.ascent?.toFixed?.(1) ?? "n/a"} descent=${r.descent?.toFixed?.(1) ?? "n/a"} ` +
            `baselineOffset=${r.baselineOffset?.toFixed?.(1) ?? "n/a"} ` +
            `deltaX=${r.deltaX?.toFixed?.(1) ?? "n/a"} deltaY=${r.deltaY?.toFixed?.(1) ?? "n/a"} ` +
            `srcTop=${r.sourceBBox?.y?.toFixed?.(1)} domTop=${r.domRect?.y?.toFixed?.(1)}`,
          "color:#f59e0b;",
        );
      }
      return rows;
    };
    return () => {
      delete (window as any).__glyphGeometryAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.20: Geometry Truth Audit ──
  // 三套几何统一对比：OCR → Editable → DOM，rAF 后读真实渲染位置。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__geometryTruthAudit = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.20] No EditableDocument.");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          const rows: any[] = [];
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ocr = block.originalBounds ?? block.bbox;
            const editable = block.bbox;
            const rotation = ctx.rotation;
            // DOM（转文档坐标，与 OCR/Editable 同系）
            let dom: any = null;
            try {
              const el = document.querySelector(
                `[data-sig-block="${blockId}"]`,
              ) as HTMLElement | null;
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              if (el && wrapperEl) {
                const r = el.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                dom = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
              }
            } catch {
              dom = null;
            }
            const ocrToEditable = editable
              ? { dx: editable.x - ocr.x, dy: editable.y - ocr.y }
              : null;
            const editableToDom =
              editable && dom
                ? { dx: dom.x - editable.x, dy: dom.y - editable.y }
                : null;
            rows.push({
              text,
              ocr: { x: ocr.x, y: ocr.y, w: ocr.width, h: ocr.height },
              editable: {
                x: editable.x,
                y: editable.y,
                w: editable.width,
                h: editable.height,
                rotation,
              },
              dom,
              ocrToEditable,
              editableToDom,
            });
          }
          // Sprint34.21: 统一格式输出，用 console.table 展开避免 Chrome 折叠
          console.log(
            "%c[Sprint34.21][GeometryTruthDetail]",
            "font-weight:bold;color:#06b6d4;",
          );
          const tableRows = rows.map((r) => ({
            text: r.text,
            "OCR.x": +r.ocr.x.toFixed(1),
            "OCR.y": +r.ocr.y.toFixed(1),
            "OCR.w": +r.ocr.w.toFixed(1),
            "OCR.h": +r.ocr.h.toFixed(1),
            "ED.x": r.editable ? +r.editable.x.toFixed(1) : null,
            "ED.y": r.editable ? +r.editable.y.toFixed(1) : null,
            "ED.w": r.editable ? +r.editable.w.toFixed(1) : null,
            "ED.h": r.editable ? +r.editable.h.toFixed(1) : null,
            "ED.rot": r.editable ? +r.editable.rotation.toFixed(3) : null,
            "DOM.x": r.dom ? +r.dom.x.toFixed(1) : null,
            "DOM.y": r.dom ? +r.dom.y.toFixed(1) : null,
            "DOM.w": r.dom ? +r.dom.width.toFixed(1) : null,
            "DOM.h": r.dom ? +r.dom.height.toFixed(1) : null,
            "OCR->ED.dx": r.ocrToEditable ? +r.ocrToEditable.dx.toFixed(2) : null,
            "OCR->ED.dy": r.ocrToEditable ? +r.ocrToEditable.dy.toFixed(2) : null,
            "ED->DOM.dx": r.editableToDom ? +r.editableToDom.dx.toFixed(2) : null,
            "ED->DOM.dy": r.editableToDom ? +r.editableToDom.dy.toFixed(2) : null,
          }));
          console.table(tableRows);
          // 同时输出文本行，便于复制（console.table 表格不便粘贴）
          for (const r of rows) {
            const d = (v: any) => (v === null || v === undefined ? "n/a" : (+v).toFixed(1));
            const d2 = (v: any) => (v === null || v === undefined ? "n/a" : (+v).toFixed(2));
            console.log(
              `[GT] ${r.text} | OCR(x=${d(r.ocr.x)},y=${d(r.ocr.y)},w=${d(r.ocr.w)},h=${d(r.ocr.h)}) ` +
                `| ED(x=${r.editable ? d(r.editable.x) : "n/a"},y=${r.editable ? d(r.editable.y) : "n/a"},w=${r.editable ? d(r.editable.w) : "n/a"},h=${r.editable ? d(r.editable.h) : "n/a"},rot=${r.editable ? (+r.editable.rotation).toFixed(3) : "n/a"}) ` +
                `| DOM(x=${r.dom ? d(r.dom.x) : "n/a"},y=${r.dom ? d(r.dom.y) : "n/a"},w=${r.dom ? d(r.dom.width) : "n/a"},h=${r.dom ? d(r.dom.height) : "n/a"}) ` +
                `| ocr->ed(dx=${d2(r.ocrToEditable?.dx)},dy=${d2(r.ocrToEditable?.dy)}) ` +
                `| ed->dom(dx=${d2(r.editableToDom?.dx)},dy=${d2(r.editableToDom?.dy)})`,
            );
          }
          resolve(rows);
        });
      });
    };
    return () => {
      delete (window as any).__geometryTruthAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.22: Glyph Container Geometry Audit ──
  // 测量整个文本容器（签名 wrapper），对比 EditableBBox，计算 scale 与 diff。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__glyphContainerTruth = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.22] No EditableDocument.");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          const rows: any[] = [];
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ed = block.bbox;
            let container: any = null;
            try {
              const el = document.querySelector(
                `[data-sig-block="${blockId}"]`,
              ) as HTMLElement | null;
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              if (el && wrapperEl) {
                // Sprint34.24: 容器 = 该 block 的独立 GlyphContainer（data-sig-block-container）
                const containerEl = document.querySelector(
                  `[data-sig-block-container="${blockId}"]`,
                ) as HTMLElement | null;
                const cEl = containerEl || el;
                const r = cEl.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                container = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
              }
            } catch {
              container = null;
            }
            const widthRatio = ed && container ? container.width / ed.width : null;
            const heightRatio = ed && container ? container.height / ed.height : null;
            rows.push({
              text,
              editable: { x: ed.x, y: ed.y, w: ed.width, h: ed.height },
              domContainer: container,
              scale: { widthRatio, heightRatio },
              diff: container
                ? {
                    dx: container.x - ed.x,
                    dy: container.y - ed.y,
                    dw: container.width - ed.width,
                    dh: container.height - ed.height,
                  }
                : null,
            });
          }
          console.log(
            "%c[Sprint34.22][GlyphContainerTruth]",
            "font-weight:bold;color:#06b6d4;",
            "",
          );
          const tableRows = rows.map((r) => ({
            text: r.text,
            "ED.x": r.editable ? +r.editable.x.toFixed(1) : null,
            "ED.y": r.editable ? +r.editable.y.toFixed(1) : null,
            "ED.w": r.editable ? +r.editable.w.toFixed(1) : null,
            "ED.h": r.editable ? +r.editable.h.toFixed(1) : null,
            "DOM.x": r.domContainer ? +r.domContainer.x.toFixed(1) : null,
            "DOM.y": r.domContainer ? +r.domContainer.y.toFixed(1) : null,
            "DOM.w": r.domContainer ? +r.domContainer.width.toFixed(1) : null,
            "DOM.h": r.domContainer ? +r.domContainer.height.toFixed(1) : null,
            "wRatio": r.scale?.widthRatio ? +r.scale.widthRatio.toFixed(3) : null,
            "hRatio": r.scale?.heightRatio ? +r.scale.heightRatio.toFixed(3) : null,
            "dx": r.diff ? +r.diff.dx.toFixed(2) : null,
            "dy": r.diff ? +r.diff.dy.toFixed(2) : null,
            "dw": r.diff ? +r.diff.dw.toFixed(2) : null,
            "dh": r.diff ? +r.diff.dh.toFixed(2) : null,
          }));
          console.table(tableRows);
          for (const r of rows) {
            const f1 = (v: any) => (v == null ? "n/a" : (+v).toFixed(1));
            const f2 = (v: any) => (v == null ? "n/a" : (+v).toFixed(3));
            console.log(
              `[GCT] ${r.text} | ED(x=${f1(r.editable.x)},y=${f1(r.editable.y)},w=${f1(r.editable.w)},h=${f1(r.editable.h)}) ` +
                `| DOM(x=${r.domContainer ? f1(r.domContainer.x) : "n/a"},y=${r.domContainer ? f1(r.domContainer.y) : "n/a"},w=${r.domContainer ? f1(r.domContainer.width) : "n/a"},h=${r.domContainer ? f1(r.domContainer.height) : "n/a"}) ` +
                `| wRatio=${f2(r.scale?.widthRatio)} hRatio=${f2(r.scale?.heightRatio)} ` +
                `| diff(dx=${f2(r.diff?.dx)},dy=${f2(r.diff?.dy)},dw=${f2(r.diff?.dw)},dh=${f2(r.diff?.dh)})`,
            );
          }
          resolve(rows);
        });
      });
    };
    return () => {
      delete (window as any).__glyphContainerTruth;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.23: GlyphRenderer Block Isolation Audit ──
  // 验证每个 EditableBlock 是否有独立 glyph container，还是多个 block 共享同一 region container。
  useEffect(() => {
    if (typeof window === "undefined") return;

    // __glyphTreeAudit: 输出 DOM 树结构（Region → Container → Blocks → glyphs）
    (window as any).__glyphTreeAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.23] No doc");
        return;
      }
      console.log(
        "%c[Sprint34.23][GlyphTree]",
        "font-weight:bold;color:#06b6d4;",
      );
      // 收集所有签名 block 的容器（offsetParent wrapper）
      const seen = new Set<string>();
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim();
        const el = document.querySelector(
          `[data-sig-block="${blockId}"]`,
        ) as HTMLElement | null;
        const containerEl = el?.offsetParent as HTMLElement | null;
        const containerKey = containerEl
          ? `${containerEl.style.left}|${containerEl.style.top}|${containerEl.style.width}|${containerEl.style.height}`
          : "none";
        seen.add(containerKey);
        const glyphCount = el
          ? document.querySelectorAll(`[data-sig-block="${blockId}"]`).length
          : 0;
        console.log(
          `Block: text="${text}" blockId=${blockId} ` +
            `containerId=${containerEl ? (containerEl as any).dataset?.regionId ?? "?" : "none"} ` +
            `containerKey=[${containerKey}] ` +
            `glyphCount=${glyphCount} ` +
            (seen.size > 0 ? `SHARED=${[...seen].length > 1 ? "independent" : "check"}` : ""),
        );
      }
      console.log(
        `%c[Sprint34.23][GlyphTree] Distinct container keys = ${seen.size} (blocks = ${signatureTransformContexts.size})`,
        "color:#ef4444;font-weight:bold;",
      );
      console.log(
        seen.size < signatureTransformContexts.size && signatureTransformContexts.size > 0
          ? "%c>>> 多个 block 共享同一容器 → renderer 粒度错误（region 级渲染）"
          : "%c>>> 每个 block 独立容器（block 级渲染）",
        "color:#f59e0b;font-weight:bold;",
      );
    };

    // __glyphMappingAudit: Block → DOM 映射表，验证是否共享 DOM bbox
    (window as any).__glyphMappingAudit = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.23] No doc");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          const rows: any[] = [];
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ed = block.bbox;
            let dom: any = null;
            let containerKey: string | null = null;
            try {
              const el = document.querySelector(
                `[data-sig-block="${blockId}"]`,
              ) as HTMLElement | null;
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              if (el && wrapperEl) {
                // Sprint34.24: 容器 = 该 block 的独立 GlyphContainer
                const containerEl = document.querySelector(
                  `[data-sig-block-container="${blockId}"]`,
                ) as HTMLElement | null;
                const cEl = containerEl || el;
                const r = cEl.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                dom = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
                containerKey = `${dom.x.toFixed(1)}|${dom.y.toFixed(1)}|${dom.width.toFixed(1)}|${dom.height.toFixed(1)}`;
              }
            } catch {
              dom = null;
            }
            rows.push({
              text,
              editable: { w: ed.width, h: ed.height, cx: ed.x + ed.width / 2, cy: ed.y + ed.height / 2 },
              dom: dom
                ? { w: dom.width, h: dom.height, cx: dom.x + dom.width / 2, cy: dom.y + dom.height / 2 }
                : null,
              containerKey,
              ratio: dom
                ? {
                    w: dom.width / ed.width,
                    h: dom.height / ed.height,
                  }
                : null,
              centerOffset: dom
                ? {
                    dx: dom.x + dom.width / 2 - (ed.x + ed.width / 2),
                    dy: dom.y + dom.height / 2 - (ed.y + ed.height / 2),
                  }
                : null,
            });
          }
          console.log(
            "%c[Sprint34.23][GlyphMapping]",
            "font-weight:bold;color:#06b6d4;",
            "",
          );
          const table = rows.map((r) => ({
            text: r.text,
            "ED.w": r.editable ? +r.editable.w.toFixed(1) : null,
            "ED.h": r.editable ? +r.editable.h.toFixed(1) : null,
            "ED.cx": r.editable ? +r.editable.cx.toFixed(1) : null,
            "ED.cy": r.editable ? +r.editable.cy.toFixed(1) : null,
            "DOM.w": r.dom ? +r.dom.w.toFixed(1) : null,
            "DOM.h": r.dom ? +r.dom.h.toFixed(1) : null,
            "DOM.cx": r.dom ? +r.dom.cx.toFixed(1) : null,
            "DOM.cy": r.dom ? +r.dom.cy.toFixed(1) : null,
            "ratio.w": r.ratio ? +r.ratio.w.toFixed(3) : null,
            "ratio.h": r.ratio ? +r.ratio.h.toFixed(3) : null,
            "center.dx": r.centerOffset ? +r.centerOffset.dx.toFixed(2) : null,
            "center.dy": r.centerOffset ? +r.centerOffset.dy.toFixed(2) : null,
            containerKey: r.containerKey,
          }));
          console.table(table);
          // 检查是否共享容器（只统计有 DOM 的 block；DOM=null 的 suppressed block 无容器不算共享）
          const keyed = rows.filter((r) => !!r.containerKey);
          const keys = keyed.map((r) => r.containerKey);
          const unique = new Set(keys).size;
          const noDomCount = rows.length - keyed.length;
          console.log(
            `%c[Sprint34.23][GlyphMapping] DOM bboxes distinct=${unique} (blocks with DOM=${keyed.length}, no-DOM/suppressed=${noDomCount})`,
            "color:#ef4444;font-weight:bold;",
          );
          console.log(
            unique < keyed.length
              ? "%c>>> 多个渲染 block 共享同一 DOM bbox → renderer 粒度错误（region 级容器）"
              : `%c>>> 每个渲染 block 独立 DOM bbox（distinct=${unique} == rendered=${keyed.length}）`,
            "color:#f59e0b;font-weight:bold;",
          );
          resolve(rows);
        });
      });
    };

    return () => {
      delete (window as any).__glyphTreeAudit;
      delete (window as any).__glyphMappingAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.24: GlyphContainer Size Source Audit ──
  // 定位 EditableBlock → GlyphContainer → Glyph DOM 在哪一步丢失 width。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__glyphSizeSourceAudit = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.24] No doc");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          console.log(
            "%c[Sprint34.24][GlyphSizeSource]",
            "font-weight:bold;color:#06b6d4;",
          );
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ed = block.bbox;
            // GlyphContainer DOM bbox
            let dom: any = null;
            let computed: any = null;
            try {
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              const cEl = document.querySelector(
                `[data-sig-block-container="${blockId}"]`,
              ) as HTMLElement | null;
              if (cEl && wrapperEl) {
                const r = cEl.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                dom = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
                const cs = getComputedStyle(cEl);
                computed = {
                  display: cs.display,
                  width: cs.width,
                  maxWidth: cs.maxWidth,
                  minWidth: cs.minWidth,
                  transform: cs.transform,
                  boxSizing: cs.boxSizing,
                  position: cs.position,
                  flex: cs.flex,
                  flexBasis: cs.flexBasis,
                };
              }
            } catch {
              dom = null;
            }
            // textMeasure: canvas measureText vs glyph advance sum
            let canvasWidth: number | null = null;
            let glyphAdvanceWidth: number | null = null;
            try {
              const style = (block.lines?.[0] as any)?.style || {};
              const fs = style.fontSize || 14;
              const ff = style.fontFamily || "sans-serif";
              const cv = document.createElement("canvas");
              const cctx = cv.getContext("2d");
              if (cctx) {
                cctx.font = `${fs}px ${ff}`;
                canvasWidth = cctx.measureText(text).width;
              }
              let sum = 0;
              for (const l of block.lines ?? []) for (const g of (l as any).glyphs ?? []) sum += g.width ?? 0;
              glyphAdvanceWidth = sum;
            } catch {
              // ignore
            }
            // Render Contract: input(EditableBlock) vs output(GlyphContainer)
            const violation =
              dom && Math.abs(dom.width - ed.width) > 0.5;
            console.log(`%c[Sprint34.24][GlyphSizeSource] text="${text}"`, "color:#22d3ee;");
            console.log(
              `  EditableBlock: x=${ed.x.toFixed(1)} y=${ed.y.toFixed(1)} w=${ed.width.toFixed(1)} h=${ed.height.toFixed(1)}`,
            );
            console.log(
              `  GlyphContainer: x=${dom ? dom.x.toFixed(1) : "n/a"} y=${dom ? dom.y.toFixed(1) : "n/a"} w=${dom ? dom.width.toFixed(1) : "n/a"} h=${dom ? dom.height.toFixed(1) : "n/a"}`,
            );
            console.log(
              `  widthSource: EditableBlock=${ed.width.toFixed(1)} DOM=${dom ? dom.width.toFixed(1) : "n/a"} => ${violation ? "VIOLATION (renderer 重新测量)" : "ok"}`,
            );
            console.log("  computedStyle:", computed);
            console.log(
              `  textMeasure: canvasWidth=${canvasWidth ? canvasWidth.toFixed(1) : "n/a"} glyphAdvanceWidth=${glyphAdvanceWidth ? glyphAdvanceWidth.toFixed(1) : "n/a"}`,
            );
            console.log(
              `%c[Sprint34.24][RenderContract] input width=${ed.width.toFixed(1)} output width=${dom ? dom.width.toFixed(1) : "n/a"} violation=${violation}`,
              violation ? "color:#ef4444;font-weight:bold;" : "color:#22d3ee;",
            );
          }
          resolve(null);
        });
      });
    };
    return () => {
      delete (window as any).__glyphSizeSourceAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.25: Rotation Chain Audit ──
  // 一次性输出 rotation 全链路：signatureRotationRef → signatureTransformContexts → layout → 实际 span
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__rotationChainAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.25] No doc");
        return;
      }
      console.log(
        "%c[Sprint34.25][RotationChain]",
        "font-weight:bold;color:#06b6d4;",
      );
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim().substring(0, 40);
        const refRot = signatureRotationRef.current.get(blockId);
        const ctxRot = ctx.rotation;
        // layout 里该 block 所在 signature 节点的 rotation
        let layoutRot: number | null = null;
        let regionId = "";
        try {
          for (const pg of layoutDocument?.pages ?? []) {
            for (const topNode of pg.children) {
              if (topNode.type === "signature") {
                for (const ch of topNode.children) {
                  if (ch.sourceBlockId === blockId) {
                    layoutRot = topNode.transform.rotation;
                    regionId = topNode.id;
                  }
                }
              }
            }
          }
        } catch {
          layoutRot = null;
        }
        // 实际渲染 span 的 style.transform
        let spanTransform: string | null = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          if (el) spanTransform = el.style.transform || "none";
        } catch {
          spanTransform = null;
        }
        console.log(
          `%c[Sprint34.25][RotationChain] ${text}`,
          "color:#22d3ee;",
        );
        console.log(
          `  signatureRotationRef=${refRot?.toFixed?.(3) ?? "undefined"} ` +
            `signatureTransformContexts.rotation=${ctxRot?.toFixed?.(3)} ` +
            `layout.regionId=${regionId || "-"} layout.transform.rotation=${layoutRot?.toFixed?.(3) ?? "null"} ` +
            `span.style.transform="${spanTransform}"`,
        );
      }
    };
    return () => {
      delete (window as any).__rotationChainAudit;
    };
  }, [signatureTransformContexts, layoutDocument, editableDocVersion]);
}
