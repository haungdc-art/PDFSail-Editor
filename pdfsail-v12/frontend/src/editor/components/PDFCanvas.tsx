/**
 * PDFCanvas — Commit 2
 *
 * Canvas 冻结区：仅 JSX 提取，不改动 PDF.js + WASM 渲染逻辑。
 * 从 PDFEditor.tsx L675-968 提取。
 *
 * Ref 由 PDFEditorInner 持有并传入（render + drag/resize useEffect 仍在 PDFEditorInner）：
 *   canvasRef / wrapperRef / dragRef / resizeRef
 *
 * 跨 domain 回调通过 props 注入：
 *   addBlock / handleOCRRegion / handleUpload / exitEditMode
 */

import { createPortal } from "react-dom";
import { v4 as uuid } from "uuid";
import { useState, useRef, Fragment, useEffect, type RefObject } from "react";
import type { Block, TextBlock } from "../types";
import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";
import { EditableTextNode } from "../../editor-engine/EditableTextNode";
// Sprint 5: Glyph-Level Rendering
import { DispatcherGlyphLayer } from "../../renderer-dispatcher/dispatcher-glyph-layer";
import type { RenderCommand, DrawImageCommand } from "../../document-model/render-command";
import type { EditableStyle, BBox } from "../../document-model/types";
import type { GlyphClickInfo, GlyphSelectInfo } from "../../document-model/glyph-renderer";
// M7.6-001: Native Canvas Display — render mode feature flag
import { getViewRenderingMode } from "../../document-model/view-mode";
// M5-IMPLEMENT-003B-UI: Visual Caret
import { CaretLayer, type CaretLayerPosition } from "./CaretLayer";
// M7.7-002/003: 编辑态 selection 高亮（旋转四边形，叠加层，不改 Canvas）
import { SelectionHighlightLayer } from "./SelectionHighlightLayer";
// M7.7-003: 拖选浮层 Action Menu（Edit Text / Copy / Ask AI）
import { SelectionActionMenu } from "./SelectionActionMenu";
import { glyphQuad, type GlyphQuad } from "../../document-model/edit-transform-geometry";
// Sprint 29: Background Patch Layer
import { BackgroundPatchLayer } from "../../document-model/background-patch-layer";
// Sprint 32: Text Edit Overlay
import { TextEditOverlay } from "./TextEditOverlay";
import type { DrawGlyphCommand } from "../../document-model/render-command";

// ═══════════════════════════════════════════════════════════════
// M7.8-047 · C2 Editing Hit Geometry（EditingHitGeometry）
// 复用 edit-transform-geometry.glyphQuad（唯一合法 C2 实现），
// 数据源只读 glyphCommands（= __editableDocument.pages[].blocks[].lines[].glyphs[]）。
// 禁止新增 editableGlyphHitbox / glyphHitCache / editingBBox 等新模型。
// ═══════════════════════════════════════════════════════════════

/** 点在凸四边形内（叉积符号一致性；旋转/倾斜 glyph 同样适用） */
function pointInGlyphQuad(px: number, py: number, q: GlyphQuad): boolean {
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  const d1 = cross(px, py, q.p1.x, q.p1.y, q.p2.x, q.p2.y);
  const d2 = cross(px, py, q.p2.x, q.p2.y, q.p3.x, q.p3.y);
  const d3 = cross(px, py, q.p3.x, q.p3.y, q.p4.x, q.p4.y);
  const d4 = cross(px, py, q.p4.x, q.p4.y, q.p1.x, q.p1.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0 || d4 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0 || d4 > 0;
  return !(hasNeg && hasPos);
}

/**
 * C2 hit-test：给定文档坐标，返回包含该点的「唯一归属」blockId（glyph quad 并集）。
 * - 仅一个 block 命中 → 返回它。
 * - 多个 block 命中（真实重叠，如 block 7↔8）→ 取「最近 glyph 中心 / 最小 quad 面积」裁决，
 *   不得静默给邻居（045 R：冲突禁止 DOM 顺序「后者胜」）。
 * - 无命中（block 空白 / 幽灵区）→ null（仅 selection，不进编辑）。
 */
function hitBlockByGlyphQuad(
  glyphs: RenderCommand[] | undefined,
  docX: number,
  docY: number,
): string | null {
  if (!glyphs || glyphs.length === 0) return null;
  const candidates = new Map<string, { dist: number; area: number }>();
  for (const cmd of glyphs) {
    if (cmd.type !== "drawGlyph") continue;
    const q = glyphQuad({
      bbox: { x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height },
      transform: cmd.transform,
    });
    if (!pointInGlyphQuad(docX, docY, q)) continue;
    const cx = (q.p1.x + q.p2.x + q.p3.x + q.p4.x) / 4;
    const cy = (q.p1.y + q.p2.y + q.p3.y + q.p4.y) / 4;
    const dist = Math.hypot(docX - cx, docY - cy);
    const area = Math.abs(
      (q.p2.x - q.p1.x) * (q.p3.y - q.p2.y) - (q.p3.x - q.p2.x) * (q.p2.y - q.p1.y),
    );
    const prev = candidates.get(cmd.blockId);
    if (!prev || dist < prev.dist) candidates.set(cmd.blockId, { dist, area });
  }
  if (candidates.size === 0) return null;
  if (candidates.size === 1) return candidates.keys().next().value ?? null;
  const sorted = [...candidates.entries()].sort(
    (a, b) => a[1].dist - b[1].dist || a[1].area - b[1].area,
  );
  return sorted[0][0];
}

// [M7.8-002] TextGeometry adapter verification probe (temporary, remove after Spike M7.8)
// 比对 EditableTextNode 的 source geometry（glyph-derived segment box, window.__etnGeo）
// 与 editable geometry（EditableTextNode 实际 DOM rect），验证其完全消费 PDF glyph geometry。
// 用法浏览器控制台： __m78002('seg_xxx') 单段； __m78002() 遍历全部并输出 max delta 汇总。
(function installM78002() {
  if ((window as any).__m78002) return;
  (window as any).__m78002 = (segmentId?: string) => {
    const geo = (window as any).__etnGeo || {};
    const ids = segmentId ? [segmentId] : Object.keys(geo);
    const results: any[] = [];
    let maxDx = 0, maxDy = 0, maxDb = 0;
    for (const id of ids) {
      const src = geo[id];
      if (!src) {
        results.push({ segmentId: id, error: "no source geometry registered (window.__etnGeo)" });
        continue;
      }
      const el = document.querySelector(`[data-segment-id="${id}"]`) as HTMLElement | null;
      if (!el) {
        results.push({ segmentId: id, error: "EditableTextNode not found in DOM [data-segment-id]" });
        continue;
      }
      // 用本地布局坐标（offset*），与 source 的 cssX/cssY 同属图层本地坐标系，
      // 不受祖先 CSS scale transform 影响（getBoundingClientRect 会被缩放而失准）。
      const editable = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, baseline: el.offsetTop + el.offsetHeight };
      const deltaX = +(editable.x - src.x).toFixed(3);
      const deltaY = +(editable.y - src.y).toFixed(3);
      const deltaBaseline = +(editable.baseline - src.baseline).toFixed(3);
      const deltaHeight = +(editable.h - src.h).toFixed(3);
      maxDx = Math.max(maxDx, Math.abs(deltaX));
      maxDy = Math.max(maxDy, Math.abs(deltaY));
      maxDb = Math.max(maxDb, Math.abs(deltaBaseline));
      results.push({
        segmentId: id,
        sourceGeometry: { x: src.x, y: src.y, w: src.w, h: src.h, baseline: src.baseline },
        editableGeometry: editable,
        deltaX,
        deltaY,
        deltaBaseline,
        deltaHeight,
      });
    }
    if (segmentId) {
      console.log("[M7.8-002][GEOMETRY]", results[0]);
      return results[0];
    }
    const pass = maxDx < 1 && maxDy < 1 && maxDb < 1;
    const summary = {
      pass,
      segmentCount: ids.length,
      maxDeltaX: +maxDx.toFixed(3),
      maxDeltaY: +maxDy.toFixed(3),
      maxDeltaBaseline: +maxDb.toFixed(3),
      acceptance: { deltaX_1px: maxDx < 1, deltaY_1px: maxDy < 1, deltaBaseline_1px: maxDb < 1 },
    };
    console.log("[M7.8-002][GEOMETRY_SUMMARY]", summary);
    results.forEach((res) => console.log("[M7.8-002][GEOMETRY]", res));
    return { summary, results };
  };
})();

