/**
 * F3B-6.3A — Layout Debug Registry
 *
 * 从 PDFEditor.tsx 抽离的 Sprint33 layout debug 簇（原 PDFEditor.tsx:3846-5947，
 * F3B-6.2 +16 行后为 3857-5956）。本轮为**逐字搬移**，未修改任何一行逻辑。
 *
 * 抽离依据（F3B-6.3A dependency inventory）：
 *   · 区域内 0 处 React state setter、0 处 ref 写入、0 处文档模型变更；
 *   · 0 处 setInterval / setTimeout / MutationObserver / addEventListener；
 *   · 仅有的 DOM 访问是 2 处只读 querySelector（仅在 API 被调用时执行）；
 *   · 唯一跨模块出向依赖：window.__overlayRuntimeDebugEnabled
 *     （被 EditableTextNode.tsx:41 以 === true 读取 → 必须保留名称与语义）；
 *   · 唯一跨模块入向依赖：window.__signatureRegionMap（区域外写入，此处只读）。
 *
 * 红线：本模块不得持有 Document Truth。所有文档数据均为**只读**注入。
 */

import { useEffect } from "react";
import type { MutableRefObject, RefObject } from "react";
import {
  buildLayoutDocument,
  calculateLineStability,
  calculateVisualRightBoundary,
  getPhraseScore,
  groupGlyphsIntoWords,
  joinWords,
  layoutDebugSummary,
  layoutDump,
} from "../../document-model";
import type { EditableDocument } from "../../document-model";
import type { SignatureRenderRegion } from "../../document-model/types";
import type { Segment } from "../../editor-engine/types";

/**
 * F3B-6.3A 显式依赖契约 —— 禁止把整个组件上下文对象传进来。
 *
 * 标记：
 *   PURE_DEBUG            仅用于诊断输出，无生产消费方
 *   OWNERSHIP_SENSITIVE   读取 EditableDocument / Segment 真相（只读）
 */
export interface LayoutDebugDependencies {
  /** PURE_DEBUG —— LayoutTree（只读；构建失败时为 null） */
  layoutDocument: ReturnType<typeof buildLayoutDocument> | null;
  /** OWNERSHIP_SENSITIVE —— EditableDocument 真相（只读） */
  editableDocumentRef: MutableRefObject<EditableDocument | null>;
  /** PURE_DEBUG —— CSS 缩放（只读） */
  cssScaleRef: MutableRefObject<number>;
  /** PURE_DEBUG —— 导出签名区域（只读） */
  signatureRegionsRef: MutableRefObject<SignatureRenderRegion[]>;
  /** PURE_DEBUG —— canvas 元素（只读） */
  canvasRef: RefObject<HTMLCanvasElement>;
  /** OWNERSHIP_SENSITIVE —— Segment[] 真相（只读） */
  segmentsRef: MutableRefObject<Segment[]>;
  /** PURE_DEBUG —— PDF textItems 快照（只读） */
  docTextItemsRef: MutableRefObject<any[]>;
  /** PURE_DEBUG —— 导出 mask 输入（只读） */
  editedLineBoxesRef: MutableRefObject<
    Map<string, { x: number; y: number; width: number; height: number }>
  >;
  /** PURE_DEBUG —— 签名区域映射（只读） */
  signatureRegionMap: any;
  /** OWNERSHIP_SENSITIVE —— Segment[] state（只读） */
  segments: Segment[];
  /** PURE_DEBUG —— 当前编辑 segment id */
  editingSegmentId: string | null;
  /** PURE_DEBUG —— 文本编辑 UI 状态 */
  textEdit: any;
}

/**
 * 注册 Sprint33 layout debug API 簇。
 *
 * Rules of Hooks：
 *   · 每次 render 无条件调用（调用方不得置于条件分支内）；
 *   · 依赖数组与抽离前保持一致：[layoutDocument]。
 *     注意：signatureRegionMap / segments / editingSegmentId / textEdit 在抽离前
 *     就未被列入依赖（存在陈旧闭包），本轮**刻意保留**该语义，不改变行为。
 *   · 注册与 cleanup 均在 hook 内部完成。
 */
