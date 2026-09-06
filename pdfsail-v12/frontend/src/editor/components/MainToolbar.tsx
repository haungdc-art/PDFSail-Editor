/**
 * MainToolbar — V12 简化版
 *
 * 顶部工具栏（Upload / Workspace / 文本工具 / OCR / PDF to Word / Clear）。
 * V12 移除 compress/split/rotate/pagenum/excel/watermark/merge。
 *
 * State 来自 useEditor()，跨 domain 回调与 ref 通过 props 注入：
 *   handleUpload / addBlock / imageInputRef / handleImageSelect /
 *   handleOCR / pdfBytesRef / processInline / handleExport / exitEditMode
 */

import { useState, type RefObject } from "react";
import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";

const btn: React.CSSProperties = {
  padding: "7px 12px",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  fontWeight: 500,
  whiteSpace: "nowrap",
};
const sep: React.CSSProperties = {
  width: 1,
  height: 22,
  background: "#e2e8f0",
  margin: "0 2px",
};

interface MainToolbarProps {
  handleUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  addBlock: (type: any, extra?: any) => void;
  imageInputRef: RefObject<HTMLInputElement>;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleOCR: () => void;
  pdfBytesRef: RefObject<ArrayBuffer | null>;
  processInline: (tool: string, extra?: any) => void;
  /** Bug 15: 点击其他功能按钮时自动关闭 Edit 模式并保存文本 */
  exitEditMode: () => void;
  /** Bug 5: convert 功能跳转 paywall（保存 PDF + 工具类型后跳转） */
  onConvertClick: (tool: string) => void;
}