// [M7.8-003] FONT_INHERIT verification probe (temporary, remove after Spike M7.8)
// 比对 EditableTextNode 的 editableFont（实际 computed style）与 pdfFont（glyph-derived segment.font），
// 验证 font-family/size/weight/style/letter-spacing/transform 全部继承自 PDF glyph style。
// 用法浏览器控制台： __m78003('seg_xxx') 单段； __m78003() 遍历全部并输出 match 汇总。
(function installM78003() {
  if ((window as any).__m78003) return;
  const normFamily = (s: string) => s.toLowerCase().replace(/['"]/g, "").replace(/\s+/g, " ").trim();
  (window as any).__m78003 = (segmentId?: string) => {
    const fontMap = (window as any).__etnFont || {};
    const ids = segmentId ? [segmentId] : Object.keys(fontMap);
    const results: any[] = [];
    let allMatch = true;
    const propMiss: Record<string, number> = {};
    const PROPS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "transform"] as const;
    for (const id of ids) {
      const pdf = fontMap[id];
      if (!pdf) {
        results.push({ segmentId: id, error: "no pdfFont registered (window.__etnFont)" });
        continue;
      }
      const el = document.querySelector(`[data-segment-id="${id}"]`) as HTMLElement | null;
      if (!el) {
        results.push({ segmentId: id, error: "EditableTextNode not found in DOM [data-segment-id]" });
        continue;
      }
      const cs = getComputedStyle(el);
      const editable = {
        fontFamily: cs.fontFamily,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: cs.fontWeight === "normal" ? 400 : cs.fontWeight === "bold" ? 700 : parseInt(cs.fontWeight, 10) || 400,
        fontStyle: cs.fontStyle,
        letterSpacing: cs.letterSpacing,
        transform: cs.transform,
      };
      const checks: Record<string, boolean> = {};
      checks.fontFamily = normFamily(editable.fontFamily) === normFamily(pdf.fontFamily);
      checks.fontSize = Math.abs(editable.fontSize - pdf.fontSize) < 0.5;
      checks.fontWeight = editable.fontWeight === pdf.fontWeight;
      checks.fontStyle = editable.fontStyle === pdf.fontStyle;
      checks.letterSpacing = (editable.letterSpacing === "normal" && pdf.letterSpacing === "normal") || editable.letterSpacing === pdf.letterSpacing;
      checks.transform = editable.transform === pdf.transform;
      const segMatch = Object.values(checks).every(Boolean);
      if (!segMatch) {
        allMatch = false;
        for (const p of PROPS) if (!checks[p]) propMiss[p] = (propMiss[p] || 0) + 1;
      }
      results.push({
        segmentId: id,
        pdfFont: { fontFamily: pdf.fontFamily, fontSize: pdf.fontSize, fontWeight: pdf.fontWeight, fontStyle: pdf.fontStyle, letterSpacing: pdf.letterSpacing, transform: pdf.transform },
        editableFont: editable,
        match: segMatch,
        checks,
      });
    }
    if (segmentId) {
      console.log("[M7.8-003][FONT_COMPARE]", results[0]);
      return results[0];
    }
    const summary = {
      match: allMatch,
      segmentCount: ids.length,
      mismatchedSegments: results.filter((r) => r.match === false).length,
      propMismatchCounts: propMiss,
    };
    console.log("[M7.8-003][FONT_COMPARE]", summary);
    results.forEach((res) => console.log("[M7.8-003][FONT_COMPARE]", res));
    return { summary, results };
  };
})();

// [M7.8-004] EDIT_VISIBILITY verification probe (temporary, remove after Spike M7.8)
// 验证进入编辑态隐藏目标 segment 的原 glyph（PDF canvas 墨迹被 EditableTextNode 不透明白底覆盖），退出恢复。
// 用法：浏览器控制台先 __m78004('seg_xxx')（ARM，捕获 before），再点该段进入编辑（捕获 duringEdit），
//       回车/失焦退出（捕获 after）→ 自动打印 [M7.8-004][VISIBILITY]。
(function installM78004() {
  if ((window as any).__m78004) return;
  const parseAlpha = (bg: string): number => {
    const m = bg.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
    return m ? parseFloat(m[1]) : 1;
  };
  // 关键：段的随机后缀在文档重解析时会变，故按几何位置(box)而非 id 跟踪，规避 id 重生成。
  const findElByBox = (box: { l: number; t: number; w: number; h: number }) => {
    let best: HTMLElement | null = null;
    let bestD = 1e9;
    for (const e of document.querySelectorAll<HTMLElement>("[data-segment-id]")) {
      const l = e.offsetLeft, t = e.offsetTop, w = e.offsetWidth, h = e.offsetHeight;
      const d = Math.abs(l - box.l) + Math.abs(t - box.t) + 0.5 * Math.abs(w - box.w) + 0.5 * Math.abs(h - box.h);
      if (d < bestD) { bestD = d; best = e; }
    }
    return bestD <= 6 ? best : null;
  };
  const snap = (el: HTMLElement) => {
    const cs = getComputedStyle(el);
    const bgAlpha = parseAlpha(cs.backgroundColor);
    const isEditing = el.getAttribute("contenteditable") === "true";
    const originalGlyphVisible = !(bgAlpha > 0.5);
    return {
      segmentId: el.getAttribute("data-segment-id"),
      isEditing,
      contentEditable: el.getAttribute("contenteditable"),
      background: cs.backgroundColor,
      bgAlpha: +bgAlpha.toFixed(3),
      originalGlyphVisible,
      text: el.textContent,
      box: { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight },
    };
  };
  const startWatch = (box: { l: number; t: number; w: number; h: number }, before: any, segId?: string) => {
    let duringCaptured: any = null;
    let afterCaptured: any = null;
    let done = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // 优先按 data-segment-id 精确跟踪（同一编辑会话内 id 稳定），几何 box 仅作兜底。
    const findEl = (): HTMLElement | null => {
      if (segId) {
        const byId = document.querySelector<HTMLElement>(`[data-segment-id="${segId}"]`);
        if (byId) return byId;
      }
      return findElByBox(box);
    };
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (done) return;
      if (Date.now() - startedAt > 30000) {
        clearInterval(timer);
        console.warn("[M7.8-004] 30s 内未捕获编辑转换，已自动 disarm。");
        return;
      }
      const el = findEl();
      if (!el) return;
      const s = snap(el);
      // duringEdit 只在“已进入编辑且白底已落定（覆盖原 glyph，bgAlpha>0.5）”时捕获，
      // 避免捕获到 contenteditable=true 但背景过渡动画尚未铺开的瞬间（那时原 glyph 仍可见）。
      if (s.isEditing && !duringCaptured && s.bgAlpha > 0.5) {
        duringCaptured = s;
        console.log("[M7.8-004] duringEdit =", s);
      } else if (!s.isEditing && duringCaptured && !afterCaptured) {
        // 仅安排一次 settle：先置占位防止后续轮询反复 clearTimeout 导致永不触发。
        afterCaptured = { __pending: true } as any;
        clearTimeout(settleTimer as any);
        settleTimer = setTimeout(() => {
          const el2 = findEl();
          afterCaptured = el2 ? snap(el2) : null;
          console.log("[M7.8-004] after =", afterCaptured);
          console.log("[M7.8-004][VISIBILITY]", { segmentId: duringCaptured?.segmentId, before, duringEdit: duringCaptured, after: afterCaptured });
          clearInterval(timer);
          done = true;
          console.log("[M7.8-004] done (disarmed)");
        }, 250) as any;
      }
    }, 100);
  };
  (window as any).__m78004 = (segmentId?: string) => {
    const id = (segmentId || "").trim();
    if (id) {
      const el = document.querySelector(`[data-segment-id="${id}"]`) as HTMLElement | null;
      if (!el) {
        console.warn("[M7.8-004] armed id 不在 DOM：", id, "— 后缀已变。改用 __m78004()（无参）点击该段即可 arm。");
        return;
      }
      const box = { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      const before = snap(el);
      console.log("[M7.8-004] armed (by id). before =", before, " — 现在进入并退出该段编辑");
      startWatch(box, before, id);
      return;
    }
    // 无参：点击即 arm（抓点击段的几何 box + before，自动跟踪编辑/退出）
    console.log("[M7.8-004] click-to-arm：点击任意 EditableTextNode 段以开始（随后进入/退出编辑自动采集）");
    const onClick = (ev: MouseEvent) => {
      // 事件目标可能是上层 glyph 渲染层（pointer-events 不在 EditableTextNode 上），
      // 故按点击坐标做命中测试，反查下方包含该点的 [data-segment-id] 元素。
      const px = ev.clientX, py = ev.clientY;
      let hit: HTMLElement | null = null;
      let hitArea = 1e9;
      for (const e of document.querySelectorAll<HTMLElement>("[data-segment-id]")) {
        const r = e.getBoundingClientRect();
        if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
          const area = r.width * r.height;
          if (area < hitArea) { hitArea = area; hit = e; }
        }
      }
      if (!hit) {
        console.warn("[M7.8-004] 点击坐标下未命中任何 segment，未 arm。（确认点在了文本上）");
        return;
      }
      const box = { l: hit.offsetLeft, t: hit.offsetTop, w: hit.offsetWidth, h: hit.offsetHeight };
      const before = snap(hit);
      console.log("[M7.8-004] armed (click). before =", before, " — 该次点击通常即进入编辑；退出后自动采集 after");
      startWatch(box, before, hit.getAttribute("data-segment-id") || undefined);
    };
    document.addEventListener("click", onClick, { capture: true, once: true });
  };
})();

// M7.8-005 HIT_TEST — 验证「点击可见 glyph → 段命中 → TextEditOverlay 打开」。
// 真实点击落在 GlyphRenderer 层（zIndex=GLYPH，位于 EditableTextNode 之上）→ onGlyphClick → openTextEditSession
// （置 textEdit overlay + active editSession，但不置 showTextLayer，故 EditableTextNode 不会变 contenteditable）。
// 用法：控制台 __m78005() 后点击任意可见文字 glyph，自动打印 [M7.8-005][CLICK] {point, segmentId, editorOpened}。
(function installM78005() {
  if ((window as any).__m78005) return;
  const clickToArm = () => {
    if ((window as any).__m78005_armed) {
      console.log("[M7.8-005] 已在 arm 中，等待下一次点击。");
      return;
    }
    (window as any).__m78005_armed = true;
    console.log("[M7.8-005] armed (click-to-arm)：点击任意可见文字 glyph。");
    const onClick = (ev: MouseEvent) => {
      const x = ev.clientX, y = ev.clientY;
      const point = { x: Math.round(x), y: Math.round(y) };
      // 命中测试：包含点击点的 [data-segment-id] 元素（忽略 z-index / pointer-events，反查下方段）。
      // 取面积最小者，命中更精确。
      let segmentId: string | null = null;
      let hitArea = 1e9;
      for (const e of document.querySelectorAll<HTMLElement>("[data-segment-id]")) {
        const r = e.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const area = r.width * r.height;
          if (area < hitArea) { hitArea = area; segmentId = e.getAttribute("data-segment-id"); }
        }
      }
      // 等待编辑器打开（两条等价路径都算）：
      //  A) glyph-click → openTextEditSession → textEdit overlay（data-layer=textEdit）/ active editSession
      //  B) EditableTextNode 点击（Edit 模式下）→ onStartEdit → 该段 contenteditable=true
      setTimeout(() => {
        const contentEditableOpened = !!document.querySelector('[data-segment-id][contenteditable="true"]');
        const editorOpened =
          contentEditableOpened ||
          !!document.querySelector('[data-layer="textEdit"]') ||
          (!!(
            (window as any).__editSession &&
            (window as any).__editSession.status === "active"
          ));
        console.log("[M7.8-005][CLICK]", { point, segmentId, editorOpened });
        (window as any).__m78005_armed = false;
      }, 400);
    };
    document.addEventListener("click", onClick, { capture: true, once: true });
  };
  (window as any).__m78005 = () => clickToArm();
})();

// M7.8-006 INK_ALIGNMENT — 像素级测量 EditableTextNode 黑色文字墨迹 与 PDF 原始 glyph 墨迹 的重叠度。
// 默认 native-canvas 模式下，PDF 原始 glyph 墨迹 = PDF.js 画布位图（data-layer="pdf-canvas" canvas）。
// 两端均做「真实像素 ink bbox」检测：
//   - pdfInkBBox      ：采样 PDF.js 画布在段区域内的暗色墨迹像素 → 屏幕坐标 ink bbox
//   - editableInkBBox ：把 EditableTextNode 文字按其在屏上的逐字符位置（Range 矩形 + 正确 baseline）绘到离屏画布 → 采样 ink bbox
// 两者均为屏幕坐标下的 tight ink bbox，deltaX/deltaY 即真实视觉偏移。
// 用法：控制台 __m78006() 批量测量视口内所有段；__m78006(segId) 只测指定段。
(function installM78006() {
  if ((window as any).__m78006) return;

  // 在画布 imageData 区域内找暗色（ink）像素的包围盒，返回屏幕坐标 bbox（或 null）
  const inkBBoxFromImageData = (
    img: Uint8ClampedArray,
    w: number,
    h: number,
    toScreenX: (px: number) => number,
    toScreenY: (py: number) => number,
  ): { x: number; y: number; w: number; h: number } | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // PDF.js 画布：墨迹为暗色（黑字白底）。透明像素 alpha=0 跳过。
        const a = img[i + 3];
        if (a < 16) continue;
        const lum = (img[i] + img[i + 1] + img[i + 2]) / 3;
        if (lum >= 140) continue; // 非墨迹（背景/浅色）
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        n++;
      }
    }
    if (!n) return null;
    return {
      x: toScreenX(minX),
      y: toScreenY(minY),
      w: toScreenX(maxX + 1) - toScreenX(minX),
      h: toScreenY(maxY + 1) - toScreenY(minY),
    };
  };

  const measureOne = (el: HTMLElement) => {
    const segId = el.getAttribute("data-segment-id") || "";
    const segRect = el.getBoundingClientRect();

    // ---- pdfInkBBox：采样 PDF.js 画布 ----
    let pdfInkBBox: { x: number; y: number; w: number; h: number } | null = null;
    const pdfCanvas = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
    if (pdfCanvas) {
      const cRect = pdfCanvas.getBoundingClientRect();
      const scaleX = pdfCanvas.width / cRect.width;
      const scaleY = pdfCanvas.height / cRect.height;
      const sx = Math.max(0, Math.floor((segRect.left - cRect.left) * scaleX));
      const sy = Math.max(0, Math.floor((segRect.top - cRect.top) * scaleY));
      const sw = Math.max(0, Math.min(pdfCanvas.width - sx, Math.ceil(segRect.width * scaleX)));
      const sh = Math.max(0, Math.min(pdfCanvas.height - sy, Math.ceil(segRect.height * scaleY)));
      if (sw > 0 && sh > 0) {
        const ctx = pdfCanvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          const data = ctx.getImageData(sx, sy, sw, sh).data;
          pdfInkBBox = inkBBoxFromImageData(
            data, sw, sh,
            (px) => cRect.left + (sx + px) / scaleX,
            (py) => cRect.top + (sy + py) / scaleY,
          );
        }
      }
    }

    // ---- editableInkBBox：把 EditableTextNode 文字绘到离屏画布后采样 ----
    let editableInkBBox: { x: number; y: number; w: number; h: number } | null = null;
    const text = el.textContent || "";
    const cs = getComputedStyle(el);
    const fontSpec = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (text && el.firstChild && /\d/.test(cs.fontSize)) {
      const dpr = window.devicePixelRatio || 1;
      const oc = document.createElement("canvas");
      oc.width = Math.max(1, Math.ceil(segRect.width * dpr));
      oc.height = Math.max(1, Math.ceil(segRect.height * dpr));
      const octx = oc.getContext("2d");
      if (octx) {
        octx.scale(dpr, dpr);
        octx.font = fontSpec;
        octx.fillStyle = "#000";
        octx.textBaseline = "alphabetic";
        const fontPx = parseFloat(cs.fontSize);
        const m = octx.measureText("M");
        const A = m.fontBoundingBoxAscent || fontPx * 0.8;
        const D = m.fontBoundingBoxDescent || fontPx * 0.2;
        const range = document.createRange();
        for (let i = 0; i < text.length; i++) {
          try {
            range.setStart(el.firstChild, i);
            range.setEnd(el.firstChild, i + 1);
            const r = range.getBoundingClientRect();
            if (!r || r.width === 0 || r.height === 0) continue;
            const localLeft = r.left - segRect.left;
            const localTop = r.top - segRect.top;
            const lineH = r.height;
            const baselineLocal = localTop + (lineH - A - D) / 2 + A;
            octx.fillText(text[i], localLeft, baselineLocal);
          } catch { /* ignore */ }
        }
        const img = octx.getImageData(0, 0, oc.width, oc.height).data;
        // 离屏画布坐标已是 CSS px（已 scale dpr），转屏幕坐标需加 segRect 原点
        const toScreenX = (px: number) => segRect.left + px / dpr;
        const toScreenY = (py: number) => segRect.top + py / dpr;
        // 用 alpha>10 判定墨迹
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
        for (let y = 0; y < oc.height; y++) {
          for (let x = 0; x < oc.width; x++) {
            const i = (y * oc.width + x) * 4;
            if (img[i + 3] < 10) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            n++;
          }
        }
        if (n) {
          editableInkBBox = {
            x: toScreenX(minX),
            y: toScreenY(minY),
            w: toScreenX(maxX + 1) - toScreenX(minX),
            h: toScreenY(maxY + 1) - toScreenY(minY),
          };
        }
      }
    }

    const dbg = {
      segRect: { x: Math.round(segRect.x), y: Math.round(segRect.y), w: Math.round(segRect.width), h: Math.round(segRect.height) },
      pdfCanvasFound: !!pdfCanvas,
      editableTextLen: text.length,
      firstChildType: el.firstChild ? el.firstChild.nodeType : null,
    };
    if (!pdfInkBBox || !editableInkBBox) {
      return { segmentId: segId, pdfInkBBox, editableInkBBox, deltaX: null, deltaY: null, _dbg: dbg };
    }
    return {
      segmentId: segId,
      pdfInkBBox,
      editableInkBBox,
      deltaX: Math.round((editableInkBBox.x - pdfInkBBox.x) * 100) / 100,
      deltaY: Math.round((editableInkBBox.y - pdfInkBBox.y) * 100) / 100,
      _dbg: dbg,
    };
  };

  const run = (segmentId?: string) => {
    const segEls = Array.from(document.querySelectorAll<HTMLElement>("[data-segment-id]")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 2 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
    });
    const targets = segmentId ? segEls.filter((e) => e.getAttribute("data-segment-id") === segmentId) : segEls;
    if (!targets.length) {
      console.log("[M7.8-006][INK_ALIGNMENT]", { error: "no segment in view", segmentId: segmentId ?? null });
      return;
    }
    const segments = targets.map(measureOne);
    const withDelta = segments.filter((s) => s.deltaX !== null && s.deltaY !== null) as {
      segmentId: string; pdfInkBBox: any; editableInkBBox: any; deltaX: number; deltaY: number;
    }[];
    const summary = withDelta.length
      ? {
          count: withDelta.length,
          maxAbsDeltaX: Math.max(...withDelta.map((s) => Math.abs(s.deltaX))),
          maxAbsDeltaY: Math.max(...withDelta.map((s) => Math.abs(s.deltaY))),
          avgDeltaX: Math.round((withDelta.reduce((a, s) => a + s.deltaX, 0) / withDelta.length) * 100) / 100,
          avgDeltaY: Math.round((withDelta.reduce((a, s) => a + s.deltaY, 0) / withDelta.length) * 100) / 100,
        }
      : null;
    console.log("[M7.8-006][INK_ALIGNMENT]", { segments, summary });
  };
  (window as any).__m78006 = run;
})();