export function useLayoutDebugRegistry(deps: LayoutDebugDependencies): void {
  const {
    layoutDocument,
    editableDocumentRef,
    cssScaleRef,
    signatureRegionsRef,
    canvasRef,
    segmentsRef,
    docTextItemsRef,
    editedLineBoxesRef,
    signatureRegionMap,
    segments,
    editingSegmentId,
    textEdit,
  } = deps;

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__layoutDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33] No layout document. Upload a PDF with OCR first.");
        return null;
      }
      const summary = layoutDebugSummary(layoutDocument);
      console.log("[Sprint33] Layout Debug:");
      for (const page of summary.pages) {
        console.log(`  Page: ${page.id}`);
        for (const node of page.topLevel) {
          console.log(
            `    ${node.type}: "${node.textPreview}"`,
            `| lines:${node.lineCount} words:${node.wordCount} glyphs:${node.glyphCount}`,
            `| rot:${node.rotation.toFixed(1)}°`,
          );
        }
      }
      // Also attach full tree for JSON inspection
      (window as any).__layoutTree = layoutDocument;
      return summary;
    };
    (window as any).__layoutDump = (maxDepth?: number, maxTextLen?: number) => {
      if (!layoutDocument) {
        console.warn("[Sprint33] No layout document. Upload a PDF with OCR first.");
        return;
      }
      const dump = layoutDump(layoutDocument, {
        maxDepth: maxDepth ?? 3,
        maxTextLen: maxTextLen ?? 72,
      });
      console.log(dump);
      return dump;
    };
    // Sprint 33.3.5 Task 1: Dump only signature nodes with rotation + children
    (window as any).__signatureLayoutDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.5] No layout document. Upload a PDF with OCR first.");
        return null;
      }
      console.group("%c[Sprint33.3.5] Signature Layout Debug", "font-weight:bold;color:#a855f7;");
      const results: any[] = [];
      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "signature") continue;
          const sigInfo: any = {
            id: topNode.id,
            type: topNode.type,
            bbox: topNode.bbox,
            rotation: topNode.transform.rotation,
            transform: topNode.transform,
            children: [],
          };
          for (const child of topNode.children) {
            const childInfo: any = {
              id: child.id,
              type: child.type,
              bbox: child.bbox,
              rotation: child.transform.rotation,
              sourceBlockId: child.sourceBlockId,
              grandChildren: child.children?.map((gc: any) => ({
                id: gc.id,
                type: gc.type,
                bbox: gc.bbox,
                sourceBlockId: gc.sourceBlockId,
              })) || [],
            };
            sigInfo.children.push(childInfo);
          }
          results.push(sigInfo);
          console.log(`%c${sigInfo.id}%c rot=${sigInfo.rotation.toFixed(1)}° bbox=(${sigInfo.bbox.x.toFixed(0)},${sigInfo.bbox.y.toFixed(0)} ${sigInfo.bbox.width.toFixed(0)}x${sigInfo.bbox.height.toFixed(0)})`,
            "font-weight:bold;color:#a855f7;", "color:#666;");
          for (const child of sigInfo.children) {
            const isLine = child.type === "signature_line";
            const label = isLine ? `  ${child.type}` : `  ${child.type}`;
            const extra = child.sourceBlockId ? ` blockId=${child.sourceBlockId}` : "";
            console.log(`    %c${label}%c rot=${child.rotation.toFixed(0)}° bbox=(${child.bbox.x.toFixed(0)},${child.bbox.y.toFixed(0)} ${child.bbox.width.toFixed(0)}x${child.bbox.height.toFixed(0)})${extra}${isLine ? " (synthesized line)" : ""}`,
              isLine ? "color:#94a3b8;" : "color:#cbd5e1;", "color:#666;");
          }
        }
      }
      if (results.length === 0) {
        console.log("  (no signature nodes found in layout tree)");
      }
      console.groupEnd();
      return results;
    };

    // Sprint 33.3.5.1: Dump transform chain from EditableDocument perspective.
    // Confirms that only the parent SIGNATURE block carries rotation,
    // and that child text blocks remain at rotation=0 (no double-rotation).
    (window as any).__editableTransformDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.5.1] No EditableDocument. Upload a PDF with OCR first.");
        return null;
      }
      if (!layoutDocument) {
        console.warn("[Sprint33.3.5.1] No LayoutDocument for cross-referencing signature nodes.");
        return null;
      }

      // Build a lookup: editableBlockId → signature node rotation from LayoutTree
      const sigBlockRotations = new Map<string, number>();
      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "signature") continue;
          const sigRot = topNode.transform.rotation;
          for (const child of topNode.children) {
            if (child.sourceBlockId) {
              sigBlockRotations.set(child.sourceBlockId, sigRot);
            }
          }
        }
      }

      console.group("%c[Sprint33.3.5.1] EditableDocument Transform Debug", "font-weight:bold;color:#22d3ee;");

      const allSigBlocks: any[] = [];

      for (let pi = 0; pi < doc.pages.length; pi++) {
        const page = doc.pages[pi];
        for (const block of page.blocks) {
          // Sprint 33.3.5.2: Identify signature blocks via LayoutTree sigBlockRotations
          // (no longer by block.transform.rotation, since child blocks now carry rotation=0)
          const isSig = block.regionType === "signature"
            || sigBlockRotations.has(block.id);

          if (!isSig) continue;

          const blockText = block.lines
            .map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
            .join(" ");

          const entry: any = {
            id: block.id,
            type: block.type,
            regionType: block.regionType,
            text: blockText.substring(0, 60),
            transform: block.transform || null,
            layoutSigRot: sigBlockRotations.get(block.id) ?? null,
            children: null as any[] | null,
            page: pi + 1,
          };

          // If this is a parent signature block with children, dump them
          if (block.children && block.children.length > 0) {
            entry.children = block.children.map((child: any) => ({
              id: child.id,
              type: child.type,
              regionType: child.regionType,
              text: child.lines
                ?.map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
                .join(" ") || "-",
              transform: child.transform || null,
            }));
          }

          allSigBlocks.push(entry);
        }
      }

      if (allSigBlocks.length === 0) {
        console.log("  (no signature blocks with transform found in EditableDocument)");
      } else {
        for (const b of allSigBlocks) {
          const rotStr = b.transform?.rotation != null
            ? `${b.transform.rotation.toFixed(1)}°`
            : "undefined";
          const layoutStr = b.layoutSigRot != null
            ? ` (layout: ${b.layoutSigRot.toFixed(1)}°)`
            : " (not in layout tree)";
          const hasChildren = b.children && b.children.length > 0;
          const isParent = b.type === "SIGNATURE" || b.regionType === "signature";

          console.log(
            `%c${isParent ? "SIGNATURE_BLOCK" : b.regionType || b.type}%c "${b.text}"%c rot=${rotStr}${layoutStr}${hasChildren ? ` children:${b.children.length}` : ""}`,
            "font-weight:bold;color:#22d3ee;",
            "color:#e2e8f0;",
            "color:#94a3b8;",
          );

          if (b.children) {
            for (const child of b.children) {
              const cRot = child.transform?.rotation ?? 0;
              const cRotStr = cRot !== 0 ? `${cRot.toFixed(1)}° ⚠️ DOUBLE-ROTATION!` : "0°";
              const cColor = cRot !== 0 ? "color:#ef4444;font-weight:bold;" : "color:#64748b;";
              console.log(`    %c├── "${child.text}"%c rotation:${cRotStr}`,
                "color:#cbd5e1;", cColor);
            }
          }

          if (!b.children && b.transform?.rotation) {
            // Block has transform but no children — it is a signature SUB-block
            const parentRot = b.layoutSigRot;
            if (parentRot != null && Math.abs(parentRot) > 0.01) {
              console.log(`    %c↳ parent rotation: ${parentRot.toFixed(1)}° (from LayoutTree SIGNATURE node)`,
                "color:#64748b;");
            }
          }
        }
      }

      console.groupEnd();
      return allSigBlocks;
    };

    // Sprint 33.3.5.2: Dump signature coordinate systems.
    // Shows world (absolute) ↔ local (relative to parent container) coordinates.
    // Parent uses left-top as transform-origin; children use local coords with rotation=0.
    (window as any).__signatureCoordinateDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.5.2] No EditableDocument. Upload a PDF with OCR first.");
        return null;
      }

      // Use signatureRegionMap (from layout tree) to identify which blocks belong
      // to signature regions. Child blocks now have rotation=0, so we can't detect
      // them by block.transform.rotation anymore (correctly!).
      const layoutMap: Map<string, { regionId: string; rotation: number }> | undefined =
        typeof window !== "undefined" ? (window as any).__signatureRegionMap : undefined;

      if (!layoutMap || layoutMap.size === 0) {
        console.warn("[Sprint33.3.5.2] No __signatureRegionMap. Try __signatureLayoutDebug() first.");
        return null;
      }

      // Build region groups from layoutMap
      const regionGroups: Map<string, { blocks: any[]; rotation: number }> = new Map();

      for (const page of doc.pages) {
        for (const block of page.blocks) {
          const ri = layoutMap.get(block.id);
          if (!ri) continue;
          if (!regionGroups.has(ri.regionId)) {
            regionGroups.set(ri.regionId, { blocks: [], rotation: ri.rotation });
          }
          regionGroups.get(ri.regionId)!.blocks.push(block);
        }
      }

      console.group(
        "%c[Sprint33.3.5.2] Signature Coordinate System Debug",
        "font-weight:bold;color:#f59e0b;",
      );
      let totalBlockCount = 0;
      regionGroups.forEach(g => { totalBlockCount += g.blocks.length; });
      console.log(`  %c${totalBlockCount} signature sub-blocks in ${regionGroups.size} region(s)`,
        "color:#94a3b8;");

      const allResults: any[] = [];

      for (const [regionId, group] of regionGroups) {
        const { blocks, rotation } = group;

        // Compute parent bbox (world coordinates) = union of all child bboxes
        const parentX = Math.min(...blocks.map(b => b.bbox.x));
        const parentY = Math.min(...blocks.map(b => b.bbox.y));
        const parentW = Math.max(...blocks.map(b => b.bbox.x + b.bbox.width)) - parentX;
        const parentH = Math.max(...blocks.map(b => b.bbox.y + b.bbox.height)) - parentY;

        console.group(
          `%cSIGNATURE_BLOCK %c${regionId}`,
          "font-weight:bold;color:#f59e0b;",
          "color:#94a3b8;",
        );
        console.log(`  bbox: %cx:${parentX.toFixed(1)} y:${parentY.toFixed(1)} w:${parentW.toFixed(1)} h:${parentH.toFixed(1)}`,
          "color:#64748b;");
        console.log(`  rotation: %c${rotation.toFixed(1)}°%c  origin: %cleft top (0 0)`,
          "color:#f59e0b;", "color:#94a3b8;", "color:#64748b;");
        console.log("  Children:");

        const children: any[] = [];
        for (const block of blocks) {
          const text = block.lines
            .map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
            .join(" ");
          const worldX = block.bbox.x;
          const worldY = block.bbox.y;
          const localX = worldX - parentX;
          const localY = worldY - parentY;
          const childRot = block.transform?.rotation ?? 0;

          children.push({
            text: text.substring(0, 50),
            id: block.id,
            world: { x: +worldX.toFixed(1), y: +worldY.toFixed(1) },
            local: { x: +localX.toFixed(1), y: +localY.toFixed(1) },
            rotation: childRot,
          });
        }

        // Sort children by localY (top to bottom) then localX (left to right)
        children.sort((a: any, b: any) => {
          const yDiff = a.local.y - b.local.y;
          if (Math.abs(yDiff) > 5) return yDiff;
          return a.local.x - b.local.x;
        });

        for (const child of children) {
          const rotIndicator = child.rotation !== 0
            ? `%c⚠️ rot=${child.rotation}°`
            : "%c✓ rotation:0";
          const rotColor = child.rotation !== 0
            ? "color:#ef4444;font-weight:bold;"
            : "color:#22c55e;";

          console.log(
            `    %c"${child.text}"%c`,
            "color:#e2e8f0;font-weight:bold;", "",
          );
          console.log(
            `      %cworld:%c (${child.world.x}, ${child.world.y})  %clocal:%c (${child.local.x}, ${child.local.y})`,
            "color:#64748b;", "color:#94a3b8;",
            "color:#64748b;", "color:#94a3b8;",
          );
          console.log(`      ${rotIndicator}`, rotColor);
        }

        allResults.push({
          regionId,
          bbox: { x: parentX, y: parentY, w: parentW, h: parentH },
          rotation,
          origin: "left top",
          children,
        });

        console.groupEnd();
      }

      // Summary: any DOUBLE-ROTATION detected?
      const doubleRotCount = allResults.reduce(
        (sum, r) => sum + r.children.filter((c: any) => c.rotation !== 0).length,
        0,
      );
      if (doubleRotCount > 0) {
        console.log(
          `%c⚠️ DOUBLE-ROTATION DETECTED: ${doubleRotCount} child block(s) have non-zero rotation!`,
          "color:#ef4444;font-weight:bold;font-size:1.1em;",
        );
      } else {
        console.log(
          "%c✅ All children at rotation=0. Only parent SIGNATURE_BLOCK carries rotation.",
          "color:#22c55e;font-weight:bold;",
        );
      }

      console.groupEnd();
      return allResults;
    };

    (window as any).__lineReconstructionDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.1] No layout document.");
        return null;
      }
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.1] No EditableDocument.");
        return null;
      }

      const results: Array<{
        paragraphId: string;
        originalOCRLines: string[];
        reconstructedLines: string[];
        decisions: Array<{ word: string; moved: boolean; reason: string }>;
      }> = [];

      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "paragraph") continue;
          if (topNode.children.length === 0) continue;

          const targetBlock = doc.pages[0]?.blocks.find(
            (b) => b.id === topNode.children[0]?.sourceBlockId,
          );
          const originalLines: string[] = [];
          if (targetBlock) {
            for (const line of targetBlock.lines) {
              originalLines.push(line.glyphs.map((g) => g.char).join(""));
            }
          }

          const reconstructedLines = topNode.children
            .filter((c: any) => c.type === "line")
            .map((l: any) => l.text ?? "");

          const decisions: Array<{ word: string; moved: boolean; reason: string }> = [];
          const origWords = originalLines.join(" ").split(" ");
          const reconWords = reconstructedLines.join(" ").split(" ");

          // 对比原行与重建行：找出 moved words
          for (let ri = 0; ri < reconstructedLines.length; ri++) {
            const rWords = reconstructedLines[ri].split(" ");
            const lastRWord = rWords[rWords.length - 1]?.toLowerCase();
            if (lastRWord && ["a", "de", "para"].includes(lastRWord)) {
              decisions.push({
                word: lastRWord,
                moved: false,
                reason: "natural_break_preposition",
              });
            }
          }

          results.push({
            paragraphId: topNode.id,
            originalOCRLines: originalLines,
            reconstructedLines,
            decisions: decisions.slice(0, 20),
          });
        }
      }

      if (results.length === 0) {
        console.warn("[Sprint33.3.1] No paragraph nodes found in layout document.");
        return null;
      }

      console.log(
        "%c── Line Reconstruction Debug ──",
        "font-weight:bold;font-size:14px;color:#8b5cf6;",
      );
      for (const r of results) {
        console.group(`Paragraph: ${r.paragraphId}`);
        console.log("%cOriginal OCR lines:", "color:#f59e0b;");
        for (const l of r.originalOCRLines) {
          console.log(`  "${l}"`);
        }
        console.log("%cReconstructed lines:", "color:#22c55e;");
        for (const l of r.reconstructedLines) {
          console.log(`  "${l}"`);
        }
        if (r.decisions.length > 0) {
          console.log("%cDecisions:", "color:#8b5cf6;");
          console.table(r.decisions);
        }
        console.groupEnd();
      }
      return results;
    };

    // ── Sprint34.4.2: __ocrLineDebug() 数据确认 ──
    // 目标：确认 OCR 数据结构能力，判断能否做 Adobe 级换行恢复。
    // 输出：OCR 原始 lines（text+bbox） + 每行 word 级信息 + 三个问题的回答。
    (window as any).__ocrLineDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.4.2] No EditableDocument.");
        return null;
      }
      const page = doc.pages[0];
      if (!page) {
        console.warn("[Sprint34.4.2] No page.");
        return null;
      }

      console.log(
        "%c── OCR Line / Word Coordinate Inspection ──",
        "font-weight:bold;font-size:14px;color:#0ea5e9;",
      );

      // 按空格对 glyph 分组推导 word bbox（与 line-reconstruction.ts 的 word 推导一致）
      const wordsFromGlyphs = (glyphs: any[]) => {
        const words: Array<{ text: string; bbox: { x: number; y: number; width: number; height: number } }> = [];
        let current: any[] = [];
        const flush = () => {
          if (current.length === 0) return;
          const xs = current.map((g) => g.bbox.x);
          const ys = current.map((g) => g.bbox.y);
          const rights = current.map((g) => g.bbox.x + g.bbox.width);
          const bottoms = current.map((g) => g.bbox.y + g.bbox.height);
          words.push({
            text: current.map((g) => g.char).join(""),
            bbox: {
              x: Math.min(...xs),
              y: Math.min(...ys),
              width: Math.max(...rights) - Math.min(...xs),
              height: Math.max(...bottoms) - Math.min(...ys),
            },
          });
          current = [];
        };
        for (const g of glyphs) {
          if (g.char === " ") {
            flush();
          } else {
            current.push(g);
          }
        }
        flush();
        return words;
      };

      const blockCount = page.blocks.length;
      let totalLines = 0;
      let lineHasBbox = true;
      let anyWordBbox = false;

      for (let bi = 0; bi < page.blocks.length; bi++) {
        const block = page.blocks[bi];
        // EditableBlock/EditableLine 无 text 字段，需从 glyph 拼接
        const blockText = block.lines
          .map((l) => l.glyphs.map((g) => g.char).join(""))
          .join("\n");
        totalLines += block.lines.length;
        for (const line of block.lines) {
          const b = line.bbox;
          if (!b || (b.x === 0 && b.y === 0 && b.width === 0 && b.height === 0)) {
            lineHasBbox = false;
          }
          const words = wordsFromGlyphs(line.glyphs);
          if (words.length > 0) anyWordBbox = true;

          console.group(
            `Block ${bi} "${blockText.substring(0, 40)}" regionType=${block.regionType ?? "?"} layoutMode=${block.layoutMode ?? "?"} lines=${block.lines.length}`,
          );
          console.log(`  line: "${line.glyphs.map((g) => g.char).join("")}"`);
          console.log(
            `  bbox: x=${b?.x} y=${b?.y} w=${b?.width} h=${b?.height} (${block.lines.length === 1 ? "单行段落" : "多行段落"})`,
          );
          console.log(`  glyphs: ${line.glyphs.length}`);
          if (words.length > 0) {
            console.table(
              words.map((w, i) => ({
                word: w.text,
                x: Math.round(w.bbox.x),
                y: Math.round(w.bbox.y),
                w: Math.round(w.bbox.width),
                h: Math.round(w.bbox.height),
              })),
            );
          }
          console.groupEnd();
        }
      }

      // ── 三个问题的结论 ──
      console.log(
        "%c── 结论（用于判断 Adobe 级换行恢复能力）──",
        "font-weight:bold;color:#f59e0b;",
      );
      console.log(`[问题1] 两行来自哪里？`);
      console.log(
        `  → 当前 line 边界来自 OcrTextBlock.text 的 split("\\n")（OCR 文本换行符）。` +
          `实测本页 blocks=${blockCount}，lines 总计=${totalLines}。` +
          `单行段落（OCR 未提供换行）会合并为 1 行。`,
      );
      console.log(`[问题2] GLM OCR 有没有 word bbox？`);
      console.log(
        `  → OcrTextBlock 原始类型【无】word 字段（仅 block 级 bbox + text + fontSize + label）。` +
          `word bbox 是我们从 glyph 坐标按空格分组【自己推导】的（上面的 word 表格即为推导结果）。` +
          `lineHasBbox=${lineHasBbox}，word 可推导=${anyWordBbox}。`,
      );
      console.log(`[问题3] LayoutTree 保存 line.text 还是 line.words[]？`);
      console.log(
        `  → LayoutTree 的 line 节点保存【line.text】+ 子 glyph 节点；` +
          `word 是渲染/编辑时由 buildWordNodes 临时分组，不持久化在 LayoutNode 上。`,
      );
      return {
        blockCount,
        totalLines,
        lineHasBbox,
        anyWordBbox,
        verdict: "OCR 无 word bbox，word 级需自行从 glyph 推导；line 边界仅依赖 OCR text 换行符",
      };
    };

    // Sprint 33.3.1: Candidate scoring debug
    (window as any).__lineReconstructionScoreDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.1] No layout document.");
        return null;
      }
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.1] No EditableDocument.");
        return null;
      }

      const debugEntries: Array<{
        paragraphId: string;
        visualRight: number;
        originalOCRLines: string[];
        reconstructedLines: string[];
      }> = [];

      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "paragraph") continue;
          if (topNode.children.length === 0) continue;

          const targetBlock = doc.pages[0]?.blocks.find(
            (b) => b.id === topNode.children[0]?.sourceBlockId,
          );

          const originalLines: string[] = [];
          const allGlyphs: any[] = [];
          if (targetBlock) {
            for (const line of targetBlock.lines) {
              originalLines.push(line.glyphs.map((g: any) => g.char).join(""));
              for (const g of line.glyphs) allGlyphs.push(g);
            }
          }

          const reconstructedLines = topNode.children
            .filter((c: any) => c.type === "line")
            .map((l: any) => l.text ?? "");

          // Import 和计算 visualRight
          const words = groupGlyphsIntoWords(allGlyphs);
          const visualRight = calculateVisualRightBoundary(words);

          debugEntries.push({
            paragraphId: topNode.id,
            visualRight: Math.round(visualRight * 100) / 100,
            originalOCRLines: originalLines,
            reconstructedLines,
          });
        }
      }

      if (debugEntries.length === 0) {
        console.warn("[Sprint33.3.1] No paragraph nodes found.");
        return null;
      }

      console.log(
        "%c── Candidate Score Debug ──",
        "font-weight:bold;font-size:14px;color:#a78bfa;",
      );
      for (const entry of debugEntries) {
        console.group(`Paragraph: ${entry.paragraphId}`);
        console.log("%cVisual Right Boundary: %c" + entry.visualRight + "px",
          "color:#ec4899;", "font-weight:bold;");
        console.log("%cOriginal OCR lines:", "color:#f59e0b;");
        for (const l of entry.originalOCRLines) {
          console.log(`  "${l}"`);
        }
        console.log("%cReconstructed lines:", "color:#22c55e;");
        for (let li = 0; li < entry.reconstructedLines.length; li++) {
          const prefix = li === entry.reconstructedLines.length - 1 ? "  └ " : "  ├ ";
          console.log(`${prefix}"${entry.reconstructedLines[li]}"`);
        }
        console.groupEnd();
      }

      return debugEntries;
    };

    // ── Sprint 33.3.2: Line Stability Debug ─────────────────────

    (window as any).__lineStabilityDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.2] No layout document.");
        return [];
      }
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.2] No EditableDocument.");
        return [];
      }

      const result: Array<{
        paragraphId: string;
        candidates: Array<{
          lines: string[];
          score: number;
        }>;
        selected: number;
      }> = [];

      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "paragraph") continue;
          if (topNode.children.length <= 1) continue; // need at least 2 lines

          const targetBlock = doc.pages[0]?.blocks.find(
            (b: any) => b.id === topNode.children[0]?.sourceBlockId,
          );
          if (!targetBlock) continue;

          // Collect all glyphs from the block's OCR lines
          const allGlyphs: any[] = [];
          for (const line of targetBlock.lines) {
            for (const g of line.glyphs) allGlyphs.push(g);
          }
          if (allGlyphs.length === 0) continue;

          const words = groupGlyphsIntoWords(allGlyphs);
          const visualRight = calculateVisualRightBoundary(words);

          // Current arrangement from layout tree
          const layoutLines = topNode.children.filter((c: any) => c.type === "line");
          const currentLines: any[][] = [];
          const currentTexts: string[] = [];
          for (const ll of layoutLines) {
            // line node 上没有 words 属性，从 children (word nodes) 重建 OCRWord[]
            const wordNodes = (ll.children ?? []).filter((c: any) => c.type === "word");
            if (wordNodes.length === 0) continue;
            const wordsArr: any[] = wordNodes.map((wn: any) => ({
              text: wn.text ?? "",
              bbox: wn.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
              glyphs: [],
            }));
            currentLines.push(wordsArr);
            currentTexts.push(ll.text ?? "");
          }
          if (currentLines.length <= 1) continue;

          const entry: typeof result[0] = {
            paragraphId: topNode.id,
            candidates: [],
            selected: 0,
          };

          // Candidate 0: current arrangement
          const currentScore = calculateLineStability(currentLines, visualRight);
          entry.candidates.push({
            lines: currentTexts,
            score: currentScore,
          });

          // Candidate 1: merge short lines where applicable
          const mergedLines: any[][] = [];
          const mergedTexts: string[] = [];
          let i = 0;
          let didMerge = false;
          while (i < currentLines.length) {
            if (
              i < currentLines.length - 1 &&
              currentLines[i + 1].length === 1
            ) {
              const cohesionScore = getPhraseScore(currentLines[i], currentLines[i + 1][0]);
              if (cohesionScore >= 0) {
                mergedLines.push([...currentLines[i], ...currentLines[i + 1]]);
                mergedTexts.push(joinWords(
                  [...currentLines[i], ...currentLines[i + 1]],
                ));
                i += 2;
                didMerge = true;
                continue;
              }
            }
            mergedLines.push(currentLines[i]);
            mergedTexts.push(layoutLines[i]?.text ?? "");
            i++;
          }

          if (didMerge && mergedLines.length !== currentLines.length) {
            const mergedScore = calculateLineStability(mergedLines, visualRight);
            entry.candidates.push({
              lines: mergedTexts,
              score: mergedScore,
            });
            if (mergedScore > currentScore) {
              entry.selected = 1;
            }
          }

          result.push(entry);
        }
      }

      console.log(
        "%c── Line Stability Debug (S33.3.2) ──",
        "font-weight:bold;font-size:14px;color:#22d3ee;",
      );
      console.log("%cWeights: width(0.35) + phrase(0.35) + balance(0.20) + originalOCR(0.10)",
        "color:#94a3b8;");
      for (const e of result) {
        console.group(`Paragraph: ${e.paragraphId}`);
        for (let ci = 0; ci < e.candidates.length; ci++) {
          const c = e.candidates[ci];
          const marker = ci === e.selected ? " >>> SELECTED" : "";
          console.log(
            `%cCandidate ${ci}: score=%c${c.score}%c${marker}`,
            ci === e.selected ? "font-weight:bold;color:#22c55e;" : "color:#94a3b8;",
            "font-weight:bold;",
            ci === e.selected ? "color:#22c55e;font-weight:bold;" : "color:#94a3b8;",
          );
          for (let li = 0; li < c.lines.length; li++) {
            console.log(`  "${c.lines[li]}"`);
          }
        }
        console.groupEnd();
      }

      return result;
    };

    // ── Sprint 33.3.3 Task 1: Text Metric Debug ──
    (window as any).__textMetricDebug = () => {
      if (!editableDocumentRef.current) {
        console.warn("[Sprint33.3.3] No EditableDocument.");
        return [];
      }
      const doc = editableDocumentRef.current;
      const cssScale = cssScaleRef.current;
      const renderScale = 1.5;
      const metrics: any[] = [];

      // EditableDocument: pages → blocks (no doc.blocks)
      for (const page of doc.pages) {
        for (const block of page.blocks) {
          // Reconstruct text from glyphs across all lines
          const blockText = block.lines
            .map((l) => l.glyphs.map((g) => g.char).join(""))
            .join(" ");
          // Style: first line's style → fontSize; fallback to first glyph's styleRef → doc.styles
          const firstLine = block.lines[0];
          const firstGlyphStyleRef = firstLine?.glyphs[0]?.styleRef ?? -1;
          const docStyleEntry = firstGlyphStyleRef >= 0 ? doc.styles[firstGlyphStyleRef] : null;
          const overlayFontSize = firstLine?.style?.fontSize
            ?? docStyleEntry?.fontSize
            ?? 14;
          // Back-calculate OCR fontSize: overlayFontSize / cssScale → canvas px at scale=1.5
          const ocrCanvasFontSize = cssScale > 0 ? overlayFontSize / cssScale : overlayFontSize;
          // Back-calculate PDF pt equivalent
          const pdfFontSizePt = ocrCanvasFontSize / renderScale;

          metrics.push({
            id: block.id,
            text: blockText.substring(0, 60),
            bbox: { ...block.bbox },
            coordinateSpace: "css-px",
            ocrCanvasFontSize,
            overlayFontSize,       // fontSize actually used by GlyphRenderer (CSS px)
            pdfFontSizePt,         // approximate PDF pt equivalent
            scale: { renderScale, cssScale },
            blockStyle: firstLine?.style ?? docStyleEntry ?? null,
            lines: block.lines.length,
            glyphs: block.lines.reduce((sum, l) => sum + l.glyphs.length, 0),
            regionType: block.regionType,
          });
        }
      }
      if (metrics.length === 0) {
        console.warn("[Sprint33.3.3] No blocks found in document.");
        return [];
      }
      console.table(metrics.map(m => ({
        id: m.id,
        fontSize_css: m.overlayFontSize,
        fontSize_pdfPt: m.pdfFontSizePt.toFixed(1),
        bbox_w: m.bbox.width.toFixed(1),
        bbox_h: m.bbox.height.toFixed(1),
        lines: m.lines,
        glyphs: m.glyphs,
        regionType: m.regionType ?? "-",
        text: m.text,
      })));
      return metrics;
    };

    // ── Sprint 33.5.6: Signature Export Debug ──
    // Verifies that the export's coordinate rotation matches the expected mathematical rotation.
    //
    // Previous version compared raw source vs rotated export → always showed large deltas
    // because rotation naturally shifts positions (e.g. 1125pt × sin(1.3°) ≈ 25pt).
    //
    // Fix: compare rot(source) — the mathematically expected rotated position — vs export.
    // delta = |exportPos - rotatePoint(sourcePos, origin, rotation)|
    // This measures coordinate conversion accuracy, independent of the rotation effect.
    (window as any).__signatureExportDebug = () => {
      const regions = signatureRegionsRef.current;
      if (!regions || regions.length === 0) {
        console.warn("[Sprint 33.5.6] No SignatureRegions. Process a PDF with OCR and signature detection first.");
        return null;
      }

      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint 33.5.6] No EditableDocument.");
        return null;
      }

      const renderScale = 1.5;
      const cssScale = cssScaleRef.current;
      const totalScale = renderScale * cssScale;

      console.group(
        "%c[Sprint 33.5.6] Signature Export Coordinate Debug",
        "font-weight:bold;color:#f59e0b;",
      );

      const allResults: any[] = [];
      let totalCoordDelta = 0;
      let maxCoordDelta = 0;
      let totalRotationShift = 0;
      let maxRotationShift = 0;

      for (const region of regions) {
        const page = doc.pages[region.pageIndex];
        if (!page) continue;
        const pageHeightPt = page.height / totalScale;

        // Origin in PDF pt (block's own top-left — per-block region)
        const originPtX = region.bbox.x / totalScale;
        const originPtY = pageHeightPt - (region.bbox.y / totalScale);

        const rad = (region.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const children: any[] = [];

        for (const child of region.children) {
          const block = page.blocks.find(b => b.id === child.sourceBlockId);
          if (!block) continue;

          // Source in PDF pt (top-left of block, pre-rotation)
          const srcPtX = block.bbox.x / totalScale;
          const srcPtY = pageHeightPt - (block.bbox.y / totalScale);

          // Local offset in PDF pt
          const localPtX = child.offsetX / totalScale;
          const localPtY = -child.offsetY / totalScale;

          // 1. Export position — what renderSignatureRegionToExportCommands produces
          const exportPtX = originPtX + localPtX * cos - localPtY * sin;
          const exportPtY = originPtY + localPtX * sin + localPtY * cos;

          // 2. Expected = rotate(sourcePt around origin) — the mathematically expected result
          const dx = srcPtX - originPtX;
          const dy = srcPtY - originPtY;
          const expectedX = originPtX + dx * cos - dy * sin;
          const expectedY = originPtY + dx * sin + dy * cos;

          // 3. Coordinate conversion delta = export vs expected
          const coordDeltaX = exportPtX - expectedX;
          const coordDeltaY = exportPtY - expectedY;
          const coordDelta = Math.sqrt(coordDeltaX * coordDeltaX + coordDeltaY * coordDeltaY);

          // 4. Rotation shift = source vs rotated (information only)
          const rotShiftX = exportPtX - srcPtX;
          const rotShiftY = exportPtY - srcPtY;
          const rotShift = Math.sqrt(rotShiftX * rotShiftX + rotShiftY * rotShiftY);

          totalCoordDelta += coordDelta;
          maxCoordDelta = Math.max(maxCoordDelta, coordDelta);
          totalRotationShift += rotShift;
          maxRotationShift = Math.max(maxRotationShift, rotShift);

          children.push({
            text: child.text.substring(0, 40),
            source: { x: +srcPtX.toFixed(2), y: +srcPtY.toFixed(2) },
            expected: { x: +expectedX.toFixed(2), y: +expectedY.toFixed(2) },
            exportPos: { x: +exportPtX.toFixed(2), y: +exportPtY.toFixed(2) },
            coordDelta: +coordDelta.toFixed(3),
            rotShift: +rotShift.toFixed(3),
          });
        }

        const regionResult = { regionId: region.id, rotation: region.rotation, children };
        allResults.push(regionResult);

        console.group(
          `%cSIGNATURE EXPORT %c${region.id}`,
          "font-weight:bold;color:#f59e0b;", "color:#94a3b8;",
        );
        console.log(`  %crotation:%c ${region.rotation.toFixed(1)}° %corigin:%c (${originPtX.toFixed(1)}, ${originPtY.toFixed(1)}) pt`,
          "color:#f59e0b;", "color:#e2e8f0;", "color:#64748b;", "color:#94a3b8;");

        for (const child of children) {
          const cdOk = child.coordDelta < 0.5;
          const coordStr = cdOk
            ? `%c✓ coord Δ:${child.coordDelta}`
            : `%c⚠️ coord Δ:${child.coordDelta}`;
          const cdColor = cdOk ? "color:#22c55e;" : "color:#ef4444;font-weight:bold;";
          const rotStr = child.rotShift < 0.5
            ? " (rot shift negligible)"
            : ` (rot shift: ${child.rotShift.toFixed(1)})`;

          console.log(
            `    %c"${child.text}"%c${rotStr}`,
            "color:#cbd5e1;", "color:#64748b;",
          );
          console.log(
            `      %csource:%c (${child.source.x}, ${child.source.y})  %cexpected:%c (${child.expected.x}, ${child.expected.y})  %cexport:%c (${child.exportPos.x}, ${child.exportPos.y})  ${coordStr}`,
            "color:#64748b;", "color:#94a3b8;",
            "color:#64748b;", "color:#f59e0b;",
            "color:#64748b;", "color:#94a3b8;",
            cdColor,
          );
        }

        console.groupEnd();
      }

      const childCount = allResults.reduce((s: number, r: any) => s + r.children.length, 0);
      const avgCoordDelta = childCount > 0 ? totalCoordDelta / childCount : 0;
      const avgRotShift = childCount > 0 ? totalRotationShift / childCount : 0;

      console.log("%c── Summary ──", "color:#94a3b8;");
      console.log(`  coord Δ (export vs expected): avg ${avgCoordDelta.toFixed(3)} pt  max ${maxCoordDelta.toFixed(3)} pt`);
      console.log(`  rot shift (source vs export):  avg ${avgRotShift.toFixed(3)} pt  max ${maxRotationShift.toFixed(3)} pt`);
      if (avgCoordDelta < 0.5 && maxCoordDelta < 1) {
        console.log("  %c✅ Export coordinate conversion EXACT. Per-block origin → zero drift.", "color:#22c55e;font-weight:bold;");
      } else {
        console.log("  %c⚠️ Coordinate conversion drift detected in export path.", "color:#ef4444;font-weight:bold;");
      }
      if (avgRotShift < 0.5) {
        console.log("  %c✅ Per-block rotation has negligible position shift (≤ 0.5 pt).", "color:#22c55e;");
      } else {
        console.log("  %c⚠️ Rotation shift > 0.5 pt — block origin is far from text position.", "color:#ef4444;");
      }

      console.groupEnd();
      return { regions: allResults, avgCoordDelta, maxCoordDelta, avgRotShift, maxRotationShift };
    };

    // ── Sprint34.11: Signature Region Export Isolation Debug ──
    // 只读诊断：对比 Editor signature map 与 Export signatureRegionsRef，
    // 确认 Export signature region 是否错误包含日期 block（TABOAO）。
    (window as any).__signatureRegionIsolationDebug = () => {
      console.log(
        "%cCODE_VERSION: SPRINT34.11.1 (sigRegions now built from reconResult.replacements)",
        "font-weight:bold;color:#ef4444;",
      );
      const doc = editableDocumentRef.current;
      const blockText = (blockId: string): string => {
        if (!doc) return "(no doc)";
        for (const page of doc.pages) {
          for (const b of page.blocks) {
            if (b.id === blockId) {
              return b.lines.map((l) => l.glyphs.map((g) => g.char).join("")).join("\\n").substring(0, 40);
            }
          }
        }
        return "(not found)";
      };

      // ── 1. Editor signature map ──
      console.log(
        "%c── [EDITOR_SIGNATURE_REGION] ──",
        "font-weight:bold;color:#22c55e;",
      );
      const editorBlocks: Array<{ id: string; text: string }> = [];
      for (const [blockId, v] of signatureRegionMap.entries()) {
        editorBlocks.push({ id: blockId, text: blockText(blockId) });
        console.log(
          `  block ${blockId.slice(0, 8)} rotation=${(v as any).rotation} text="${blockText(blockId)}"`,
        );
      }

      // ── 2. Export signatureRegionsRef ──
      console.log(
        "%c── [EXPORT_SIGNATURE_REGION] ──",
        "font-weight:bold;color:#f59e0b;",
      );
      const exportBlocks: Array<{ id: string; text: string }> = [];
      const regions = signatureRegionsRef.current ?? [];
      for (const r of regions as any[]) {
        const src = r.sourceBlockIds?.[0] ?? "(none)";
        console.log(
          `  region ${r.id} rotation=${r.rotation} sourceBlockIds=[${(r.sourceBlockIds ?? []).map((s: string) => s.slice(0, 8)).join(",")}]`,
        );
        for (const c of (r.children ?? []) as any[]) {
          const bid = c.blockId ?? c.sourceBlockId ?? src;
          exportBlocks.push({ id: bid, text: (c.text ?? "").substring(0, 40) });
          console.log(`    child blockId=${bid.slice(0, 8)} text="${(c.text ?? "").substring(0, 40)}"`);
        }
      }

      // ── 3. 差异对比 ──
      console.log(
        "%c── [SIGNATURE_REGION_DIFF] ──",
        "font-weight:bold;color:#8b5cf6;",
      );
      const editorTexts = new Set(editorBlocks.map((b) => b.text));
      const exportTexts = new Set(exportBlocks.map((b) => b.text));
      const editorOnly = editorBlocks.filter((b) => !exportTexts.has(b.text)).map((b) => b.text);
      const exportOnly = exportBlocks.filter((b) => !editorTexts.has(b.text)).map((b) => b.text);
      console.log("  Editor only:", editorOnly);
      console.log("  Export only:", exportOnly);
      console.log(
        "  ➡️ Export 是否包含 TABOAO/日期：",
        exportOnly.some((t) => /TABOAO|abril|2026/.test(t)) ? "✅ 是（根因确认）" : "❌ 否",
      );

      return { editorBlocks, exportBlocks, editorOnly, exportOnly };
    };

    // ── Sprint 33.5.8: Overlay Transform Debug ──
    // Checks the full coordinate scaling chain:
    //   PDF pt → (* renderScale) → canvas px → (* cssScale) → CSS display px
    // The GlyphRenderer uses CSS px for position and fontSize.
    // This debug exposes every scaling factor so we can identify
    // whether fontSize is unintentionally multiplied by devicePixelRatio,
    // double-counts viewportScale, or has any other scale leakage.
    (window as any).__overlayTransformDebug = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        console.warn("[Sprint33.5.8] Canvas not available.");
        return null;
      }

      const renderScale = 1.5; // PDF.js render scale (hardcoded)
      const cssScale = cssScaleRef.current;
      const dpr = window.devicePixelRatio || 1;
      const canvasScale = renderScale * cssScale; // PDF pt → CSS px

      const info = {
        pdfDimensions: {
          description: "PDF page size (pt)",
          width: +(canvas.width / renderScale).toFixed(1),
          height: +(canvas.height / renderScale).toFixed(1),
        },
        viewport: {
          description: "PDF.js viewport (canvas px at renderScale)",
          width: canvas.width,
          height: canvas.height,
          scale: renderScale,
        },
        cssDisplay: {
          description: "Canvas CSS display size (px)",
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
        },
        scaling: {
          renderScale,
          cssScale: +cssScale.toFixed(4),
          devicePixelRatio: dpr,
          canvasScale: +canvasScale.toFixed(4),
          explanation:
            "For a 12pt PDF font: CSS fontSize = 12 × renderScale × cssScale = 12 × " +
            renderScale +
            " × " +
            (+cssScale).toFixed(4) +
            " = " +
            (12 * canvasScale).toFixed(2) +
            " CSS px",
        },
      };

      console.group(
        "%c[Sprint33.5.8] Overlay Transform Chain",
        "font-weight:bold;color:#06b6d4;",
      );
      console.table({
        "PDF width (pt)": info.pdfDimensions.width,
        "PDF height (pt)": info.pdfDimensions.height,
        "Canvas width (px)": canvas.width,
        "Canvas height (px)": canvas.height,
        "CSS clientWidth": canvas.clientWidth,
        "CSS clientHeight": canvas.clientHeight,
        renderScale: renderScale,
        cssScale: +cssScale.toFixed(4),
        devicePixelRatio: dpr,
        "12pt → CSS px": +(12 * canvasScale).toFixed(2),
      });
      console.log(
        "%cScale chain: %cPDF pt %c→ %c×" +
          renderScale +
          " (render) %c→ %cc×" +
          (+cssScale).toFixed(4) +
          " (cssScale) %c→ %cCSS px",
        "color:#06b6d4;font-weight:bold;",
        "color:#94a3b8;",
        "color:#f59e0b;",
        "color:#06b6d4;",
        "color:#f59e0b;",
        "color:#06b6d4;",
        "color:#94a3b8;",
      );
      console.log(
        "  %cIf a block.style.fontSize > %c" +
          (12 * canvasScale).toFixed(1) +
          "px%c for a 12pt PDF font, fontSize has scale leakage.",
        "color:#f59e0b;",
        "color:#ef4444;font-weight:bold;",
        "color:#f59e0b;",
      );
      console.groupEnd();
      return info;
    };

    // ── M7.8-023: EDIT_STYLE_SOURCE_AUDIT ──
    // 追踪「原始 PDF glyph fontSize → Segment.font.size → editingSegment.font.size
    //   → 编辑框最终 fontSize」完整数据链，定位 16px fallback / 覆盖发生在哪个节点。
    // 用法：编辑态下在 console 执行 __editStyleAudit()
    (window as any).__editStyleAudit = () => {
      const doc = editableDocumentRef.current;
      const segs: any[] = (segmentsRef?.current ?? []) as any[];
      // 真实变量：editingSegmentId（useEditor 返回）、textEdit（useState）、showTextLayer
      const editingId: string | null = editingSegmentId ?? null;

      // ① PDF glyph 节点定位策略：
      //   a) 优先找含 glyph.modified=true 的行（编辑已写回模型的证明）
      //   b) 次之找 editedLineBoxes 记录的行（markLineEdited 写过，但模型未必同步）
      //   c) 兜底取第一个 block 的第一行（仅用于观察基准字号）
      const editedIds = new Set<string>(editedLineBoxesRef?.current?.keys?.() ?? []);
      let glyphNode: any = null;
      let locateBy = "none";
      if (doc) {
        outerGlyph: for (const pg of doc.pages) {
          for (const b of pg.blocks) {
            for (const l of b.lines) {
              const byModified = l.glyphs.some((g: any) => g.modified);
              const byEditedBox = editedIds.has(l.id);
              if (!byModified && !byEditedBox) continue;
              locateBy = byModified ? "glyph.modified" : "editedLineBoxes";
              const ref = l.glyphs[0]?.styleRef ?? 0;
              const st = doc.styles?.[ref] ?? {};
              glyphNode = {
                blockId: b.id,
                lineId: l.id,
                locatedBy: locateBy,
                glyphCount: l.glyphs.length,
                modifiedCount: l.glyphs.filter((g: any) => g.modified).length,
                styleRef: ref,
                "glyph.style.fontSize": st.fontSize,
                "glyph.style.fontFamily": st.fontFamily,
                "glyph.style.fontWeight": st.fontWeight,
                "glyph.style.fontStyle": st.fontStyle,
                pdfjsFontFamily: st.pdfjsFontFamily,
                "line.style.fontSize": l.style?.fontSize,
                glyphBBoxHeight: l.glyphs[0]?.bbox?.height,
                lineText: l.glyphs.map((g: any) => g.char).join("").slice(0, 60),
              };
              break outerGlyph;
            }
          }
        }
        // 兜底：观察基准（标明未编辑，仅供对比）
        if (!glyphNode && doc.pages[0]?.blocks[0]?.lines[0]) {
          const l: any = doc.pages[0].blocks[0].lines[0];
          const ref = l.glyphs[0]?.styleRef ?? 0;
          const st = doc.styles?.[ref] ?? {};
          glyphNode = {
            blockId: doc.pages[0].blocks[0].id,
            lineId: l.id,
            locatedBy: "fallback-first-line(未找到任何编辑痕迹)",
            glyphCount: l.glyphs.length,
            modifiedCount: l.glyphs.filter((g: any) => g.modified).length,
            styleRef: ref,
            "glyph.style.fontSize": st.fontSize,
            "glyph.style.fontFamily": st.fontFamily,
            "glyph.style.fontWeight": st.fontWeight,
            "glyph.style.fontStyle": st.fontStyle,
            pdfjsFontFamily: st.pdfjsFontFamily,
            "line.style.fontSize": l.style?.fontSize,
            glyphBBoxHeight: l.glyphs[0]?.bbox?.height,
            lineText: l.glyphs.map((g: any) => g.char).join("").slice(0, 60),
          };
        }
      }
      const editedLineBoxCount = editedIds.size;
      const editedLineBoxSample = [...editedIds].slice(0, 5);

      // ② Segment 节点
      const segNode = segs.length
        ? segs.slice(0, 400).map((s: any) => ({
            id: s.id,
            "segment.font.size": s.font?.size,
            "segment.font.family": s.font?.family,
            "segment.font.weight": s.font?.weight,
            "segment.font.style": s.font?.style,
            text: (s.text ?? "").slice(0, 40),
          }))
        : null;

      // ③ editingSegment 节点
      const editingSeg = editingId ? segs.find((s: any) => s.id === editingId) : null;
      const editingNode = editingSeg
        ? {
            id: editingSeg.id,
            "editingSegment.font.size": editingSeg.font?.size,
            "editingSegment.font.family": editingSeg.font?.family,
            "editingSegment.font.weight": editingSeg.font?.weight,
          }
        : null;

      // ④ 编辑框最终节点（TextEditOverlay 的 textEdit 状态）
      const te: any = textEdit;
      const overlayNode = te
        ? {
            "textEdit.fontSize": te.fontSize,
            "textEdit.fontFamily": te.fontFamily,
            "textEdit.fontWeight": te.fontWeight,
            "textEdit.lineHeight": te.lineHeight,
            "textEdit.bbox.height": te.bbox?.height,
          }
        : null;
      // 路径判定：EditModeToolbar(+/- 字号) 仅在 showTextLayer && editingSegmentId 时渲染
      // （PDFEditor.tsx: {showTextLayer && editingSegmentId && <EditModeToolbar />}），
      // 即「segment 编辑路径」；textEdit 非空则是「TextEditOverlay 路径」。
      const pathNode = {
        showTextLayer: (window as any).__showTextLayer ?? undefined,
        editingSegmentId: editingId,
        "走 segment 路径(EditModeToolbar)": !!editingId,
        "走 TextEditOverlay 路径": !!te,
        "两条路径同时激活": !!editingId && !!te,
      };

      // ⑤ 一致性判定（不使用"看起来差不多"，用精确相等）
      const gFs = glyphNode?.["glyph.style.fontSize"];
      const eFs = editingNode?.["editingSegment.font.size"];
      const oFs = overlayNode?.["textEdit.fontSize"];
      // 注意：必须排除「三者皆 undefined」造成的假相等（undefined === undefined）。
      const hasG = gFs !== undefined && gFs !== null;
      const hasE = eFs !== undefined && eFs !== null;
      const hasO = oFs !== undefined && oFs !== null;
      const verdict = {
        "数据完整性（三者是否都取到值）": hasG && hasE && hasO,
        "缺失节点": [
          !hasG ? "glyph(未找到 modified 行)" : null,
          !hasE ? "editingSegment(editingSegmentId 为空)" : null,
          !hasO ? "textEdit(TextEditOverlay 未激活)" : null,
        ].filter(Boolean),
        "glyph vs editingSegment fontSize 相等": hasG && hasE ? gFs === eFs : "N/A(缺值)",
        "glyph vs textEdit fontSize 相等": hasG && hasO ? gFs === oFs : "N/A(缺值)",
        "editingSegment vs textEdit fontSize 相等": hasE && hasO ? eFs === oFs : "N/A(缺值)",
        "是否出现 16 兜底": [gFs, eFs, oFs].some((v) => v === 16),
        "实测值": { glyph: gFs, editingSegment: eFs, textEdit: oFs },
        "提示":
          "若 glyph 为 undefined，说明 editableDocument 中没有任何 glyph.modified=true —— " +
          "即编辑未通过 onTextEditSave 写回模型（典型：走 segment/EditModeToolbar 路径）。",
      };

      console.group("%c[M7.8-023] EDIT_STYLE_SOURCE_AUDIT", "font-weight:bold;color:#06b6d4;");
      console.log("⓪ 当前激活路径：", pathNode);
      console.log(
        `   editedLineBoxes 条数=${editedLineBoxCount} 样例=${JSON.stringify(editedLineBoxSample)}`,
      );
      console.log("① PDF glyph 节点：", glyphNode);
      console.log("③ editingSegment 节点：", editingNode);
      console.log("④ 编辑框（TextEditOverlay）节点：", overlayNode);
      console.log("⑤ 一致性判定：", verdict);
      if (segNode) {
        console.log("② Segment 全表（前 400）：");
        console.table(segNode);
      }
      console.groupEnd();
      return { glyphNode, segNode, editingNode, overlayNode, verdict };
    };

    // ── M7.8-024: EXPORT_COORDINATE_TRACE（只读）──
    // 用法：__pgsExportTrace()            → 追踪 line 17（默认）
    //      __pgsExportTrace(17)          → 追踪指定 lineIndex
    //      __pgsExportTrace("block0_l17") → 按 lineId 追踪
    // 只读取模型数据 + 调用 traceExportCoordinate，不修改任何生产状态。
    (window as any).__pgsExportTrace = async (target?: number | string) => {
      const mod = await import("../../document-model/export-renderer");
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[M7.8-024] editableDocument 为空");
        return null;
      }
      const page = doc.pages[0];
      const block = page?.blocks?.[0];
      if (!block) {
        console.warn("[M7.8-024] 未找到 block");
        return null;
      }
      let line: any = null;
      let lineIndex = -1;
      if (typeof target === "string") {
        for (let i = 0; i < block.lines.length; i++) {
          if (block.lines[i].id === target) {
            line = block.lines[i];
            lineIndex = i;
            break;
          }
        }
      } else {
        lineIndex = target ?? 17;
        line = block.lines[lineIndex];
      }
      if (!line) {
        console.warn(`[M7.8-024] 未找到 line: ${target ?? 17}`);
        return null;
      }
      const rs = doc.runtime?.renderScale ?? 1.5;
      const cs = doc.runtime?.cssScale ?? 1;
      const maskBox = editedLineBoxesRef?.current?.get?.(line.id);
      const neighborLines = block.lines.slice(lineIndex, lineIndex + 2);
      // Phase C：提供 line.bbox、canvas 与上下行边界，用于只读像素扫描真实墨迹
      const prevLine = block.lines[lineIndex - 1] as any;
      const nextLine = block.lines[lineIndex + 1] as any;
      const prevLineBottom =
        prevLine?.bbox?.y !== undefined ? prevLine.bbox.y + prevLine.bbox.height : undefined;
      const nextLineTop = nextLine?.bbox?.y;
      const t = mod.traceExportCoordinate(
        line,
        doc.styles as any,
        page.height,
        rs,
        cs,
        maskBox,
        neighborLines,
        {
          lineBBox: (line as any).bbox,
          canvas: canvasRef?.current ?? null,
          prevLineBottom,
          nextLineTop,
          cssScale: cs,
        }
      );
      console.group(
        `%c[M7.8-024] EXPORT_COORDINATE_TRACE  line=${t.lineId} (index ${lineIndex})`,
        "font-weight:bold;color:#06b6d4;"
      );
      console.log(
        `glyphCount=${t.glyphCount} renderScale=${rs} cssScale=${cs} totalScale=${t.totalScale} pageHeightPt=${Math.round(t.pageHeightPt * 100) / 100}`
      );
      console.table(t.rows);
      console.log("%c摘要（Y 链）", "font-weight:bold;color:#f59e0b;");
      console.log(t.summary);
      console.log(
        `%c⭐ first divergence = ${t.firstDivergence}`,
        "font-weight:bold;color:#22c55e;"
      );
      console.log("%c水平 / 垂直独立性证明", "font-weight:bold;color:#f59e0b;");
      console.log(t.independenceProof);
      console.log("%cMASK 追踪（白色遮盖块）", "font-weight:bold;color:#ef4444;");
      console.log((t as any).mask);
      console.log("%cPhase C · 覆盖率判定（READ ONLY）", "font-weight:bold;color:#8b5cf6;");
      console.log(JSON.stringify((t as any).phaseC, null, 2));
      console.groupEnd();
      return t;
    };

    // ── Sprint 33.5.8: Overlay Similarity Debug ──
    // Compares GlyphRenderer overlay fontSize vs. PDF textContent fontSize
    // for the same text block (matched by spatial proximity).
    // If overlay fontSize ≫ PDF fontSize (e.g. 47px vs 16px),
    // there's a scale leakage in the EditableDocument pipeline.
    (window as any).__overlaySimilarityDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.5.8] No EditableDocument. Process a PDF first.");
        return null;
      }

      const renderScale = 1.5;
      const cssScale = cssScaleRef.current;
      const items = docTextItemsRef?.current || [];

      console.group(
        "%c[Sprint33.5.8] Overlay vs PDF Text Similarity",
        "font-weight:bold;color:#06b6d4;",
      );

      const rows: any[] = [];
      let totalRatio = 0;
      let count = 0;

      for (let pi = 0; pi < doc.pages.length; pi++) {
        const page = doc.pages[pi];
        const pageHeightPt =
          cssScale > 0 ? page.height / cssScale / renderScale : 0;

        for (const block of page.blocks) {
          if (block.type !== "text") continue;
          const blockText = block.lines
            .map((l: any) =>
              l.glyphs.map((g: any) => g.char).join(""),
            )
            .join(" ")
            .trim();
          if (!blockText) continue;

          const firstStyle = block.lines[0]?.style;
          const overlayFontSize = firstStyle?.fontSize ?? null;
          if (overlayFontSize === null) continue;

          // Back-calculate overlay fontSize to PDF pt
          const overlayFontSizePt =
            cssScale > 0 && renderScale > 0
              ? overlayFontSize / cssScale / renderScale
              : NaN;

          // Find nearest textItem by spatial bounding-box overlap
          const blockCx = block.bbox.x + block.bbox.width / 2;
          const blockCy = block.bbox.y + block.bbox.height / 2;
          const pageTextItems = items.filter(
            (ti: any) =>
              typeof ti.pageIndex === "number"
                ? ti.pageIndex === pi
                : true,
          );

          let bestItem: any = null;
          let bestDist = Infinity;
          for (const ti of pageTextItems) {
            const tcx = ti.x + ti.w / 2;
            const tcy = ti.y + ti.h / 2;
            const dist = Math.sqrt(
              (blockCx - tcx) ** 2 + (blockCy - tcy) ** 2,
            );
            if (dist < bestDist) {
              bestDist = dist;
              bestItem = ti;
            }
          }

          // Only match if within a reasonable distance (30% of block diagonal)
          const diag = Math.sqrt(
            block.bbox.width ** 2 + block.bbox.height ** 2,
          );
          const isMatch = bestItem && bestDist < diag * 0.3;
          const pdfFontSizePx = isMatch ? bestItem.fontSize : null;
          const ratio =
            pdfFontSizePx && pdfFontSizePx > 0
              ? overlayFontSize / pdfFontSizePx
              : null;

          if (ratio !== null) {
            totalRatio += ratio;
            count++;
          }

          rows.push({
            text: blockText.substring(0, 35),
            "overlay CSS px": +overlayFontSize.toFixed(2),
            "overlay PDF pt (back-calc)": +overlayFontSizePt.toFixed(1),
            "nearest textItem px":
              pdfFontSizePx !== null
                ? +pdfFontSizePx.toFixed(2)
                : "(no match)",
            "scale ratio":
              ratio !== null ? ratio.toFixed(3) + "×" : "—",
            "match dist": +bestDist.toFixed(1),
          });

          if (rows.length >= 30) break; // limit output
        }
        if (rows.length >= 30) break;
      }

      const avgRatio = count > 0 ? totalRatio / count : 0;

      console.table(rows);
      console.log(
        "%cAvg overlay/PDF ratio: %c" +
          avgRatio.toFixed(3) +
          "×",
        "color:#94a3b8;",
        avgRatio < 1.3
          ? "color:#22c55e;font-weight:bold;"
          : "color:#ef4444;font-weight:bold;",
      );
      if (avgRatio > 1.3) {
        console.log(
          "  %c⚠️ Overlay fontSize is ~%s× PDF fontSize. Scale leakage detected.",
          "color:#ef4444;font-weight:bold;",
          avgRatio.toFixed(1),
        );
        console.log(
          "  %c  Expected: avg ratio ≈ 1.0 (both in CSS px).",
          "color:#f59e0b;",
        );
      } else {
        console.log(
          "  %c✅ Overlay fontSize matches PDF text within tolerance.",
          "color:#22c55e;font-weight:bold;",
        );
      }

      console.groupEnd();
      return { rows, avgRatio, count };
    };

    // ── Sprint 33.5.9: Runtime Overlay Transform Debug ──
    // Iterates all [data-segment-id] DOM overlay elements and prints:
    //   1. Scale state snapshot (cssScale, renderScale, dpr, viewport)
    //   2. Per-element: computed fontSize, expected fontSize, delta
    //   3. Full parent transform chain (element → parent → grandparent → great-grandparent)
    //   4. Browser layout rect vs expected position from Segment data
    // Also enables EditableTextNode mount-time debug via __overlayRuntimeDebugEnabled flag.


    (window as any).__overlayRuntimeDebug = () => {
      // ── Step 1: Enable mount-time debug in EditableTextNode ──
      (window as any).__overlayRuntimeDebugEnabled = true;

      // ── Step 2: Snapshot scale state ──
      const canvas = canvasRef.current;
      const renderScale = 1.5;
      const cssScale = cssScaleRef.current;
      const dpr = window.devicePixelRatio || 1;

      console.group(
        "%c[Sprint33.5.9] Runtime Overlay Transform Debug",
        "font-weight:bold;color:#a855f7;",
      );

      console.log(
        "%c── Scale State Snapshot ──",
        "font-weight:bold;color:#06b6d4;",
      );
      console.table({
        cssScale: +cssScale.toFixed(4),
        renderScale,
        devicePixelRatio: dpr,
        canvasScale: +(renderScale * cssScale).toFixed(4),
        zoom: +((window as any).__zoom__ ?? "N/A"),
        viewportW: canvas ? canvas.width : "N/A",
        viewportH: canvas ? canvas.height : "N/A",
        clientW: canvas ? canvas.clientWidth : "N/A",
        clientH: canvas ? canvas.clientHeight : "N/A",
        "12pt→CSSpx": +(12 * renderScale * cssScale).toFixed(2),
      });
      console.log(
        "  %cScale chain: PDF pt %c→ %c×" +
          renderScale +
          " (render) %c→ %c×" +
          (+cssScale).toFixed(4) +
          " (cssScale) %c→ %cCSS px",
        "color:#a855f7;",
        "color:#94a3b8;",
        "color:#06b6d4;",
        "color:#94a3b8;",
        "color:#06b6d4;",
        "color:#94a3b8;",
        "color:#a855f7;",
      );

      // ── Step 3: Query all overlay DOM elements ──
      const overlayEls = document.querySelectorAll("[data-segment-id]");
      console.log(
        "%c── Overlay Elements Found: %d ──",
        "font-weight:bold;color:#06b6d4;",
        overlayEls.length,
      );

      if (overlayEls.length === 0) {
        console.warn(
          "  No [data-segment-id] elements in DOM. Segments may not have mounted yet.",
        );
        console.groupEnd();
        return { scaleState: { cssScale, renderScale, dpr }, elements: [] };
      }

      // ── Helper: walk parent chain and collect transforms ──
      const getTransformChain = (el: HTMLElement): any[] => {
        const chain: any[] = [];
        let current: HTMLElement | null = el.parentElement;
        let level = 1;
        while (current && level <= 3) {
          const cs = window.getComputedStyle(current);
          chain.push({
            level: level === 1 ? "parent" : level === 2 ? "grandparent" : "great-grandparent",
            tag: current.tagName.toLowerCase(),
            id: current.id || "—",
            className: typeof current.className === "string"
              ? current.className.replace(/\s+/g, " ").trim().substring(0, 50)
              : "—",
            transform: cs.transform === "none" ? "none" : cs.transform,
          });
          current = current.parentElement;
          level++;
        }
        return chain;
      };

      // ── Helper: compute final scale by multiplying all parent matrix scales ──
      const computeFinalScale = (el: HTMLElement): number => {
        let scale = 1;
        let current: HTMLElement | null = el;
        while (current) {
          const t = window.getComputedStyle(current).transform;
          if (t && t !== "none") {
            const vals = t.match(/matrix[\d]*\(([^)]+)\)/);
            if (vals) {
              const parts = vals[1].split(",").map(Number);
              const sx = Math.sqrt(parts[0] * parts[0] + parts[1] * parts[1]);
              scale *= sx;
            }
          }
          current = current.parentElement;
        }
        return scale;
      };

      // ── Step 4: Per-element analysis ──
      const results: any[] = [];
      const maxToShow = 15;

      for (let i = 0; i < Math.min(overlayEls.length, maxToShow); i++) {
        const el = overlayEls[i] as HTMLElement;
        const segId = el.getAttribute("data-segment-id") || "";
        const computed = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const chain = getTransformChain(el);
        const finalScale = computeFinalScale(el);

        const hasNonNoneTransform = chain.some(
          (c: any) => c.transform !== "none",
        );

        if (hasNonNoneTransform) {
          console.group(
            "%c[%d] %c⚠️ %s",
            "color:#94a3b8;",
            i,
            "color:#ef4444;font-weight:bold;",
            segId.substring(0, 8),
          );
        } else {
          console.group(
            "%c[%d] %s",
            "color:#94a3b8;",
            i,
            segId.substring(0, 8),
          );
        }

        const owningSeg = segments.find((s: any) => s.id === segId);
        const expectedFontSize = owningSeg?.font?.size ?? "unknown";
        const actualFontSize = parseFloat(computed.fontSize);
        const delta = expectedFontSize === "unknown" ? NaN : actualFontSize - expectedFontSize;

        console.log(
          "%ctext:%c \"%s\"",
          "color:#94a3b8;",
          "color:#f59e0b;",
          (el.textContent || "").substring(0, 40),
        );
        console.log(
          "%cfontSize: calc=%c%s%c expected=%c%s%c delta=%c%s",
          "color:#94a3b8;",
          "color:#22c55e;", actualFontSize + "px",
          "color:#94a3b8;",
          "color:#06b6d4;", expectedFontSize + "px",
          "color:#94a3b8;",
          isNaN(delta) || delta === 0 ? "color:#22c55e;" : "color:#ef4444;font-weight:bold;",
          isNaN(delta) ? "N/A" : (delta === 0 ? "0" : (delta > 0 ? "+" : "") + delta + "px"),
        );
        console.log(
          "%clineHeight: %s",
          "color:#94a3b8;",
          computed.lineHeight,
        );
        console.log(
          "%cown transform: %c%s",
          "color:#94a3b8;",
          "",
          computed.transform,
        );
        if (chain.length > 0) {
          console.log("%c── Parent Transform Chain ──", "color:#94a3b8;");
          console.table(chain, ["level", "tag", "id", "className", "transform"]);
        }
        console.log(
          "%cfinalScale: %c%s",
          "color:#94a3b8;",
          finalScale !== 1 ? "color:#ef4444;font-weight:bold;" : "color:#22c55e;",
          finalScale.toFixed(4) + (finalScale !== 1 ? " ⚠️ NON-IDENTITY" : ""),
        );
        console.log(
          "%crect (browser): x=%d y=%d w=%d h=%d",
          "color:#94a3b8;",
          Math.round(rect.x), Math.round(rect.y),
          Math.round(rect.width), Math.round(rect.height),
        );
        if (owningSeg) {
          const expectedRect = {
            x: owningSeg.cssX, y: owningSeg.cssY,
            w: owningSeg.cssW, h: owningSeg.cssH,
          };
          const rectMatch =
            Math.abs(rect.x - expectedRect.x) < 5 &&
            Math.abs(rect.y - expectedRect.y) < 5 &&
            Math.abs(rect.width - expectedRect.w) < 5 &&
            Math.abs(rect.height - expectedRect.h) < 5;
          console.log(
            "%cexpected rect: x=%d y=%d w=%d h=%d %s",
            "color:#94a3b8;",
            Math.round(expectedRect.x), Math.round(expectedRect.y),
            Math.round(expectedRect.w), Math.round(expectedRect.h),
            rectMatch ? "✅" : "⚠️",
          );
        }

        results.push({
          id: segId.substring(0, 12),
          text: (el.textContent || "").substring(0, 30),
          computedFontSize: actualFontSize,
          expectedFontSize,
          delta: isNaN(delta) ? "N/A" : delta,
          finalScale: +finalScale.toFixed(4),
          hasTransformChain: hasNonNoneTransform,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });

        console.groupEnd();
      }

      if (overlayEls.length > maxToShow) {
        console.log(
          "  ... and %d more elements (not shown).",
          overlayEls.length - maxToShow,
        );
      }

      // ── Summary ──
      const elementsWithTransform = results.filter((r: any) => r.hasTransformChain);
      const elementsWithFontDelta = results.filter((r: any) => typeof r.delta === "number" && Math.abs(r.delta) > 2);

      console.log("%c── Summary ──", "font-weight:bold;color:#06b6d4;");
      console.log(
        "  Total overlay elements: %d",
        overlayEls.length,
      );
      console.log(
        "  %cElements with non-identity parent transform: %c%d",
        elementsWithTransform.length > 0 ? "color:#ef4444;" : "color:#22c55e;",
        elementsWithTransform.length > 0 ? "color:#ef4444;font-weight:bold;" : "",
        elementsWithTransform.length,
      );
      console.log(
        "  %cElements with fontSize delta > 2px: %c%d",
        elementsWithFontDelta.length > 0 ? "color:#ef4444;" : "color:#22c55e;",
        elementsWithFontDelta.length > 0 ? "color:#ef4444;font-weight:bold;" : "",
        elementsWithFontDelta.length,
      );

      if (elementsWithTransform.length > 0) {
        console.warn(
          "  ⚠️ CASE A/B detected: Overlay has parent transform scale. Check parent chain above.",
        );
      }
      if (elementsWithFontDelta.length > 0) {
        console.warn(
          "  ⚠️ CASE C detected: fontSize mismatch between computed and expected.",
        );
      }
      if (elementsWithTransform.length === 0 && elementsWithFontDelta.length === 0) {
        console.log("  %c✅ All overlay elements look clean (no transform chain, no fontSize delta).", "color:#22c55e;");
      }

      console.groupEnd();
      return { scaleState: { cssScale, renderScale, dpr }, elements: results, summary: { total: overlayEls.length, withTransform: elementsWithTransform.length, withFontDelta: elementsWithFontDelta.length } };
    };

    // ── Sprint 33.3.3 Task 5: Adobe Similarity Debug ──
    (window as any).__adobeSimilarityDebug = () => {
      if (!editableDocumentRef.current || !layoutDocument) {
        console.warn("[Sprint33.3.3] Need EditableDocument + LayoutDocument.");
        return null;
      }
      const doc = editableDocumentRef.current;
      const cssScale = cssScaleRef.current;
      const renderScale = 1.5;

      // Flatten: doc.pages[].blocks[] (not doc.blocks)
      const allBlocks: { block: typeof doc.pages[0]["blocks"][0]; pageIdx: number }[] = [];
      for (let pi = 0; pi < doc.pages.length; pi++) {
        for (const block of doc.pages[pi].blocks) {
          allBlocks.push({ block, pageIdx: pi });
        }
      }

      const result: any = {
        totalBlocks: allBlocks.length,
        fontMismatchBlocks: 0,
        fontMismatchPercent: 0,
        lineMismatchBlocks: 0,
        lineMismatchPercent: 0,
        positionMismatchTotalPx: 0,
        details: [] as any[],
      };

      // Expected "normal" values for a standard document
      const minReasonableFontSize = 8;   // CSS px (too small)
      const maxReasonableFontSize = 24;  // CSS px (too large)

      for (const { block, pageIdx } of allBlocks) {
        // Reconstruct text from glyphs
        const blockText = block.lines
          .map((l) => l.glyphs.map((g) => g.char).join(""))
          .join(" ");
        // Style: first line's style → fontSize; fallback to glyph styleRef
        const firstLine = block.lines[0];
        const firstGlyphStyleRef = firstLine?.glyphs[0]?.styleRef ?? -1;
        const docStyleEntry = firstGlyphStyleRef >= 0 ? doc.styles[firstGlyphStyleRef] : null;
        const overlayFontSize = firstLine?.style?.fontSize
          ?? docStyleEntry?.fontSize
          ?? 14;

        // Font mismatch: fontSize outside reasonable range
        const fontMismatch = overlayFontSize < minReasonableFontSize
          || overlayFontSize > maxReasonableFontSize;

        // Line count (EditableBlock has .lines array; no ocrLineCount meta)
        const currentLineCount = block.lines.length;

        // Position mismatch: bbox x deviation
        const expectedLeftEdge = 70; // CSS px
        const posMismatch = Math.abs(block.bbox.x - expectedLeftEdge);

        result.details.push({
          id: block.id,
          text: blockText.substring(0, 40),
          overlayFontSize,
          fontMismatch,
          currentLines: currentLineCount,
          lineMismatch: false,  // no original ocrLineCount to compare against
          bboxX: block.bbox.x,
          posMismatchPx: posMismatch,
          page: pageIdx,
          regionType: block.regionType,
        });

        if (fontMismatch) result.fontMismatchBlocks++;
        result.positionMismatchTotalPx += posMismatch;
      }

      const total = allBlocks.length || 1;
      result.fontMismatchPercent = ((result.fontMismatchBlocks / total) * 100).toFixed(1);
      result.lineMismatchPercent = "N/A";
      result.positionMismatchTotalPx = result.positionMismatchTotalPx.toFixed(1);

      console.group("%c[Sprint33.3.3] Adobe Similarity Metrics", "font-weight:bold;color:#3b82f6;");
      console.log("Total blocks:", result.totalBlocks);
      console.log(`Font mismatch:  ${result.fontMismatchPercent}% (${result.fontMismatchBlocks}/${result.totalBlocks})`);
      console.log(`Line mismatch:  N/A (no OCR metadata in EditableDocument)`);
      console.log(`Position mismatch: ${result.positionMismatchTotalPx} px total`);
      console.table(result.details.map((d: any) => ({
        id: d.id,
        page: d.page,
        fontSize: d.overlayFontSize,
        fontOK: !d.fontMismatch,
        lines: d.currentLines,
        regionType: d.regionType ?? "-",
        posErr: d.posMismatchPx.toFixed(1),
        text: d.text,
      })));
      console.groupEnd();

      return result;
    };

    // ── Sprint 33.3.4 Task 1 & 2: Position Coordinate Calibration ──
    (window as any).__positionMetricDebug = () => {
      if (!layoutDocument || !editableDocumentRef.current) {
        console.warn("[Sprint33.3.4] Need layoutDocument + EditableDocument.");
        return null;
      }
      const layout = layoutDocument;
      const edDoc = editableDocumentRef.current;
      const details: any[] = [];

      // Flatten all block-level nodes from the layout tree.
      // Key invariant: nodes that carry sourceBlockId are our comparison targets:
      //   - Reconstructed-paragraph path: line nodes have sourceBlockId (set in buildParagraphWithReconstructedLines)
      //   - Signature path:       inner signature sub-blocks have sourceBlockId (set in buildBlockNode)
      //   - Other/preserve path:  paragraph nodes have sourceBlockId (set in buildBlockNode)
      // Nodes without sourceBlockId are intermediate containers → recurse into their children.
      function walkLayout(node: any, ancestors: any[] = []): any[] {
        if (node.sourceBlockId) {
          return [{ node, ancestors }];
        }
        if (node.children?.length) {
          const result: any[] = [];
          for (const child of node.children) {
            result.push(...walkLayout(child, [...ancestors, node]));
          }
          return result;
        }
        return [];
      }

      const blockNodes: any[] = [];
      for (const page of layout.pages) {
        for (const topNode of page.children) {
          blockNodes.push(...walkLayout(topNode, []));
        }
      }

      // Build editable block map for quick lookup
      const editableBlocks = new Map<string, any>();
      for (const page of edDoc.pages) {
        for (const block of page.blocks) {
          editableBlocks.set(block.id, block);
        }
      }

      for (const { node, ancestors } of blockNodes) {
        const nodeBlockId = node.sourceBlockId;
        if (!nodeBlockId) continue;

        const editableBlock = editableBlocks.get(nodeBlockId);
        const isSignature = ancestors.some((a: any) => a.type === "signature");
        const parentSig = ancestors.find((a: any) => a.type === "signature");

        // Try to find rendered DOM element for this block
        let domRect: DOMRect | null = null;
        try {
          const el = document.querySelector(`[data-block-id="${nodeBlockId}"]`);
          if (el) {
            domRect = el.getBoundingClientRect();
          }
        } catch (_) {
          // DOM not available
        }

        const detail: any = {
          text: (node.text || "").substring(0, 50),
          sourceBlockId: nodeBlockId,
          type: node.type,
          isSignature,
          coordinateSpace: node.coordinateSpace || "?",

          layout: {
            bbox: { ...node.bbox },
            space: node.coordinateSpace || "CSS_PIXEL",
            rotation: node.transform?.rotation ?? 0,
          },

          editable: editableBlock
            ? { bbox: { ...editableBlock.bbox }, regionType: editableBlock.regionType }
            : { bbox: null, note: "not found" },

          renderer: domRect
            ? { x: Math.round(domRect.left * 100) / 100, y: Math.round(domRect.top * 100) / 100,
                w: Math.round(domRect.width * 100) / 100, h: Math.round(domRect.height * 100) / 100 }
            : null,
        };

        // Parent-child: if signature, compare parent bbox with child
        if (parentSig) {
          detail.signature = {
            parentBbox: { ...parentSig.bbox },
            childX: node.bbox.x,
            childY: node.bbox.y,
            deltaX: node.bbox.x - parentSig.bbox.x,
            deltaY: node.bbox.y - parentSig.bbox.y,
            isAbsoluteCoords: true, // confirmed: children use page-absolute bbox
            rotation: parentSig.transform?.rotation ?? 0,
          };
        }

        details.push(detail);
      }

      // Summary statistics
      let totalPosErr = 0;
      let signatureBlocks = 0;
      for (const d of details) {
        if (d.layout.bbox && d.editable?.bbox) {
          const dx = Math.abs(d.layout.bbox.x - d.editable.bbox.x);
          const dy = Math.abs(d.layout.bbox.y - d.editable.bbox.y);
          totalPosErr += dx + dy;
        }
        if (d.isSignature) signatureBlocks++;
      }

      console.group("%c[Sprint33.3.4] Position Metric Debug", "font-weight:bold;color:#22c55e;");
      console.log(`Blocks: ${details.length} (signature: ${signatureBlocks})`);
      console.log(`Total layout↔editable position delta: ${totalPosErr.toFixed(1)} px`);
      if (signatureBlocks > 0) {
        console.log("%cSignature parent-child analysis:", "font-weight:bold;color:#f59e0b;");
        for (const d of details.filter((d: any) => d.signature)) {
          console.log(`  ${d.text}`, d.signature);
        }
      }
      console.table(details.map((d: any) => ({
        text: d.text,
        type: d.type,
        sig: d.isSignature ? "Y" : "-",
        space: d.coordinateSpace,
        lx: d.layout.bbox.x.toFixed(1),
        ly: d.layout.bbox.y.toFixed(1),
        ex: d.editable?.bbox?.x?.toFixed(1) ?? "-",
        ey: d.editable?.bbox?.y?.toFixed(1) ?? "-",
        rot: d.layout.rotation.toFixed(1),
      })));
      console.groupEnd();

      return details;
    };

    return () => {
      delete (window as any).__layoutDebug;
      delete (window as any).__layoutTree;
      delete (window as any).__layoutDump;
      delete (window as any).__signatureLayoutDebug;
      delete (window as any).__editableTransformDebug;
      delete (window as any).__signatureCoordinateDebug;
      delete (window as any).__signatureRegionIsolationDebug;
      delete (window as any).__signatureExportDebug;
      delete (window as any).__lineReconstructionDebug;
      delete (window as any).__lineReconstructionScoreDebug;
      delete (window as any).__ocrLineDebug;
      delete (window as any).__lineStabilityDebug;
      delete (window as any).__textMetricDebug;
      delete (window as any).__adobeSimilarityDebug;
      delete (window as any).__positionMetricDebug;
      delete (window as any).__overlayTransformDebug;
      delete (window as any).__overlaySimilarityDebug;
      delete (window as any).__overlayRuntimeDebug;
      delete (window as any).__overlayRuntimeDebugEnabled;
    };
  }, [layoutDocument]);
}
