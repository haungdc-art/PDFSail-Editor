/**
 * useExport — V12 简化版 + Sprint 7 EditableDocument Export
 *
 * Sprint 7 更新：
 *   - 优先用 EditableDocument 导出（exportEditableDocument）
 *   - 保留旧 TextBlock 导出作为 fallback（exportPDF）
 *   - Mutation 同步：编辑后 docBlocks 从 EditableDocument 重新生成，导出保持一致
 *
 * 流程：
 *   EditableDocument（主数据源）
 *     ↓ exportEditableDocument()
 *   ExportCommand[]
 *     ↓ pdf-lib
 *   PDF bytes
 *
 * Fallback：
 *   EditableDocument 为空 → docBlocks → exportPDF（旧路径）
 *
 * Ref 由 PDFEditorInner 持有并注入：
 *   coordRef / pdfBytesRef / cssScaleRef / editableDocumentRef
 */

import { useEditor } from "../core/EditorProvider";
import { exportPDF, downloadPDF } from "../export-pdf";
import type { LockCoordSystem } from "../coord";
import type { EditableDocument, SignatureRenderRegion } from "../../document-model";
import { exportEditableDocument } from "../../document-model";
import type { Segment } from "../../editor-engine/types";

interface UseExportParams {
  coordRef: React.MutableRefObject<LockCoordSystem | null>;
  pdfBytesRef: React.MutableRefObject<ArrayBuffer | null>;
  cssScaleRef: React.MutableRefObject<number>;
  /** Sprint 7: EditableDocument 引用（主数据源） */
  editableDocumentRef?: React.MutableRefObject<EditableDocument | null>;
  /** Sprint 7: renderScale（默认 1.5） */
  renderScale?: number;
  /** Sprint 33.5.6: 签名区域数据（用于导出时应用旋转） */
  signatureRegionsRef?: React.MutableRefObject<SignatureRenderRegion[]>;
  /** M7.7-006: 编辑态真实墨迹覆盖盒（lineId → CSS bbox），供导出 mask 覆盖真实墨迹。 */
  editedLineBoxesRef?: React.MutableRefObject<Map<string, { x: number; y: number; width: number; height: number }> | undefined>;
  /** M7.8-020-PROD: segment 列表引用，导出前把文本编辑回写 EditableDocument。 */
  segmentsRef?: React.MutableRefObject<Segment[]>;
  /** M7.8-041: 跨页 segment 累积（导出专用）。展开全部已渲染页的编辑，避免翻页后其它页修改丢失。 */
  getAllPageSegments?: () => Segment[];
}

export interface ExportResult {
  bytes: Uint8Array;
  blob: Blob;
  fileName: string;
  /** 导出方式：editableDocument（主）或 textBlock（fallback） */
  exportSource: "editableDocument" | "textBlock";
}

/**
 * M7.8-020-PROD / M7.8-040：把 segment 层的文本编辑同步进 EditableDocument。
 * 实现抽到 segmentEditBinding.ts（纯 additive binding 层，无 React 依赖，便于测试）。
 * 这里在导出前调用它，按 Segment.source 精确回写，不依赖 indexOf(originalText)。
 */
import { applySegmentEditsToDocument } from "./segmentEditBinding";