export function MainToolbar({
  handleUpload,
  addBlock,
  imageInputRef,
  handleImageSelect,
  handleOCR,
  pdfBytesRef,
  processInline,
  exitEditMode,
  onConvertClick,
}: MainToolbarProps) {
  const {
    pdfDoc,
    thumbnailCol,
    setThumbnailCol,
    workspaceMode,
    setWorkspaceMode,
    wsActionsDone,
    setShowIntentModal,
    textFormat,
    addingType,
    setAddingType,
    setShowSignature,
    showTextLayer,
    setShowTextLayer,
    handleUndo,
    handleRedo,
    undoRef,
    ocrBusy,
    docBlocks,
    setBlocks,
    fileName,
    page,
    totalPages,
    showFindReplace,
    setShowFindReplace,
    editingSegmentId,
    setEditingSegmentId,
  } = useEditor();
  const { t } = useI18n();
  const [showConvert, setShowConvert] = useState(false);

  /**
   * Bug 15: 点击工具按钮前的统一处理 —— 如果当前在 Edit 模式，先提交编辑并退出 Edit 模式。
   * 注意：exitEditMode 会 blur 当前 contentEditable 元素，触发 handleBlur 提交文本。
   */
  const wrapWithExitEdit = (fn: () => void) => () => {
    if (showTextLayer || editingSegmentId) {
      exitEditMode();
    }
    fn();
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        marginBottom: 16,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      {/* Bug 7: 没有文档加载时，隐藏 Upload 按钮（画布中间显示上传组件） */}
      {pdfDoc && (
        <label
          style={{
            padding: "8px 16px",
            background: "#3b82f6",
            color: "#fff",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {/* BUG 9: 按钮文案改为 Open Document */}
          Open Document
          <input
            type="file"
            accept=".pdf"
            onChange={handleUpload}
            style={{ display: "none" }}
          />
        </label>
      )}
      {pdfDoc && !thumbnailCol && (
        <button
          onClick={() => setThumbnailCol(true)}
          style={{
            padding: "4px 8px",
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 11,
            color: "#64748b",
          }}
        >
          {t("toolbar.pages")}
        </button>
      )}
      {pdfDoc && false && (
        <button
          onClick={() => setWorkspaceMode((v) => !v)}
          style={{
            ...btn,
            background: workspaceMode ? "#7c5cfc" : "#f1f5f9",
            borderColor: workspaceMode ? "#7c5cfc" : "#e2e8f0",
            color: workspaceMode ? "#fff" : "#64748b",
            fontWeight: workspaceMode ? 700 : 500,
          }}
        >
          🧭 {workspaceMode ? "Workspace ON" : "Workspace"}
        </button>
      )}
      {pdfDoc && false && workspaceMode && wsActionsDone.length === 0 && (
        <button
          onClick={() => setShowIntentModal(true)}
          style={{ ...btn, background: "#4ade80", color: "#1a1a2e", fontWeight: 600 }}
        >
          Set Intent
        </button>
      )}
      {pdfDoc && <div style={sep} />}
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(() =>
            addBlock("text", {
              text: "Edit me",
              fontSize: textFormat.fontSize,
              fontFamily: textFormat.fontFamily,
              color: textFormat.color,
            })
          )}
          style={btn}
        >
          {t("toolbar.text")}
        </button>
      )}
      {pdfDoc && (
        <button onClick={wrapWithExitEdit(() => imageInputRef.current?.click())} style={btn}>
          {t("toolbar.image")}
        </button>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageSelect}
        style={{ display: "none" }}
      />
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(() => setAddingType(addingType === "highlight" ? null : "highlight"))}
          style={{
            ...btn,
            background: addingType === "highlight" ? "#facc15" : "#f1f5f9",
            borderColor: addingType === "highlight" ? "#facc15" : "#e2e8f0",
            color: addingType === "highlight" ? "#fff" : "#64748b",
            fontWeight: addingType === "highlight" ? 700 : 500,
          }}
        >
          {t("toolbar.highlight")}
        </button>
      )}
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(() => setAddingType(addingType === "redact" ? null : "redact"))}
          style={{
            ...btn,
            background: addingType === "redact" ? "#1e293b" : "#f1f5f9",
            borderColor: addingType === "redact" ? "#1e293b" : "#e2e8f0",
            color: addingType === "redact" ? "#fff" : "#64748b",
            fontWeight: addingType === "redact" ? 700 : 500,
          }}
        >
          {t("toolbar.redact")}
        </button>
      )}
      {pdfDoc && (
        <button onClick={wrapWithExitEdit(() => setShowSignature(true))} style={btn}>
          {t("toolbar.signature")}
        </button>
      )}
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(() => setAddingType(addingType === "annotate" ? null : "annotate"))}
          style={{
            ...btn,
            background: addingType === "annotate" ? "#3b82f6" : "#f1f5f9",
            borderColor: addingType === "annotate" ? "#3b82f6" : "#e2e8f0",
            color: addingType === "annotate" ? "#fff" : "#64748b",
            fontWeight: addingType === "annotate" ? 700 : 500,
          }}
        >
          {t("toolbar.annotate")}
        </button>
      )}
      {pdfDoc && <div style={sep} />}
      {pdfDoc && (
        <button
          onClick={() => {
            // Bug 15: 切换 Edit 模式本身不需要 exitEditMode
            setShowTextLayer((v) => !v);
            setEditingSegmentId(null);
          }}
          style={{
            ...btn,
            background: showTextLayer ? "#3b82f6" : "#f1f5f9",
            borderColor: showTextLayer ? "#3b82f6" : "#e2e8f0",
            color: showTextLayer ? "#fff" : "#64748b",
            fontWeight: showTextLayer ? 700 : 500,
          }}
        >
          {t("toolbar.edit")}
        </button>
      )}
      {/* V12: Find & Replace 按钮 */}
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(() => setShowFindReplace(!showFindReplace))}
          style={{
            ...btn,
            background: showFindReplace ? "#0ea5e9" : "#f1f5f9",
            borderColor: showFindReplace ? "#0ea5e9" : "#e2e8f0",
            color: showFindReplace ? "#fff" : "#64748b",
            fontWeight: showFindReplace ? 700 : 500,
          }}
          disabled={!pdfDoc}
          title="Find & Replace (Ctrl+F)"
        >
          🔍 Find
        </button>
      )}
      {pdfDoc && <div style={sep} />}
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(handleUndo)}
          style={{ ...btn, opacity: undoRef.canUndo ? 1 : 0.35 }}
          disabled={!undoRef.canUndo}
        >
          {t("toolbar.undo")}
        </button>
      )}
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(handleRedo)}
          style={{ ...btn, opacity: undoRef.canRedo ? 1 : 0.35 }}
          disabled={!undoRef.canRedo}
        >
          {t("toolbar.redo")}
        </button>
      )}
      {pdfDoc && <div style={sep} />}
      {/* 入口已屏蔽：OCR Page / OCR Region 按钮不显示在工具栏，但功能
          （handleOCR / processInline("ocr")）仍保留在代码中，便于日后恢复 */}
      {false && pdfDoc && (
        <button
          onClick={wrapWithExitEdit(handleOCR)}
          style={{ ...btn, background: ocrBusy ? "#94a3b8" : "#f59e0b", color: "#fff" }}
          disabled={ocrBusy || !pdfDoc}
        >
          {ocrBusy ? t("toolbar.ocrBusy") : t("toolbar.ocrPage")}
        </button>
      )}
      {false && pdfDoc && (
        <button
          onClick={wrapWithExitEdit(() => setAddingType(addingType === "ocr" ? null : "ocr"))}
          style={{
            ...btn,
            background: addingType === "ocr" ? "#8b5cf6" : "#f1f5f9",
            borderColor: addingType === "ocr" ? "#8b5cf6" : "#e2e8f0",
            color: addingType === "ocr" ? "#fff" : "#64748b",
            fontWeight: addingType === "ocr" ? 700 : 500,
          }}
          disabled={ocrBusy || !pdfDoc}
        >
          {t("toolbar.ocrRegion")}
        </button>
      )}
      {pdfDoc && <div style={sep} />}
      {/* V12: Convert 下拉菜单 — Bug 5: 增加 Compress / Excel / JPG；click 触发而非 hover */}
      {pdfDoc && (
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowConvert((v) => !v)}
            style={{
              ...btn,
              background: "linear-gradient(135deg,#8b5cf6,#ec4899)",
              color: "#fff",
              fontWeight: 600,
            }}
          >
            {t("toolbar.convert")}
          </button>
          {showConvert && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 99 }}
                onClick={() => setShowConvert(false)}
              />
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: 4,
                  background: "#fff",
                  borderRadius: 8,
                  boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
                  border: "1px solid #e2e8f0",
                  zIndex: 100,
                  minWidth: 200,
                  overflow: "hidden",
                }}
              >
                {[
                  { key: "word", label: t("toolbar.toWord"), color: "#3b82f6", iconSvg: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14 2z M14 2v5h5 M8 13h8 M8 17h8 M8 9h2" },
                  { key: "compress", label: t("toolbar.compress"), color: "#f59e0b", iconSvg: "M21 8v8a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5z M9 12l2 2 4-4" },
                  { key: "excel", label: t("toolbar.toExcel"), color: "#10b981", iconSvg: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14 2z M14 2v5h5 M9 13l3 3 M12 13l-3 3 M15 13l3 3 M18 13l-3 3" },
                  { key: "jpg", label: t("postload.toJpg"), color: "#a855f7", iconSvg: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" },
                ].map((item) => (
                  <div
                    key={item.key}
                    onClick={() => {
                      setShowConvert(false);
                      if (!pdfDoc || !pdfBytesRef.current) return;
                      // Bug 5: 所有 convert 功能跳转 paywall，付费后才能下载
                      wrapWithExitEdit(() => onConvertClick(item.key))();
                    }}
                    style={{
                      display: "block",
                      padding: "10px 16px",
                      color: "#1e293b",
                      fontSize: 13,
                      cursor: "pointer",
                      borderBottom: "1px solid #f1f5f9",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={item.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d={item.iconSvg} />
                      </svg>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {pdfDoc && (
        <button
          onClick={wrapWithExitEdit(() => {
            if (docBlocks.length) setBlocks([]);
          })}
          style={{ ...btn, color: "#ef4444", borderColor: "#fecaca" }}
        >
          {t("toolbar.clear")}
        </button>
      )}
      {pdfDoc && (
        <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: 4 }}>
          {fileName} — p.{page}/{totalPages}
        </span>
      )}
    </div>
  );
}