// M7.8-007 VISIBLE_TEXT_OWNER — 只读审计「黄色文本」的真实 DOM owner（不修改任何渲染/坐标/字体）。
// 扫描：1) elementFromPoint(黄色文本中心)  2) elementsFromPoint()  3) 所有包含目标文本字符串的 DOM
// 若目标字符串在文档中不存在 → 退化为「自动检测黄色样式元素」。
// 输出 [M7.8-007][VISIBLE_TEXT_OWNER] = { targetText, matchMode, visibleOwner, elementsFromPoint, allOwners, layerBreakdown }
// 用法：控制台 __m78007("目标文本") 或 __m78007()（默认串 + 自动退化）。
(function installM78007() {
  if ((window as any).__m78007) return;

  const isYellowish = (color: string): boolean => {
    if (!color || color === "none" || color === "transparent") return false;
    const m = color.match(/-?\d+(\.\d+)?/g);
    if (!m || m.length < 3) return false;
    const r = parseInt(m[0], 10), g = parseInt(m[1], 10), b = parseInt(m[2], 10);
    // HSL 转换：精准识别黄色/浅黄色，排除白/灰
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 510;
    const d = max - min;
    if (d < 6 || l < 0.45 || l > 0.99) return false; // 排除深/纯黑/纯白/接近白
    let h = 0;
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    const s = d / (2 * Math.min(l, 1 - l) * 255 + Number.EPSILON);
    // 黄色色相区间约 40-70°，允许低饱和度浅黄
    return h >= 35 && h <= 75 && s >= 0.04;
  };

  const classifyStack = (el: Element | null): string[] => {
    const out: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      const attrs = cur.attributes;
      if (attrs) {
        if (cur.getAttribute("data-segment-id")) out.push("EditableTextNode");
        const dl = cur.getAttribute("data-layer");
        if (dl) {
          if (dl === "textEdit") out.push("TextEditOverlay");
          else if (dl === "overlay") out.push("GlyphRenderer/AI-overlay");
          else if (dl === "mask") out.push("mask");
          else if (dl === "pdf-canvas") out.push("pdf-canvas");
          else if (dl === "glyph") out.push("glyph");
          else if (dl === "backgroundPatch") out.push("backgroundPatch");
          else if (dl === "wrapper") out.push("wrapper");
          else out.push(`layer:${dl}`);
        }
        if (cur.getAttribute("data-selection-highlight")) out.push("selection-highlight");
      }
      const cs = getComputedStyle(cur);
      if (isYellowish(cs.backgroundColor) || isYellowish(cs.borderTopColor) || isYellowish(cs.color) || isYellowish(cs.boxShadow)) {
        if (!out.includes("highlight-block")) out.push("highlight-block");
      }
      cur = cur.parentElement;
    }
    return out;
  };

  const buildSelector = (el: Element): string => {
    if (el.id) return "#" + el.id;
    const seg = el.getAttribute && el.getAttribute("data-segment-id");
    if (seg) return `[data-segment-id="${seg}"]`;
    const dl = el.getAttribute && el.getAttribute("data-layer");
    if (dl) return `[data-layer="${dl}"]`;
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "";
    return el.tagName.toLowerCase() + cls;
  };

  const describe = (el: Element | null) => {
    if (!el || !(el instanceof Element)) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const dataAttrs: Record<string, string> = {};
    const attrs = el.attributes;
    if (attrs) for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.name.startsWith("data-")) dataAttrs[a.name] = a.value;
    }
    const stack = classifyStack(el);
    return {
      selector: buildSelector(el),
      tag: el.tagName,
      class: typeof el.className === "string" ? el.className : "",
      dataAttrs,
      textContent: (el.textContent || "").slice(0, 140),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      zIndex: cs.zIndex,
      opacity: cs.opacity,
      background: cs.backgroundColor,
      display: cs.display,
      pointerEvents: cs.pointerEvents,
      contentEditable: el.getAttribute("contenteditable"),
      layerType: stack.length ? stack[0] : "unknown",
      _layerStack: stack,
    };
  };

  const run = (targetText?: string) => {
    const TARGET = targetText || "This solution addressed impulsive hiring by ensuring";
    const doc = document;
    const all = Array.from(doc.querySelectorAll<HTMLElement>("*"));

    // 1) 文本匹配：包含 TARGET 的「最小」元素（其子元素不再含 TARGET）
    const textOwners: Element[] = [];
    for (const el of all) {
      const tc = el.textContent || "";
      if (tc.includes(TARGET)) {
        const childHas = Array.from(el.children).some((c) => (c.textContent || "").includes(TARGET));
        if (!childHas) textOwners.push(el);
      }
    }

    let matchMode: "text" | "auto-yellow";
    let ownerEls: Element[];
    if (textOwners.length) {
      matchMode = "text";
      ownerEls = textOwners;
    } else {
      // 2) 退化：自动检测黄色样式元素（background / border / color / box-shadow）
      matchMode = "auto-yellow";
      ownerEls = all.filter((el) => {
        const cs = getComputedStyle(el);
        return isYellowish(cs.backgroundColor) || isYellowish(cs.borderTopColor) || isYellowish(cs.color) || isYellowish(cs.boxShadow);
      });
    }

    // 3) 点检测：取首个 owner 中心
    const firstRect = ownerEls.length ? ownerEls[0].getBoundingClientRect() : null;
    const cx = firstRect ? firstRect.left + firstRect.width / 2 : 0;
    const cy = firstRect ? firstRect.top + firstRect.height / 2 : 0;
    const hasPoint = !!(firstRect && firstRect.width && firstRect.height && cx > 0 && cy > 0);
    const visibleOwnerEl = hasPoint ? doc.elementFromPoint(cx, cy) : null;
    const stackAtPoint = hasPoint ? doc.elementsFromPoint(cx, cy) : [];

    const layerBreakdown: Record<string, number> = {};
    for (const el of ownerEls) {
      const stack = classifyStack(el);
      const top = stack.length ? stack[0] : "unknown";
      layerBreakdown[top] = (layerBreakdown[top] || 0) + 1;
    }

    const result = {
      targetText: TARGET,
      matchMode,
      foundCount: ownerEls.length,
      visibleOwner: describe(visibleOwnerEl),
      elementsFromPoint: stackAtPoint.slice(0, 12).map(describe).filter(Boolean),
      allOwners: ownerEls.slice(0, 12).map(describe).filter(Boolean),
      layerBreakdown,
      _probePoint: { x: Math.round(cx), y: Math.round(cy) },
    };
    console.log("[M7.8-007][VISIBLE_TEXT_OWNER]", result);
    return result;
  };
  (window as any).__m78007 = run;
})();