export function useExport({
  coordRef,
  pdfBytesRef,
  cssScaleRef,
  editableDocumentRef,
  renderScale = 1.5,
  signatureRegionsRef,
  editedLineBoxesRef,
  segmentsRef,
  getAllPageSegments,
}: UseExportParams) {
  const { docBlocks, fileName } = useEditor();

  /**
   * 生成 PDF 并返回 blob。
   *
   * Sprint 7：优先用 EditableDocument 导出，fallback 到 TextBlock。
   *
   * @param _skipPay 保留参数签名以兼容旧调用
   * @param download 是否触发本地下载
   * @returns ExportResult 或 null
   */
  const handleExport = async (
    _skipPay?: boolean,
    download = false
  ): Promise<ExportResult | null> => {
    if (!pdfBytesRef.current) return null;

    let bytes: Uint8Array;
    let exportSource: "editableDocument" | "textBlock";

    // Sprint 7: 优先用 EditableDocument 导出
    if (editableDocumentRef?.current) {
      try {
        // Sprint39-M2C：ctx 由 Export 从 doc.runtime 读取，Caller 不传 ctx。
        // 文档就绪时补齐 runtime（renderScale/cssScale 属于 Editor Runtime，非 Export 参数）。
        const doc = editableDocumentRef.current;
        if (!doc.runtime) {
          doc.runtime = {
            renderScale,
            cssScale: cssScaleRef.current,
            pageMetrics: doc.pages.map((p) => ({ width: p.width, height: p.height })),
          };
        }

        // M7.8-020-PROD：导出前把 segment 的文本编辑回写 EditableDocument，
        // 否则导出仍用原文（segment 编辑只写进 segments state，不会同步到 EditableDocument）。
        // M7.8-041：优先用跨页累积 segments（展开全部已渲染页 + 回放编辑），
        // 翻页后其它页的修改才不会丢失；回退到 segmentsRef（当前页）。
        const allEditSegs = getAllPageSegments ? getAllPageSegments() : (segmentsRef?.current ?? []);
        console.log("[EXPORT-DIAG]", {
          willUse: editableDocumentRef.current ? "editableDocument" : "textBlock",
          allEditSegs: allEditSegs.length,
          docPage0Block0Line0: doc.pages[0]?.blocks[0]?.lines?.[0]?.glyphs?.map((g: any) => g.char).join(""),
          docEditedLines: doc.pages.flatMap((p: any) => p.blocks).flatMap((b: any) => b.lines).filter((l: any) => l.edited || l.glyphs?.some((g: any) => g.modified)).length,
        });
        const docForExport = allEditSegs.length
          ? applySegmentEditsToDocument(doc, allEditSegs)
          : doc;

        bytes = await exportEditableDocument(
          docForExport,
          pdfBytesRef.current,
          signatureRegionsRef?.current,
          undefined,
          // M7.7-006: 真实墨迹覆盖盒 → 导出 mask 盖住旧文字像素，避免残留
          editedLineBoxesRef?.current
        );
        exportSource = "editableDocument";

        console.log("[Sprint 7] Export from EditableDocument:", {
          pages: editableDocumentRef.current.pages.length,
          styles: editableDocumentRef.current.styles.length,
        });
      } catch (e) {
        console.warn(
          "[Sprint 7] EditableDocument export failed, falling back to TextBlock:",
          e
        );
        // Fallback 到 TextBlock
        bytes = await exportFromTextBlocks();
        exportSource = "textBlock";
      }
    } else {
      // 无 EditableDocument，用旧 TextBlock 导出
      bytes = await exportFromTextBlocks();
      exportSource = "textBlock";
    }

    const outName = `edited-${fileName || "output"}.pdf`;
    if (download) {
      downloadPDF(bytes, outName);
    }
    const blob = new Blob([bytes.slice().buffer], {
      type: "application/pdf",
    });
    return { bytes, blob, fileName: outName, exportSource };
  };

  /**
   * 旧 TextBlock 导出路径（fallback）
   */
  const exportFromTextBlocks = async (): Promise<Uint8Array> => {
    if (!coordRef.current) {
      throw new Error("CoordSystem not available for TextBlock export");
    }
    const s = cssScaleRef.current;
    const pxBlocks = docBlocks.map((b) => ({
      ...b,
      x: b.x / s,
      y: b.y / s,
      w: b.w / s,
      h: b.h / s,
      fontSize: b.fontSize ? b.fontSize / s : b.fontSize,
    }));
    return await exportPDF(pxBlocks, coordRef.current, pdfBytesRef.current!);
  };

  return { handleExport };
}