// M7.8-008 EDIT_LAYER_AUDIT — 只读审计 Edit mode 下导致文本漂移的真实渲染层（不修改任何渲染/坐标/CSS）。
// 扫描：1) elementsFromPoint(目标区域中心)  2) 所有含 segmentId / data-layer / contenteditable / textarea 的候选层（与目标区域相交）
// 逐层输出 {selector,tag,class,dataLayer,textContent,rect,zIndex,opacity,background,color,contentEditable,visibility}
// 并对照「原 glyph rect」计算 deltaX / deltaY / deltaBaseline；标记 isDriftCandidate（坐标上移 ∪ 覆盖上一行，且肉眼不可见）。
// 输出 [M7.8-008][EDIT_LAYER_STACK] = { segmentId, editing, glyphRect, glyphSource, layers:[...], driftCandidates:[...] }
// 用法：控制台 __m78008("seg_xxx") 或 __m78008()（自动选取首个可见段）。
(function installM78008() {
  if ((window as any).__m78008) return;

  type R4 = { x: number; y: number; w: number; h: number };
  const r2 = (r: DOMRect): R4 => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  const selOf = (el: HTMLElement): string => {
    const sid = el.getAttribute("data-segment-id");
    const dl = el.getAttribute("data-layer");
    return el.id ? "#" + el.id : sid ? `[data-segment-id="${sid}"]` : dl ? `[data-layer="${dl}"]` : el.tagName.toLowerCase();
  };
  const isYellowish = (c: string): boolean => {
    if (!c || c === "none" || c === "transparent") return false;
    const m = c.match(/-?\d+(\.\d+)?/g);
    if (!m || m.length < 3) return false;
    const r = parseInt(m[0], 10), g = parseInt(m[1], 10), b = parseInt(m[2], 10);
    // HSL 转换：精准识别黄色/浅黄色，排除白/灰
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 510;
    const d = max - min;
    if (d < 6 || l < 0.45 || l > 0.99) return false;
    let h = 0;
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    const s = d / (2 * Math.min(l, 1 - l) * 255 + Number.EPSILON);
    return h >= 35 && h <= 75 && s >= 0.04;
  };

  // 原 glyph rect：优先 pdf-canvas 墨迹采样（真值），失败回退 EditableTextNode 自身 rect。
  const getGlyphRect = (segEl: HTMLElement): { rect: R4; source: string } => {
    const pdfCanvas = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
    const sr = segEl.getBoundingClientRect();
    if (pdfCanvas) {
      try {
        const cr = pdfCanvas.getBoundingClientRect();
        const sx = pdfCanvas.width / cr.width;
        const sy = pdfCanvas.height / cr.height;
        const sx0 = Math.max(0, Math.floor((sr.left - cr.left) * sx));
        const sy0 = Math.max(0, Math.floor((sr.top - cr.top) * sy));
        const sx1 = Math.min(pdfCanvas.width, Math.ceil((sr.right - cr.left) * sx));
        const sy1 = Math.min(pdfCanvas.height, Math.ceil((sr.bottom - cr.top) * sy));
        const W = Math.max(1, sx1 - sx0), H = Math.max(1, sy1 - sy0);
        const ctx = pdfCanvas.getContext("2d");
        if (ctx) {
          const data = ctx.getImageData(sx0, sy0, W, H).data;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const a = data[i + 3];
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (a > 10 && lum < 140) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
          }
          if (minX !== Infinity) {
            return {
              rect: { x: Math.round(cr.left + (sx0 + minX) / sx), y: Math.round(cr.top + (sy0 + minY) / sy), w: Math.round((maxX - minX) / sx), h: Math.round((maxY - minY) / sy) },
              source: "pdf-canvas-ink",
            };
          }
        }
      } catch { /* tainted/unavailable */ }
    }
    return { rect: r2(sr), source: "editable-text-node" };
  };

  const classify = (el: HTMLElement): string => {
    const sid = el.getAttribute("data-segment-id");
    const ce = el.getAttribute("contenteditable");
    if (sid && ce === "true") return "EditableTextNode[contentEditable=edit-surface]";
    if (sid) return "EditableTextNode";
    const dl = el.getAttribute("data-layer");
    if (dl === "textEdit") return "TextEditOverlay";
    if (dl === "overlay") return "AI/glyph-overlay";
    if (dl === "background") return "glyph-layer(background)";
    if (dl === "mask") return "mask";
    if (dl === "pdf-canvas") return "pdf-canvas(glyph-truth)";
    if (dl === "glyph") return "glyph";
    if (dl === "backgroundPatch") return "backgroundPatch";
    if (el.tagName === "TEXTAREA") return "textarea(input-surface/draft)";
    if (ce !== null) return "contenteditable-div";
    if (el.getAttribute("data-selection-highlight")) return "selection-layer";
    const cs = getComputedStyle(el);
    if (isYellowish(cs.backgroundColor) || isYellowish(cs.borderTopColor)) return "highlight-layer";
    if (dl) return `layer:${dl}`;
    return "other";
  };

  const describeLayer = (el: HTMLElement, glyph: R4) => {
    const cs = getComputedStyle(el);
    const rect = r2(el.getBoundingClientRect());
    const deltaX = rect.x - glyph.x;
    const deltaY = rect.y - glyph.y;
    const deltaBaseline = rect.y + rect.h - (glyph.y + glyph.h);
    const invisible = cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0";
    const coversPrevLine = rect.y < glyph.y - 1 && rect.y + rect.h > glyph.y - 2; // 上边界越过 glyph 顶部且仍向下重叠 → 向上覆盖上一行
    const isDriftCandidate = (deltaY < -2 || coversPrevLine) && invisible;
    const sid = el.getAttribute("data-segment-id");
    const dl = el.getAttribute("data-layer");
    const sel = el.id
      ? "#" + el.id
      : sid
        ? `[data-segment-id="${sid}"]`
        : dl
          ? `[data-layer="${dl}"]`
          : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "");
    const dataAttrs: Record<string, string> = {};
    const attrs = el.attributes;
    if (attrs) for (let i = 0; i < attrs.length; i++) { const a = attrs[i]; if (a.name.startsWith("data-")) dataAttrs[a.name] = a.value; }
    return {
      selector: sel,
      tag: el.tagName,
      class: typeof el.className === "string" ? el.className : "",
      dataLayer: dl,
      textContent: (el.textContent || "").slice(0, 80),
      rect,
      zIndex: cs.zIndex,
      opacity: cs.opacity,
      background: cs.backgroundColor,
      color: cs.color,
      contentEditable: el.getAttribute("contenteditable"),
      visibility: cs.visibility,
      layerRole: classify(el),
      deltaX,
      deltaY,
      deltaBaseline,
      invisible,
      coversPrevLine,
      isDriftCandidate,
    };
  };

  const run = (segId?: string) => {
    const segEls = Array.from(document.querySelectorAll<HTMLElement>("[data-segment-id]")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 1;
    });
    const targets = segId ? segEls.filter((e) => e.getAttribute("data-segment-id") === segId) : segEls;
    const seg = targets[0];
    if (!seg) { console.log("[M7.8-008][EDIT_LAYER_STACK]", { error: "no-segment-found" }); return; }

    const sid = seg.getAttribute("data-segment-id") as string;
    const glyph = getGlyphRect(seg);
    const center = { x: glyph.rect.x + glyph.rect.w / 2, y: glyph.rect.y + glyph.rect.h / 2 };
    const fromPoint = document.elementsFromPoint(center.x, center.y);

    const candidates = new Set<HTMLElement>();
    for (const el of fromPoint) candidates.add(el as HTMLElement);
    const near = (r: DOMRect): boolean =>
      r.right >= glyph.rect.x - 40 && r.left <= glyph.rect.x + glyph.rect.w + 40 && r.bottom >= glyph.rect.y - 40 && r.top <= glyph.rect.y + glyph.rect.h + 40;
    document.querySelectorAll<HTMLElement>("[data-segment-id],[data-layer],[contenteditable],textarea").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (near(r)) candidates.add(el);
    });

    const layers = Array.from(candidates)
      .map((el) => describeLayer(el, glyph.rect))
      .filter((l) => l.rect.w > 0 || l.rect.h > 0);
    layers.sort((a, b) => Number(b.isDriftCandidate) - Number(a.isDriftCandidate) || a.deltaY - b.deltaY);

    const top = fromPoint[0] as HTMLElement | undefined;
    const editing = !!document.querySelector('[data-layer="textEdit"]') || !!document.querySelector('[contenteditable="true"]');

    // 全文档层普查：抓取黄色(highlight)层、任何不可见残留层、以及所有 EditableTextNode 的位置
    // 收敛到文档 wrapper 内，排除工具栏等 UI 白/灰误报
    const censusRoot = (document.querySelector('[data-layer="wrapper"]') as HTMLElement | null) || document.body;
    const censusEls = Array.from(censusRoot.querySelectorAll<HTMLElement>("[data-segment-id],[data-layer],[contenteditable],textarea"));

    // 检测 pdf-canvas 在指定段矩形内是否有墨迹（用于识别“阴影块/空段”：有文字但底层无 ink）
    const canvasEl = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
    // 只采样盒子“文字主体区”（上下 20%~85%），避免误采相邻行的墨迹（gap 段才会读不到 ink）
    const inkBand = (sr: DOMRect) => {
      const top = sr.top + sr.height * 0.2;
      const bot = sr.top + sr.height * 0.85;
      const cr = canvasEl!.getBoundingClientRect();
      const sx = canvasEl!.width / Math.max(1, cr.width);
      const sy = canvasEl!.height / Math.max(1, cr.height);
      return {
        x0: Math.max(0, Math.floor((sr.left - cr.left) * sx)),
        y0: Math.max(0, Math.floor((top - cr.top) * sy)),
        x1: Math.min(canvasEl!.width, Math.ceil((sr.right - cr.left) * sx)),
        y1: Math.min(canvasEl!.height, Math.ceil((bot - cr.top) * sy)),
        crTop: cr.top, sy,
      };
    };
    const canvasInk = (sr: DOMRect): boolean | null => {
      if (!canvasEl) return null;
      try {
        const b = inkBand(sr);
        const W = Math.max(1, b.x1 - b.x0), H = Math.max(1, b.y1 - b.y0);
        const ctx = canvasEl.getContext("2d");
        if (!ctx) return null;
        const data = ctx.getImageData(b.x0, b.y0, W, H).data;
        for (let i = 0; i < data.length; i += 4) {
          if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 200) return true; // 暗像素 = 有墨迹
        }
        return false;
      } catch {
        return null;
      }
    };
    // 返回段文字主体区内最上方墨迹像素的 CSS y（用于计算“盒子相对真实文字上移了多少”）
    const inkTopY = (sr: DOMRect): number | null => {
      if (!canvasEl) return null;
      try {
        const b = inkBand(sr);
        const W = Math.max(1, b.x1 - b.x0), H = Math.max(1, b.y1 - b.y0);
        const ctx = canvasEl.getContext("2d");
        if (!ctx) return null;
        const data = ctx.getImageData(b.x0, b.y0, W, H).data;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 200) {
              return Math.round(b.crTop + (b.y0 + y) / b.sy);
            }
          }
        }
        return null;
      } catch {
        return null;
      }
    };
    const yellowish: Array<{ selector: string; layerRole: string; rect: R4; background: string; borderTopColor: string }> = [];
    const invisibleAnywhere: Array<{ selector: string; layerRole: string; rect: R4; opacity: string; visibility: string; display: string; textContent: string }> = [];
    const editableNodes: Array<{ segId: string; rect: R4; deltaY: number; background: string; color: string; contentEditable: string | null; textContent: string; hasInk: boolean | null; driftUp: number | null }> = [];
    for (const el of censusEls) {
      const cs = getComputedStyle(el);
      const r = r2(el.getBoundingClientRect());
      if (isYellowish(cs.backgroundColor) || isYellowish(cs.borderTopColor) || isYellowish(cs.color) || /highlight/i.test(typeof el.className === "string" ? el.className : "") || (el.getAttribute("data-layer") || "").includes("highlight") || el.getAttribute("data-selection-highlight") !== null) {
        yellowish.push({ selector: selOf(el), layerRole: classify(el), rect: r, background: cs.backgroundColor, borderTopColor: cs.borderTopColor });
      }
      // 同时扫描子元素：浅黄高亮背景可能加在内部 span/div 上
      const patchChildren = Array.from(el.querySelectorAll<HTMLElement>("*")).filter((child) => {
        const ccs = getComputedStyle(child);
        return ccs.backgroundColor !== "rgba(0, 0, 0, 0)" && ccs.backgroundColor !== "transparent" && ccs.backgroundColor !== "none";
      });
      for (const child of patchChildren) {
        const ccs = getComputedStyle(child);
        const cr = r2(child.getBoundingClientRect());
        if (isYellowish(ccs.backgroundColor) || isYellowish(ccs.borderTopColor) || isYellowish(ccs.color)) {
          yellowish.push({ selector: `${selOf(child)} < ${selOf(el)}`, layerRole: classify(child), rect: cr, background: ccs.backgroundColor, borderTopColor: ccs.borderTopColor });
        }
      }
      if ((cs.opacity === "0" || cs.visibility === "hidden" || cs.display === "none") && r.w > 0 && r.h > 0) {
        invisibleAnywhere.push({ selector: selOf(el), layerRole: classify(el), rect: r, opacity: cs.opacity, visibility: cs.visibility, display: cs.display, textContent: (el.textContent || "").slice(0, 40) });
      }
      if (el.getAttribute("data-segment-id")) {
        const d = describeLayer(el, glyph.rect);
        const ink = canvasInk({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h } as DOMRect);
        const topY = inkTopY({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h } as DOMRect);
        const driftUp = topY != null ? topY - r.y : null; // >0：盒子相对真实文字上移（夹在两行中间）
        editableNodes.push({ segId: el.getAttribute("data-segment-id") as string, rect: r, deltaY: d.deltaY, background: cs.backgroundColor, color: cs.color, contentEditable: el.getAttribute("contenteditable"), textContent: (el.textContent || "").slice(0, 60), hasInk: ink, driftUp });
      }
    }
    // 阴影块/空段：有文字但底层 pdf-canvas 无墨迹（浏览模式下完全透明，编辑后才显形）
    const phantoms = editableNodes
      .filter((e) => (e.textContent || "").trim().length > 0 && e.hasInk === false)
      .map((e) => ({ segId: e.segId, rect: e.rect, textContent: e.textContent }));
    // 漂移段：盒子相对自身真实文字（墨迹）上移超过阈值（夹在两行之间）
    const driftSegments = editableNodes
      .filter((e) => e.driftUp != null && e.driftUp > 6)
      .map((e) => ({ segId: e.segId, rect: e.rect, driftUp: e.driftUp, textContent: e.textContent }))
      .sort((a, b) => (b.driftUp as number) - (a.driftUp as number));
    const census = { yellowish, invisibleAnywhere, editableNodes, phantoms, driftSegments };

    const result = {
      segmentId: sid,
      editing,
      glyphRect: glyph.rect,
      glyphSource: glyph.source,
      probeCenter: { x: Math.round(center.x), y: Math.round(center.y) },
      elementFromPointTop: top ? top.tagName + (top.getAttribute("data-layer") ? `[data-layer="${top.getAttribute("data-layer")}"]` : top.getAttribute("data-segment-id") ? `[data-segment-id="${top.getAttribute("data-segment-id")}"]` : "") : null,
      layers,
      driftCandidates: layers
        .filter((l) => l.isDriftCandidate)
        .map((l) => ({ selector: l.selector, layerRole: l.layerRole, deltaX: l.deltaX, deltaY: l.deltaY, deltaBaseline: l.deltaBaseline, coversPrevLine: l.coversPrevLine, opacity: l.opacity, visibility: l.visibility, background: l.background, color: l.color })),
      census,
    };
    console.log("[M7.8-008][EDIT_LAYER_STACK]", result);
    return result;
  };
  (window as any).__m78008 = run;

  // 仅返回“阴影块/空段”列表：有文字但底层 pdf-canvas 无墨迹（浏览模式完全透明，编辑后显形）
  (window as any).__m78008_phantoms = () => {
    const root = (document.querySelector('[data-layer="wrapper"]') as HTMLElement | null) || document.body;
    const els = Array.from(root.querySelectorAll<HTMLElement>("[data-segment-id]"));
    const canvasEl = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
    const inkAt = (r: DOMRect): boolean | null => {
      if (!canvasEl) return null;
      try {
        const top = r.top + r.height * 0.2, bot = r.top + r.height * 0.85;
        const cr = canvasEl.getBoundingClientRect();
        const sx = canvasEl.width / Math.max(1, cr.width);
        const sy = canvasEl.height / Math.max(1, cr.height);
        const x0 = Math.max(0, Math.floor((r.left - cr.left) * sx));
        const y0 = Math.max(0, Math.floor((top - cr.top) * sy));
        const x1 = Math.min(canvasEl.width, Math.ceil((r.right - cr.left) * sx));
        const y1 = Math.min(canvasEl.height, Math.ceil((bot - cr.top) * sy));
        const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0);
        const ctx = canvasEl.getContext("2d");
        if (!ctx) return null;
        const data = ctx.getImageData(x0, y0, W, H).data;
        for (let i = 0; i < data.length; i += 4) {
          if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 200) return true;
        }
        return false;
      } catch {
        return null;
      }
    };
    const out: Array<{ segId: string; rect: { x: number; y: number; w: number; h: number }; textContent: string }> = [];
    for (const el of els) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      const r = el.getBoundingClientRect();
      const hasInk = inkAt(r);
      if (hasInk === false) out.push({ segId: el.getAttribute("data-segment-id") as string, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, textContent: t.slice(0, 60) });
    }
    return out;
  };
})();
// Sprint34.1: 统一渲染层级常量
import { RenderLayer } from "../../document-model/render-layer";

const navBtn: React.CSSProperties = {
  padding: "4px 10px",
  background: "rgba(0,0,0,0.55)",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

interface PDFCanvasProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  wrapperRef: RefObject<HTMLDivElement>;
  dragRef: React.MutableRefObject<{ id: string; ox: number; oy: number; ox0: number; oy0: number } | null>;
  resizeRef: React.MutableRefObject<{ id: string; startX: number; startY: number; initW: number; initH: number } | null>;
  addBlock: (type: Block["type"], extra?: any) => void;
  handleOCRRegion: (x: number, y: number, w: number, h: number) => void;
  /** Bug 7: 画布空状态上传组件使用 */
  handleUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Bug 15: 退出 Edit 模式 */
  exitEditMode: () => void;
  /** OCR 流程：单击 text block 即进入编辑（selection-first 交互） */
  enableClickToEdit?: boolean;
  /** Sprint 5: Glyph 级渲染命令（非空时启用 GlyphRenderer 覆盖层） */
  glyphCommands?: RenderCommand[];
  /** Sprint 5: 文档级样式表（GlyphRenderer 解析 styleRef 用） */
  docStyles?: EditableStyle[];
  /** Sprint 6: 选中的 glyph ID 集合 */
  selectedGlyphIds?: Set<string>;
  /** Sprint 6: glyph 点击回调 */
  onGlyphClick?: (info: GlyphClickInfo) => void;
  /**
   * M7.8-022 Phase A: segment 编辑提交回调。
   *
   * segment 编辑（EditableTextNode）只写入 segments state 与 docBlocks，从不写回
   * EditableDocument，导致 markLineEdited 从未被调用 → editedLineBoxes 无该行
   * → 导出 mask 走 fallback（line.bbox ∪ glyph 并集），不含 ascender/descender，
   * 因此原 PDF 文字未被完全遮盖（残留约 4~6px）。
   *
   * 本回调让 segment 编辑进入现有统一路径：
   *   segment edit → markLineEdited → canvas ink scan → editedLineBoxes → mask
   *
   * 必须在 replacement 覆盖 canvas 之前触发（此处 onChange 早于任何重绘），
   * 否则 ink scan 扫到的是新文字而非原始墨迹。
   */
  onSegmentCommit?: (segmentId: string, newText: string) => void;
  /**
   * OCR-EDIT-SYNC: 段落块 Portal 编辑提交回调。
   *
   * 背景：扫描件（无原生文本层）经 OCR 注入的 docBlocks 是**段落级**文本块，
   * 而页面显示（GlyphRenderer）与导出（exportEditableDocument）都只消费
   * EditableDocument —— 且 native-canvas 视图模式下 block 自身的文字 span 被隐藏
   * （viewMode === "native-canvas" → nativeHideBlockVisual，见 BLOCKS 渲染分支）。
   * 结果：Portal 编辑只写 docBlocks → 提交后页面回退原文、导出也是原文。
   *
   * 本回调让 Portal 编辑在写 docBlocks 的同时把文本同步回 EditableDocument，
   * 使「编辑态 / 提交后显示 / 导出」三者一致。
   */
  onBlockTextCommit?: (blockId: string, newText: string) => void;
  /** Sprint 6: glyph 拖拽选择回调 */
  onGlyphSelect?: (info: GlyphSelectInfo) => void;
  /** Sprint 6: glyph 编辑回调（触发 Document Mutation） */
  onGlyphEdit?: (glyph: DrawGlyphCommand, newText: string) => void;
  /** Task-013A/013B: Selection 变化回调（暴露 DerivedSelection，供 Provider 消费） */
  onSelectionChanged?: (derived: import("../../document-model/selection-engine").DerivedSelection | null) => void;
  /** M7.7-003: 拖选结束（mouseup）一次性提交最终选区 → 直接进入 inline EditSession */
  onDragSelectCommit?: (derived: import("../../document-model/selection-engine").DerivedSelection | null) => void;
  /** Sprint 32: 正在编辑的 block ID */
  editingBlockId?: string | null;
  /** M7.7-004C: 编辑行真实文字覆盖盒（PDFEditor 扫描 canvas 扩展后的行级 bbox）→ mask 覆盖真实文字右缘 */
  editingLineBox?: { x: number; y: number; width: number; height: number } | null;
  /** Sprint 32: TextEditOverlay 数据 */
  textEdit?: {
    blockId: string;
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
    fontSize?: number;
    fontFamily?: string;
    /** PDF 原字体名（如 g_d0_f2），传给 TextEditOverlay 以保持字形保真 */
    pdfjsFontFamily?: string;
    /** M7.7-003A: 字重（glyph styleRef → styles[].fontWeight） */
    fontWeight?: number;
    /** M7.7-003A: 行高（glyph styleRef → styles[].lineHeight） */
    lineHeight?: number;
    /** M7.7-003: 行级 CSS 归一化 transform（textEdit 为行内编辑，跟随文字方向） */
    transform?: [number, number, number, number, number, number];
  } | null;
  /** Sprint 32: 文本编辑保存回调 */
  onTextEditSave?: (blockId: string, newText: string) => void;
  /** Sprint 32: 文本编辑取消回调 */
  onTextEditCancel?: () => void;
  /** M5-003C-UI: 当前 EditSession（TextEditOverlay 显示/键盘 truth 来源） */
  editSession?: import("../../document-model/edit-session").EditSession | null;
  /** M5-003C-UI: 键盘编辑回调（TextEditOverlay → PDFEditor handler → editingMode 状态机） */
  onKeyboardEdit?: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    session: import("../../document-model/edit-session").EditSession
  ) => void;
  /** M7-001: Paste 回调（TextEditOverlay → PDFEditor handler → insertAtGlyph） */
  onPaste?: (
    text: string,
    session: import("../../document-model/edit-session").EditSession
  ) => void;
  /** M7.7-004 (Bug2): DOM caret → session caret 同步回调（TextEditOverlay → PDFEditor setEditSession） */
  onCaretChange?: (session: import("../../document-model/edit-session").EditSession) => void;
  /** M7.7-006B (CJK/insertText 回收): textarea input → PDFEditor applyTextareaValue */
  onTextInput?: (value: string, cursorUtf16: number, session: import("../../document-model/edit-session").EditSession) => void;
  /** Sprint 33.3.4: blockId → rotation (deg)，用于签名区域块级旋转 */
  blockRotations?: Map<string, number>;
  /** Sprint 33.3.5 Task 4: blockId → regionId + rotation，用于签名区域分组渲染 */
  signatureRegionMap?: Map<string, { regionId: string; rotation: number }>;
  /** Sprint 33.5.6: 签名区域独立渲染模型 */
  signatureRegions?: import("../../document-model/types").SignatureRenderRegion[];
  /** Sprint34.15: blockId → SignatureTransformContext（统一签名旋转 pivot） */
  signatureTransformContexts?: Map<string, import("../../document-model/signature-transform-context").SignatureTransformContext>;
  /** Sprint-109 (First Paint): 唯一 Reveal Gate。sceneReady 前隐藏 z0 底图 + z30 编辑层，
      两者同帧 reveal（Atomic Swap），消灭 "原文→编辑层" 中间态。 */
  sceneReady?: boolean;
  /** Sprint-126 Task-3 (PM 拍板): z0 底图（Physical 层）独立 reveal 信号。
      sceneReadyBase=true → z0 显示（Fallback = Bitmap Only）；z30 编辑层仍由 sceneReady 控制。
      文本 PDF: sceneReadyBase 与 sceneReady 同时 true → 行为不变。
      扫描件 f8c295c7: sceneReadyBase=true（bitmap valid 即置位）+ sceneReady=false → 只显示底图。 */
  sceneReadyBase?: boolean;
  /** M5-IMPLEMENT-003B-UI: 编辑光标位置（resolveCaretPosition 计算，glyph bbox CSS 坐标） */
  caretPosition?: CaretLayerPosition | null;
  /** M7.7-002/003: 编辑态 selection 高亮四边形（selectionHighlightQuads 计算，世界 CSS 坐标） */
  selectionHighlight?: ReadonlyArray<GlyphQuad>;
  /** M7.7-003: 拖选浮层 Action Menu（位置=世界 CSS 坐标；操作回调） */
  selectionMenu?: { text: string; x: number; y: number } | null;
  onMenuEditText?: () => void;
  onMenuCopy?: () => void;
  onMenuAskAI?: () => void;
  onMenuDismiss?: () => void;
  /** M7.7-003B-002 (Bug2): 已提交编辑过的 block 集合 → native-canvas 下也渲染 overlay，让修改后的文本可见
   *  M7.7-004U: 升级为 line 级 —— 只重渲染已编辑的「行」，未编辑行保持 canvas 扫描原样 */
  editedLines?: ReadonlySet<string>;
  /** M7.7-004U: 已编辑行 → 真实文字覆盖盒（openTextEditSession 扫描 canvas 扩展），commit 后 mask 用 */
  editedLineBoxes?: Map<string, BBox>;
}

export function PDFCanvas({
  canvasRef,
  wrapperRef,
  dragRef,
  resizeRef,
  addBlock,
  handleOCRRegion,
  handleUpload,
  exitEditMode,
  enableClickToEdit = false,
  glyphCommands,
  docStyles = [],
  selectedGlyphIds,
  onGlyphClick,
  onSegmentCommit,
  onBlockTextCommit,
  onGlyphSelect,
  onGlyphEdit,
  onSelectionChanged,
  onDragSelectCommit,
  editingBlockId = null,
  editingLineBox = null,
  textEdit = null,
  onTextEditSave,
  onTextEditCancel,
  editSession = null,
  onKeyboardEdit,
  onPaste,
  onCaretChange,
  onTextInput,
  caretPosition = null,
  selectionHighlight,
  // M7.7-003: 拖选浮层 Action Menu
  selectionMenu = null,
  onMenuEditText,
  onMenuCopy,
  onMenuAskAI,
  onMenuDismiss,
  blockRotations,
  signatureRegionMap,
  signatureRegions = [],
  signatureTransformContexts,
  sceneReady = true,
  sceneReadyBase = true,
  // M7.7-003B-002 (Bug2): 已提交编辑过的 block → native-canvas 下也渲染 overlay，让改后文本可见
  // M7.7-004U: 升级为 line 级 —— 已编辑的「行」渲染 overlay，未编辑行保持 canvas 扫描原样
  editedLines,
  editedLineBoxes,
}: PDFCanvasProps) {
  const [canvasUploading, setCanvasUploading] = useState(false);
  // 记录 mousedown 起始位置，用于区分单击和拖拽（OCR 单击编辑）
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  const {
    pdfDoc,
    page,
    totalPages,
    setPage,
    addingType,
    setAddingType,
    ocrSelect,
    setOcrSelect,
    textItems,
    docBlocks,
    setDocBlocks,
    setSelectedBlockId,
    selectedBlockId,
    editingBlock,
    setEditingBlock,
    showTextLayer,
    highlightFormat,
    annoFormat,
    textFormat,
    setBlocks,
    // Commit 5: segments
    segments,
    editingSegmentId,
    setEditingSegmentId,
    handleSegmentChange,
  } = useEditor();
  const { t } = useI18n();

  // ── Sprint 24 Task 24.1: Layer Stack Audit ──
  useEffect(() => {
    const layers = ["pdf-canvas", "background", "glyph"];
    layers.forEach((layer) => {
      const el = document.querySelector(`[data-layer="${layer}"]`);
      if (el) {
        const style = getComputedStyle(el);
        console.log("[LayerAudit]", layer, {
          zIndex: style.zIndex,
          position: style.position,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          rect: el.getBoundingClientRect(),
        });
      } else {
        console.warn("[LayerAudit]", layer, "NOT FOUND in DOM");
      }
    });
  }, []);

  // [M7.8-002] TextGeometry adapter probe: 注册 EditableTextNode 的 source geometry（glyph-derived segment box）
  // seg.cssX/cssY/cssW/cssH 由 SegmentBuilder 从 glyph 的 pdfX/pdfY/pdfW/pdfH 经 mapper.pdfToCss 得出，
  // 即 EditableTextNode 消费的唯一几何来源。window.__m78002 比对 source(段框) vs editable(DOM rect)。
  useEffect(() => {
    const geoMap: Record<string, { x: number; y: number; w: number; h: number; baseline: number; fontSize: number; lineHeight: number }> = {};
    const fontMap: Record<string, { fontFamily: string; fontSize: number; fontWeight: number; fontStyle: string; letterSpacing: string; transform: string; lineHeight: number; color: string; rawFontName: string }> = {};
    for (const seg of segments) {
      geoMap[seg.id] = {
        x: seg.cssX,
        y: seg.cssY,
        w: seg.cssW,
        h: seg.cssH,
        baseline: seg.cssY + seg.cssH,
        fontSize: seg.font.size,
        lineHeight: seg.font.lineHeight,
      };
      // [M7.8-003] pdfFont source：来自 PDF glyph style（segment.font 由 FontAnalyzer 从 glyph 推导）。
      // fontStyle 由 rawFontName 含 Italic/Oblique 启发式推导（PDF TextContent 无显式 font-style 字段）；
      // letterSpacing PDF 无额外字距（自然 advance）→ "normal"；transform 段框丢弃 glyph 矩阵 → 恒等 "none"。
      const pdfFontStyle = /italic|oblique/i.test(seg.font.rawFontName) ? "italic" : "normal";
      fontMap[seg.id] = {
        fontFamily: seg.font.family,
        fontSize: seg.font.size,
        fontWeight: seg.font.weight,
        fontStyle: pdfFontStyle,
        letterSpacing: "normal",
        transform: "none",
        lineHeight: seg.font.lineHeight,
        color: seg.font.color,
        rawFontName: seg.font.rawFontName,
      };
    }
    (window as any).__etnGeo = geoMap;
    (window as any).__etnFont = fontMap;
  }, [segments]);

  // 过滤掉 seg_block_ 前缀的 block（它们是 segment 修改的镜像，只用于导出，不在画布上显示）
  const pageBlocks = docBlocks.filter((b) => b.page === page && !b.id.startsWith("seg_block_"));

  // M7.8-047 · C2 命中所需的辅助函数（仅本组件内使用，复用模块级 hitBlockByGlyphQuad）
  /** 由 block 构造 setEditingBlock 所需的编辑对象（保持 R8：编辑框宽度仍用 b.w，hit 与 box 分离） */
  const buildEditingBlock = (blk: TextBlock) => ({
    id: blk.id,
    text: blk.text || "",
    x: blk.x,
    y: blk.y,
    w: blk.w,
    h: blk.h,
    fontSize: blk.fontSize || Math.max(Math.min(blk.h * 0.65, blk.h - 6), 12),
    fontFamily: blk.fontFamily,
    color: blk.color,
  });

  /**
   * M7.8-047 (T2/T3/T4): 统一 EditingHitGeometry 入口。
   * 给定屏幕坐标 + 一个「已知文档原点与未缩放宽度」的参照元素（block div 或 pdf-canvas），
   * 换算到文档坐标（CSS 显示坐标，与 glyphCommands 同源），再用 C2 glyph quad 命中唯一归属 block；
   * 命中则 setEditingBlock（进入编辑），返回 true，否则返回 false（仅 selection / 不进编辑）。
   * scale = rect.width / coordEl.clientWidth（doc→screen 均匀缩放，涵盖 fit-width / browser zoom）。
   */
  const tryStartEditingAtClient = (
    clientX: number,
    clientY: number,
    coordEl: HTMLElement,
  ): boolean => {
    // 坐标换算：
    //   • 原点(origin) 用 canvas（= 文档真实原点）的 getBoundingClientRect().left/top，
    //     不能用 offsetParent(wrapper) 的 left/top —— 实测 wrapper 与 canvas 存在 ~1px 偏差，
    //     会让落在 glyph quad 边缘的 overflow 点被推到 quad 外 / 推入相邻 block，造成 mis-target / dead zone。
    //   • scale 用 offsetParent（全页定位祖先）：refRect.width / refClient
    //     （clientWidth 为未缩放文档宽，getBoundingClientRect().width 为缩放后屏幕宽）。
    // 两者组合得到精确的「全局文档坐标」，对 block div(T2) 与 pdf-canvas(T4) 两种入口均成立
    // （与 T1 pointFromEvent 同源思路：origin 用 canvas，scale 用 offsetParent）。
    const canvasEl = canvasRef.current;
    if (!canvasEl) return false;
    const canvasRect = canvasEl.getBoundingClientRect();
    const refEl = (coordEl.offsetParent as HTMLElement | null) ?? coordEl;
    const refRect = refEl.getBoundingClientRect();
    const refClient = refEl.clientWidth || refRect.width;
    if (refRect.width <= 0 || refClient <= 0) return false;
    const s = refRect.width / refClient; // 均匀缩放（fit-width / browser zoom）
    const docX = (clientX - canvasRect.left) / s;
    const docY = (clientY - canvasRect.top) / s;
    const hitId = hitBlockByGlyphQuad(glyphCommands, docX, docY);
    if (hitId) {
      const blk = pageBlocks.find((p) => p.id === hitId);
      if (blk && blk.type === "text") {
        setEditingBlock(buildEditingBlock(blk));
        return true;
      }
    }
    return false;
  };

  // Sprint 29: 将 DrawImageCommand 分离到 BackgroundPatchLayer
  const imageCommands: DrawImageCommand[] = glyphCommands?.filter(
    (cmd): cmd is DrawImageCommand => cmd.type === "drawImage"
  ) ?? [];
  const nonImageCommands: RenderCommand[] = glyphCommands?.filter(
    (cmd) => cmd.type !== "drawImage"
  ) ?? [];

  // M7.6-001: read-time feature flag → native-canvas（canvas 唯一视觉源）| legacy-glyph
  const viewMode = getViewRenderingMode();

  // ── Sprint 33 诊断：PDFCanvas GlyphRenderer 渲染条件 ──
  if (
    typeof window !== "undefined" &&
    (window as any).__diagnoseCanvas &&
    nonImageCommands.length === 0
  ) {
    console.log(
      "%c[PDFCanvas] GlyphRenderer NOT rendering%c — nonImageCmds=%d docStyles=%d enableClick=%s",
      "color:#ef4444;font-weight:bold;",
      "",
      nonImageCommands.length,
      docStyles.length,
      String(enableClickToEdit),
    );
  }

  return (
    <>
      <div style={{ display: "flex", gap: 0, justifyContent: "center", width: "100%" }}>
        <div
          data-layer="wrapper"
          ref={wrapperRef}
          onClick={(e) => {
            setSelectedBlockId(null);
            if (!addingType || addingType === "ocr" || !wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            setBlocks((prev) => [...prev, {
              id: uuid(), type: addingType, page,
              x: e.clientX - rect.left, y: e.clientY - rect.top,
              w: addingType === "image" ? 120 : 60,
              h: addingType === "image" ? 120 : 30,
              src: addingType === "image" ? "https://placehold.co/120x120" : undefined,
            } as Block]);
            setAddingType(null);
          }}
          onMouseDown={(e) => {
            if ((addingType !== "ocr" && addingType !== "highlight" && addingType !== "redact" && addingType !== "annotate") || !wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            const startX = Math.max(0, e.clientX - rect.left);
            const startY = Math.max(0, e.clientY - rect.top);
            setOcrSelect({ startX, startY, endX: startX, endY: startY });
          }}
          onMouseMove={(e) => {
            if (!ocrSelect || !wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            const maxW = wrapperRef.current.clientWidth;
            const maxH = wrapperRef.current.clientHeight;
            setOcrSelect((prev) => prev ? { ...prev, endX: Math.min(maxW, Math.max(0, e.clientX - rect.left)), endY: Math.min(maxH, Math.max(0, e.clientY - rect.top)) } : prev);
          }}
          onMouseUp={() => {
            if (!ocrSelect) return;
            const { startX, startY, endX, endY } = ocrSelect;
            const x = Math.min(startX, endX);
            const y = Math.min(startY, endY);
            const w = Math.abs(endX - startX);
            const h = Math.abs(endY - startY);
            setOcrSelect(null);
            if (addingType === "ocr") {
              setAddingType(null);
              handleOCRRegion(x, y, w, h);
            } else if (addingType === "highlight") {
              setAddingType(null);
              if (w > 10 && h > 10) {
                const selL = x, selR = x + w, selT = y, selB = y + h;
                const overlapping = textItems.filter((t) => {
                  const tl = t.x, tr = t.x + t.w, tt = t.y, tb = t.y + t.h;
                  return tl < selR && tr > selL && tt < selB && tb > selT;
                });
                if (overlapping.length > 0 && (highlightFormat.type === "underline" || highlightFormat.type === "strike" || highlightFormat.type === "wavy")) {
                  const midY = y + h / 2;
                  const onThisLine = overlapping.filter((t) => Math.abs(t.y + t.h / 2 - midY) < 10);
                  if (onThisLine.length > 0) {
                    const gx = Math.min(...onThisLine.map((i) => i.x));
                    const gy = Math.min(...onThisLine.map((i) => i.y));
                    const gx2 = Math.max(...onThisLine.map((i) => i.x + i.w));
                    const gy2 = Math.max(...onThisLine.map((i) => i.y + i.h));
                    addBlock("highlight", { x: gx, y: gy, w: gx2 - gx, h: gy2 - gy, hType: highlightFormat.type, color: highlightFormat.color, opacity: highlightFormat.opacity });
                  } else {
                    addBlock("highlight", { x, y, w, h, hType: highlightFormat.type, color: highlightFormat.color, opacity: highlightFormat.opacity });
                  }
                } else {
                  addBlock("highlight", { x, y, w, h, hType: highlightFormat.type, color: highlightFormat.color, opacity: highlightFormat.opacity });
                }
              }
            } else if (addingType === "redact") {
              setAddingType(null);
              if (w > 10 && h > 10) {
                addBlock("redact", { x, y, w, h });
              }
            } else if (addingType === "annotate") {
              setAddingType(null);
              if (w > 10 && h > 10) {
                addBlock("comment", { x, y, w, h, text: "Annotation", aType: annoFormat.aType, color: annoFormat.color });
              }
            }
          }}
          style={{
            position: "relative", background: "#fff", border: "1px solid #e2e8f0",
            borderRadius: 8, boxShadow: "0 1px 4px rgba(0,0,0,0.06)", overflow: "hidden",
            cursor: addingType ? "crosshair" : "default",
            aspectRatio: "210 / 297", maxWidth: 900, width: "100%",
          }}
        >
          {pdfDoc ? (
            <>
              {/* 1. PDF Canvas Layer（z0）
                  Sprint-109: sceneReady 前隐藏（visibility hidden），避免原文先露。
                  Sprint-126 Task-3 (PM): z0 底图改由 sceneReadyBase 控制（Physical 层独立 reveal）。
                  文本 PDF sceneReadyBase=true → 行为不变；扫描件 bitmapValid 即 z0 显示（Fallback=Bitmap Only）。 */}
              <div
                data-layer="pdf-canvas"
                className="pdf-canvas-layer"
                onClick={(e) => {
                  // M7.8-047 (T4): 统一 EditingHitGeometry 入口的兜底层。
                  // block div 仅在自身 bbox 内接收点击；overflow glyph / 块间隙的点击会穿透到本层，
                  // 此处用同一 C2 glyph quad 命中，消除死区（Case 4: block 9 / 11 overflow → 0 dead zone）。
                  // 命中 → 进入编辑；未命中（真实空白）→ 不动作（保持现有行为）。
                  if (enableClickToEdit) tryStartEditingAtClient(e.clientX, e.clientY, e.currentTarget as HTMLElement);
                }}
                style={{ position: "absolute", zIndex: RenderLayer.IMAGE, outline: viewMode === "native-canvas" ? "none" : "5px solid blue", visibility: sceneReadyBase ? "visible" : "hidden" }}
              >
                <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "auto" }} />
              </div>

              {/* 2. Background Patch Layer（z10: 在 canvas 之上、glyph 之下） */}
              <BackgroundPatchLayer images={imageCommands} />

              {/* 3. Glyph Layer（z30）
                  Sprint-109: sceneReady 前隐藏，与 z0 底图同帧 reveal（Atomic Swap），
                  消灭 "原文→编辑层" 中间态。 */}
              <div data-layer="background" className="pdf-glyph-layer" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: RenderLayer.GLYPH, transform: "translateZ(0)", pointerEvents: "none", outline: viewMode === "native-canvas" ? "none" : "5px solid green", visibility: sceneReady || (enableClickToEdit && nonImageCommands.length > 0) ? "visible" : "hidden" }}>
                {/* Sprint 6: GLYPH LAYER — Glyph 级渲染 + 交互（主显示层）
                    当 glyphCommands 非空时启用，成为主显示层。
                    支持点击选中、拖拽框选、双击编辑。
                    BLOCKS 保留作为 fallback（TextBlock 级渲染）。 */}
                {nonImageCommands.length > 0 && docStyles.length > 0 && (
                  /* Sprint-75：Mainline Mount — PDFCanvas 经 DispatcherGlyphLayer 接入 Dispatcher。
                     默认 Legacy → GlyphRenderer（零修改，Pixel 一致）；Feature Flag 可切 Painter。 */
                  <DispatcherGlyphLayer
                    commands={nonImageCommands}
                    styles={docStyles}
                    interactive={enableClickToEdit}
                    selectedGlyphIds={selectedGlyphIds}
                    editingBlockId={editingBlockId}
                    // M7.7-004 (Bug1): 编辑行 lineId → mask 裁剪到编辑行 bbox（不盖住同 block 其他行）
                    editingLineId={editSession?.target.lineId ?? null}
                    // M7.7-004C: 编辑行真实文字覆盖盒（扫描 canvas 扩展）→ mask 覆盖真实文字右缘
                    editingLineBox={editingLineBox}
                    blockRotations={blockRotations}
                    signatureRegionMap={signatureRegionMap}
                    signatureTransformContexts={signatureTransformContexts}
                    viewMode={viewMode}
                    editedLines={editedLines}
                    editedLineBoxes={editedLineBoxes}
                    onGlyphClick={(info) => onGlyphClick?.(info)}
                    onGlyphSelect={(info) => onGlyphSelect?.(info)}
                    onGlyphEdit={(glyph, newText) => onGlyphEdit?.(glyph, newText)}
                    onSelectionChanged={(derived) => onSelectionChanged?.(derived)}
                    onDragSelectCommit={(derived) => onDragSelectCommit?.(derived)}
                  />
                )}
                {/* M5-IMPLEMENT-003B-UI: Visual Caret（z40）— 编辑光标竖线，位置来自 glyph bbox。
                    M7.7-004B (Bug1): 编辑态（可见 textarea 已显示自身光标）隐藏 CaretLayer，
                    避免"编辑框内光标 + 框外蓝色竖线"双光标并存。 */}
                <CaretLayer position={textEdit ? null : caretPosition} />
                {/* M7.7-002/003: 编辑态 selection 高亮（z40）— 蓝色旋转四边形选区叠加在原 PDF 上 */}
                <SelectionHighlightLayer quads={selectionHighlight} />
                {/* M7.7-003: 拖选浮层 Action Menu（z60）— Edit Text / Copy / Ask AI（不弹 Workspace） */}
                <SelectionActionMenu
                  visible={!!selectionMenu}
                  x={selectionMenu?.x ?? 0}
                  y={selectionMenu?.y ?? 0}
                  text={selectionMenu?.text ?? ""}
                  onEditText={onMenuEditText ?? (() => {})}
                  onCopy={onMenuCopy ?? (() => {})}
                  onAskAI={onMenuAskAI ?? (() => {})}
                  onDismiss={onMenuDismiss ?? (() => {})}
                />
                {/* Sprint 32: Text Edit Overlay（z40） — 用户编辑文本的浮层
                    M5-003C-UI: 文本/键盘 truth 由 editSession 驱动（ADR-048） */}
                {textEdit && onTextEditSave && onTextEditCancel && editSession && onKeyboardEdit && onPaste && (
                  <TextEditOverlay
                    blockId={textEdit.blockId}
                    session={editSession}
                    bbox={textEdit.bbox}
                    transform={textEdit.transform}
                    fontSize={textEdit.fontSize}
                    fontFamily={textEdit.fontFamily}
                    pdfjsFontFamily={textEdit.pdfjsFontFamily}
                    fontWeight={textEdit.fontWeight}
                    lineHeight={textEdit.lineHeight}
                    onSave={onTextEditSave}
                    onCancel={onTextEditCancel}
                    onKeyboardEdit={onKeyboardEdit}
                    onPaste={onPaste}
                    onCaretChange={onCaretChange}
                    onTextInput={onTextInput}
                  />
                )}
                {/* SEGMENTS MASK LAYER — M7.8-014C: 遮挡底层 PDF canvas 原文
                    仅对已被 EditableTextNode 修改的 segment 渲染白色遮罩，
                    使 EditableTextNode 成为该 segment 的唯一显示源。 */}
                {segments.length > 0 && (
                  segments
                    .filter((seg) => seg.text !== seg.originalText)
                    .map((seg) => (
                      <div
                        key={`seg-mask-${seg.id}`}
                        data-layer="segment-mask"
                        data-segment-id={seg.id}
                        style={{
                          position: "absolute",
                          left: seg.cssX - 1,
                          // M7.8-014F: 用 cssBaseline 定位，遮罩需覆盖原文墨迹（顶在 baseline-cssAscent 附近）。
                          top: seg.cssBaseline - seg.cssH * 0.75,
                          width: seg.cssW + 2,
                          height: seg.cssH * 1.2,
                          background: "#fff",
                          pointerEvents: "none",
                          zIndex: 40,
                        }}
                      />
                    ))
                )}

                {/* SEGMENTS LAYER — Bug 11: 始终渲染 segments
                    - 浏览模式 (showTextLayer=false): 文字透明但可选，弹出 FloatingToolbar
                    - 编辑模式 (showTextLayer=true): 单击进入编辑，不弹 FloatingToolbar */}
                {segments.length > 0 && (
                  segments.map((seg) => (
                    <EditableTextNode
                      key={seg.id}
                      segment={seg}
                      isSelected={false}
                      isEditing={showTextLayer && editingSegmentId === seg.id}
                      allowEdit={showTextLayer}
                      onSelect={() => setEditingSegmentId(null)}
                      onStartEdit={(id: string) => {
                        if (showTextLayer) {
                          setEditingSegmentId(id);
                        }
                      }}
                      onChange={(id, newText) => {
                        // 1. 更新 segments state（即时视觉反馈）
                        handleSegmentChange(id, newText);
                        // Segment 自己的遮罩精确覆盖本段原文。不能再把它送进 line-level
                        // mask：EditableDocument 此刻尚未 mutation，line-level 路径会把整行
                        // 当作已变动，遮住同一行前面已提交段的下半部分。
                        // 2. 同步到 docBlocks 作为 text block（跨页保留 + exportPDF 导出修改后内容）
                        //    用固定 blockId 便于 upsert，避免重复添加
                        const blockId = `seg_block_${id}`;
                        setBlocks((prev) => {
                          const existingIdx = prev.findIndex((b) => b.id === blockId);
                          const newBlock = {
                            id: blockId,
                            type: "text" as const,
                            page,
                            x: seg.cssX,
                            y: seg.cssY,
                            w: seg.cssW,
                            h: seg.cssH,
                            text: newText,
                            fontSize: seg.font.size,
                            fontFamily: seg.font.family,
                            color: seg.font.color,
                          };
                          if (existingIdx >= 0) {
                            return prev.map((b, i) => (i === existingIdx ? { ...b, text: newText } : b));
                          }
                          return [...prev, newBlock];
                        });
                      }}
                      onEndEdit={() => setEditingSegmentId(null)}
                    />
                  ))
                )}

                {/* TEXT LAYER — 仅显示预览，单击打开 Portal 编辑（segments 为空时 fallback） */}
                {/* OCR 流程（enableClickToEdit）下不显示原文 text layer，避免与 OCR blocks 重复 */}
                {showTextLayer && textItems.length > 0 && segments.length === 0 && !enableClickToEdit && (
                  textItems.map((t) => {
                    const existing = docBlocks.find((b): b is TextBlock => b.type === "text" && Math.abs(b.x - t.x) < 3 && Math.abs(b.y - t.y) < 3);
                    const displayText = existing?.text || t.text;
                    return (
                      <div
                        key={t.id}
                        onClick={() => {
                          if (addingType === "annotate") {
                            const bid = uuid();
                            addBlock("comment", { id: bid, text: t.text, x: t.x, y: t.y, w: t.w, h: t.h, aType: annoFormat.aType, color: annoFormat.color, anchor: { textId: t.id, offset: 0, length: t.text.length } });
                            setAddingType(null);
                          }
                        }}
                        onDoubleClick={() => {
                          if (addingType === "annotate") return;
                          const bid = existing?.id || uuid();
                          setEditingBlock({ id: bid, text: displayText, x: t.x, y: t.y, w: t.w, h: t.h, fontSize: t.fontSize * 0.92, fontFamily: "'SimSun','Songti SC','Noto Serif CJK SC',serif", color: "#000000" });
                        }}
                        onMouseEnter={(e) => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.background = "rgba(59,130,246,0.08)"; }}
                        onMouseLeave={(e) => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.background = "transparent"; }}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          position: "absolute",
                          left: t.x, top: t.y, width: "auto", minWidth: t.w, height: t.h,
                          fontSize: t.fontSize * 0.92, lineHeight: 1.3,
                          fontFamily: "'SimSun','Songti SC','Noto Serif CJK SC',serif",
                          outline: "none", border: "none", whiteSpace: "nowrap", overflow: "visible",
                          pointerEvents: "auto", cursor: "text",
                          color: "transparent", background: "transparent",
                          borderRadius: 1, transition: "background 0.15s",
                        }}
                      >
                        {t.text}
                      </div>
                    );
                  })
                )}

                {/* BLOCKS — 文本块双击打开 Portal 编辑，其他类型双击删除 */}
                {pageBlocks.map((b) => {
                  // M7.6-IMPLEMENT-005: native-canvas 下 BLOCKS 文本覆盖层关闭视觉绘制（Native Canvas Invariant），
                  // 但保留块 div 作为不可见几何命中区（click/selection/AI 仍可用），与 GlyphRenderer 一致。
                  const nativeHideBlockVisual = viewMode === "native-canvas";
                  return (
                  <Fragment key={b.id}>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      // Selection：维持 block geometry 语义（现状不变，正交于此处的 editing 判定）
                      setSelectedBlockId(b.id);
                      // M7.8-047 (T2): Editing 改用 C2 glyph quad 命中（替代原 block bbox / C0）。
                      // 命中某 block 的 glyph quad → setEditingBlock(该 block)；否则仅 selection（block 空白/幽灵区）。
                      if (enableClickToEdit && b.type === "text") {
                        // 区分单击与拖拽（移动 > 5px 视为拖拽，不进编辑）
                        const isClick =
                          !clickStartRef.current ||
                          (Math.abs(e.clientX - clickStartRef.current.x) < 5 &&
                            Math.abs(e.clientY - clickStartRef.current.y) < 5);
                        if (isClick) {
                          // offsetParent 已是文档原点参照，做全局 C2 命中
                          tryStartEditingAtClient(e.clientX, e.clientY, e.currentTarget as HTMLElement);
                        }
                      }
                      clickStartRef.current = null;
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      clickStartRef.current = { x: e.clientX, y: e.clientY };
                      dragRef.current = { id: b.id, ox: e.clientX, oy: e.clientY, ox0: b.x, oy0: b.y };
                    }}
                    onDoubleClick={(e) => {
                      if (b.type === "text") {
                        e.stopPropagation();
                        // M7.8-047 (T3): 双击与单击使用完全相同的 C2 EditingHitGeometry 判定（不得出现单/双轨）。
                        tryStartEditingAtClient(e.clientX, e.clientY, e.currentTarget as HTMLElement);
                      } else {
                        setBlocks((prev) => prev.filter((x) => x.id !== b.id));
                      }
                    }}
                    style={{
                      position: "absolute", left: b.x, top: b.y, width: b.w,
                      // 文本块用 minHeight 让多行文本自动撑高，其他块固定 height
                      ...(b.type === "text" ? { minHeight: b.h } : { height: b.h }),
                      border: b.type === "highlight" && (b.hType === "underline" || b.hType === "strike" || b.hType === "wavy")
                        ? selectedBlockId === b.id ? "2px solid #8b5cf6" : "1px solid transparent"
                        : b.type === "highlight" ? `2px solid ${b.color || "#facc15"}`
                        : b.type === "redact" ? "2px solid #1e293b"
                        : b.type === "comment" ? "1px dashed #6366f1"
                        : b.type === "signature"
                        ? selectedBlockId === b.id ? "2px solid #8b5cf6" : "none"
                        : selectedBlockId === b.id ? "2px solid #8b5cf6" : "1px solid transparent",
                      borderRadius: 4,
                      cursor: b.type === "text" ? (enableClickToEdit ? "text" : "grab") : "move",
                      background: b.type === "highlight" && (b.hType === "underline" || b.hType === "strike" || b.hType === "wavy")
                        ? "transparent"
                        : b.type === "highlight" ? "rgba(250,204,21,0.25)"
                        : b.type === "comment" ? "rgba(99,102,241,0.06)"
                        // M7.6-IMPLEMENT-005: native-canvas 下文本块不绘白底（Native Canvas Invariant）
                        : b.type === "text" ? (nativeHideBlockVisual ? "transparent" : "#fff")
                        : "rgba(59,130,246,0.04)",
                      // 文本块：从顶部开始排列（不再垂直居中），让多行文字自然换行
                      display: "flex",
                      alignItems: b.type === "text" ? "flex-start" : "center",
                      justifyContent: b.type === "text" ? "flex-start" : "center",
                      // 文本块允许内容溢出显示（多行自动撑高），其他块裁剪
                      fontSize: 12, overflow: b.type === "text" ? "visible" : "hidden", pointerEvents: "auto",
                    }}
                  >
                    {b.type === "text" && !nativeHideBlockVisual && (
                      <span
                        data-block-text-visible="1"
                        style={{
                        width: "100%", minHeight: "100%", padding: 0,
                        // 替换模式：必须继承原始 fontSize，不能自动缩小字体塞进 bbox
                        fontSize: b.fontSize || Math.max(Math.min(b.h * 0.65, b.h - 6), 12),
                        lineHeight: 1.3,
                        fontFamily: b.fontFamily || "'Arial','Helvetica','SimSun','Noto Serif CJK SC',sans-serif",
                        background: "#fff",
                        // 修复：nowrap + visible 导致文字水平溢出叠到原文上
                        // 改为 pre-wrap（自动换行）+ visible（多行自动撑高 block）
                        whiteSpace: "pre-wrap",
                        overflow: "visible",
                        wordBreak: "break-word",
                        color: b.color || "#000000",
                      }}>
                        {b.text}
                      </span>
                    )}
                    {b.type === "image" && b.src && (
                      <img src={b.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 3 }} />
                    )}
                    {b.type === "signature" && b.dataUrl && (
                      <img src={b.dataUrl} alt="sig" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                    )}
                    {b.type === "highlight" && (() => {
                      const c = b.color || "#facc15";
                      const a = (b.opacity ?? 40) / 100;
                      const toRGBA = (hex: string, alpha: number) => {
                        const r = parseInt(hex.slice(1, 3), 16);
                        const g = parseInt(hex.slice(3, 5), 16);
                        const bl = parseInt(hex.slice(5, 7), 16);
                        return `rgba(${r},${g},${bl},${alpha})`;
                      };
                      const base = toRGBA(c, a);
                      const line = toRGBA(c, 0.9);
                      switch (b.hType) {
                        case "underline":
                          return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", bottom: "20%", left: 0, right: 0, height: 2, background: line }} /></div>;
                        case "strike":
                          return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: line }} /></div>;
                        case "wavy":
                          return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 6, background: `linear-gradient(45deg, ${line} 25%, transparent 25%, transparent 50%, ${line} 50%, ${line} 75%, transparent 75%, transparent)`, backgroundSize: "8px 8px" }} /></div>;
                        case "freehand":
                        case "text":
                        default:
                          return <div style={{ width: "100%", height: "100%", background: base, borderRadius: 2 }} />;
                      }
                    })()}
                    {b.type === "redact" && <div style={{ width: "100%", height: "100%", background: "#000" }} />}
                    {b.type === "comment" && (() => {
                      const at = b.aType || "note";
                      const cc = b.color || "#3b82f6";
                      const toRGB = (hex: string, a: number) => {
                        const r = parseInt(hex.slice(1, 3), 16);
                        const g = parseInt(hex.slice(3, 5), 16);
                        const bl = parseInt(hex.slice(5, 7), 16);
                        return `rgba(${r},${g},${bl},${a})`;
                      };
                      if (at === "highlight") return <div style={{ width: "100%", height: "100%", background: toRGB(cc, 0.3), borderRadius: 3 }} />;
                      if (at === "strike") return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: cc }} /></div>;
                      if (at === "underline") return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", bottom: "20%", left: 0, right: 0, height: 2, background: cc }} /></div>;
                      return <div style={{ width: "100%", height: "100%", padding: 6, fontSize: 12, color: cc, overflow: "hidden", display: "flex", alignItems: "flex-start", gap: 4 }}>📌 <span style={{ flex: 1 }}>{b.text}</span></div>;
                    })()}
                    {selectedBlockId === b.id && (
                      <div
                        onMouseDown={(e) => {
                          e.stopPropagation(); e.preventDefault();
                          resizeRef.current = { id: b.id, startX: e.clientX, startY: e.clientY, initW: b.w, initH: b.h };
                        }}
                        style={{
                          position: "absolute", right: -5, bottom: -5,
                          width: 12, height: 12, background: "#8b5cf6",
                          border: "2px solid #fff", borderRadius: 3,
                          cursor: "nwse-resize", pointerEvents: "auto", zIndex: 10,
                        }}
                      />
                    )}
                  </div>
                  </Fragment>
                  );
                })}

                {totalPages > 1 && (
                  <div style={{ position: "absolute", bottom: 12, left: 12, display: "flex", gap: 4, pointerEvents: "auto" }}>
                    <button onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ ...navBtn, opacity: page === 1 ? 0.4 : 1 }}>◀</button>
                    <span style={{ padding: "4px 12px", background: "rgba(0,0,0,0.55)", color: "#fff", borderRadius: 4, fontSize: 12 }}>{page}/{totalPages}</span>
                    <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} style={{ ...navBtn, opacity: page === totalPages ? 0.4 : 1 }}>▶</button>
                  </div>
                )}
              </div>

              {/* 3. Portal root（编辑框脱离 transform） */}
              <div id="edit-portal-root" />
            </>
          ) : (
            /* Bug 7: 没有文档加载时，画布中间显示上传组件 */
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", flexDirection: "column", gap: 16, padding: 40,
            }}>
              {/* BUG 9: 上传加载动画 */}
              {canvasUploading ? (
                <>
                  <div style={{
                    width: 48, height: 48,
                    border: "4px solid #e2e8f0",
                    borderTopColor: "#3b82f6",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }} />
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#3b82f6" }}>
                    Opening document...
                  </div>
                  <div style={{ fontSize: 13, color: "#94a3b8" }}>
                    Loading your PDF, please wait...
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 56, opacity: 0.3 }}>📄</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "#1e293b" }}>
                    {t("empty.uploadTitle")}
                  </div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>
                    {t("empty.uploadHint")}
                  </div>
                  <label
                    style={{
                      padding: "14px 32px",
                      background: "linear-gradient(135deg,#3b82f6,#6366f1)",
                      color: "#fff",
                      borderRadius: 10,
                      cursor: "pointer",
                      fontSize: 15,
                      fontWeight: 700,
                      boxShadow: "0 4px 16px rgba(59,130,246,0.35)",
                      transition: "transform 0.15s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.03)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
                  >
                    {/* BUG 9: 按钮文案改为 Open Document */}
                    Open Document
                    <input
                      type="file"
                      accept=".pdf"
                      onChange={(e) => {
                        if (e.target.files?.[0]) {
                          setCanvasUploading(true);
                          Promise.resolve(handleUpload(e)).finally(() => setCanvasUploading(false));
                        }
                      }}
                      style={{ display: "none" }}
                    />
                  </label>
                  {/* BUG 9: 隐私提示 */}
                  <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8, textAlign: "center", maxWidth: 400 }}>
                    🔒 Your files are processed securely and never shared. Files are automatically deleted after 24 hours unless you bind your Google account.
                  </div>
                </>
              )}
            </div>
          )}

          {ocrSelect && (() => {
            const x = Math.min(ocrSelect.startX, ocrSelect.endX);
            const y = Math.min(ocrSelect.startY, ocrSelect.endY);
            const w = Math.abs(ocrSelect.endX - ocrSelect.startX);
            const h = Math.abs(ocrSelect.endY - ocrSelect.startY);
            const mode = addingType === "highlight"
              ? { border: "#facc15", bg: "rgba(250,204,21,0.12)" }
              : addingType === "redact"
              ? { border: "#1e293b", bg: "rgba(30,41,59,0.15)" }
              : { border: "#8b5cf6", bg: "rgba(139,92,246,0.08)" };
            return <div style={{ position: "absolute", left: x, top: y, width: w, height: h, border: `2px dashed ${mode.border}`, background: mode.bg, pointerEvents: "none", zIndex: 999 }} />;
          })()}
        </div>

        {/* 右侧垂直分页条 */}
        {pdfDoc && totalPages > 1 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 36, flexShrink: 0, padding: "8px 0", alignSelf: "flex-start" }}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                width: 28, height: 28, borderRadius: 6, border: "1px solid #e2e8f0",
                background: page <= 1 ? "#f1f5f9" : "#fff",
                cursor: page <= 1 ? "not-allowed" : "pointer",
                fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0, opacity: page <= 1 ? 0.4 : 1, color: "#475569",
              }}
            >
              ▲
            </button>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#1e293b", writingMode: "vertical-lr", textOrientation: "mixed", letterSpacing: 4 }}>
              {page}/{totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                width: 28, height: 28, borderRadius: 6, border: "1px solid #e2e8f0",
                background: page >= totalPages ? "#f1f5f9" : "#fff",
                cursor: page >= totalPages ? "not-allowed" : "pointer",
                fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0, opacity: page >= totalPages ? 0.4 : 1, color: "#475569",
              }}
            >
              ▼
            </button>
          </div>
        )}
      </div>

      {editingBlock && document.getElementById("edit-portal-root") && createPortal(
        <div style={{
          position: "absolute",
          left: editingBlock.x - 1,
          top: editingBlock.y - 1,
          width: editingBlock.w,
          minHeight: editingBlock.h,
          background: "#fff",
          border: "1px solid #3b82f6",
          borderRadius: 4,
          padding: 0,
          boxSizing: "content-box",
          zIndex: 1000,
          overflow: "visible",
          pointerEvents: "auto",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        >
          <textarea
            autoFocus
            defaultValue={editingBlock.text}
            wrap="soft"
            style={{
              width: "100%",
              minHeight: editingBlock.h,
              fontSize: editingBlock.fontSize,
              lineHeight: 1.3,
              fontFamily: editingBlock.fontFamily || "'Arial','Helvetica','SimSun','Noto Serif CJK SC',sans-serif",
              color: editingBlock.color || "#000000",
              background: "transparent",
              border: "none",
              outline: "none",
              padding: 0,
              margin: 0,
              boxSizing: "border-box",
              resize: "none",
              overflow: "hidden",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
            onBlur={(e) => {
              const val = e.currentTarget.value;
              const ebId = editingBlock?.id;
              if (!ebId) return;
              setDocBlocks((prev) => {
                // 防御性过滤：docBlocks 不应含 null，但 drag handler / 命令历史等路径可能残留，
                // 这里兜底避免 b.id 读取 null 崩溃（与 PDFEditor drag handler 同源问题）。
                const safePrev = Array.isArray(prev) ? prev.filter(Boolean) : [];
                const existing = safePrev.find((b) => b.id === ebId);
                if (existing) return safePrev.map((b) => b.id === ebId ? { ...b, text: val, x: editingBlock!.x, y: editingBlock!.y, fontSize: editingBlock!.fontSize, fontFamily: editingBlock!.fontFamily, color: editingBlock!.color, w: editingBlock!.w, h: editingBlock!.h } as Block : b);
                return [...safePrev, { id: ebId, type: "text", page, x: editingBlock!.x, y: editingBlock!.y, w: editingBlock!.w, h: editingBlock!.h, text: val, fontSize: editingBlock!.fontSize, fontFamily: editingBlock!.fontFamily, color: editingBlock!.color }];
              });
              // OCR-EDIT-SYNC：同步回 EditableDocument（页面显示 + 导出的唯一信源）。
              // 仅 OCR 注入的段落块在 EditableDocument 中有同 id 的 block，其余（用户新增块）自然忽略。
              try {
                onBlockTextCommit?.(ebId, val);
              } catch (err) {
                console.warn("[OCR-EDIT-SYNC] block text commit failed:", err);
              }
              setEditingBlock(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
        </div>,
        document.getElementById("edit-portal-root")!
      )}
    </>
  );
}
