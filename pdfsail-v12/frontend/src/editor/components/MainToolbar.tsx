/**
 * MainToolbar — Commit 2
 *
 * 顶部工具栏（Upload / Workspace / Tools / OCR / Convert dropdown / Export / Clear）。
 * 从 PDFEditor.tsx L662-744 提取。
 *
 * State 来自 useEditor()，跨 domain 回调与 ref 通过 props 注入：
 *   handleUpload / addBlock / imageInputRef / handleImageSelect /
 *   handleOCR / pdfBytesRef / processInline / handleExport
 */

import type { RefObject } from "react";
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
  handleExport: () => void;
}

export function MainToolbar({
  handleUpload,
  addBlock,
  imageInputRef,
  handleImageSelect,
  handleOCR,
  pdfBytesRef,
  processInline,
  handleExport,
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
    showTools,
    setShowTools,
    setShowCompressOptions,
    setShowSplitOptions,
    setShowRotateOptions,
    setShowPageNumOptions,
    docBlocks,
    setBlocks,
    fileName,
    page,
    totalPages,
  } = useEditor();
  const { t } = useI18n();

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
        {t("toolbar.upload")}
        <input
          type="file"
          accept=".pdf"
          onChange={handleUpload}
          style={{ display: "none" }}
        />
      </label>
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
      <div style={sep} />
      <button
        onClick={() =>
          addBlock("text", {
            text: "Edit me",
            fontSize: textFormat.fontSize,
            fontFamily: textFormat.fontFamily,
            color: textFormat.color,
          })
        }
        style={btn}
      >
        {t("toolbar.text")}
      </button>
      <button onClick={() => imageInputRef.current?.click()} style={btn}>
        {t("toolbar.image")}
      </button>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageSelect}
        style={{ display: "none" }}
      />
      <button
        onClick={() => setAddingType(addingType === "highlight" ? null : "highlight")}
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
      <button
        onClick={() => setAddingType(addingType === "redact" ? null : "redact")}
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
      <button onClick={() => setShowSignature(true)} style={btn}>
        {t("toolbar.signature")}
      </button>
      <button
        onClick={() => setAddingType(addingType === "annotate" ? null : "annotate")}
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
      <div style={sep} />
      <button
        onClick={() => setShowTextLayer((v) => !v)}
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
      <div style={sep} />
      <button
        onClick={handleUndo}
        style={{ ...btn, opacity: undoRef.canUndo ? 1 : 0.35 }}
        disabled={!undoRef.canUndo}
      >
        {t("toolbar.undo")}
      </button>
      <button
        onClick={handleRedo}
        style={{ ...btn, opacity: undoRef.canRedo ? 1 : 0.35 }}
        disabled={!undoRef.canRedo}
      >
        {t("toolbar.redo")}
      </button>
      <div style={sep} />
      <button
        onClick={handleOCR}
        style={{ ...btn, background: ocrBusy ? "#94a3b8" : "#f59e0b", color: "#fff" }}
        disabled={ocrBusy || !pdfDoc}
      >
        {ocrBusy ? t("toolbar.ocrBusy") : t("toolbar.ocrPage")}
      </button>
      <button
        onClick={() => setAddingType(addingType === "ocr" ? null : "ocr")}
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
      <div style={sep} />
      <div style={{ position: "relative" }}>
        <button
          onClick={() => setShowTools((v) => !v)}
          style={{
            ...btn,
            background: "linear-gradient(135deg,#8b5cf6,#ec4899)",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          {t("toolbar.convert")}
        </button>
        {showTools && (
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
            onMouseLeave={() => setShowTools(false)}
          >
            {[
              { label: t("toolbar.compress"), key: "compress", needsOpts: true },
              { label: t("toolbar.split"), key: "split", needsOpts: true },
              { label: t("toolbar.rotate"), key: "rotate", needsOpts: true },
              { label: t("toolbar.pageNum"), key: "pagenum", needsOpts: true },
              { label: t("toolbar.toWord"), key: "word", needsOpts: false },
              { label: t("toolbar.toExcel"), key: "excel", needsOpts: false },
              { label: t("toolbar.watermark"), key: "watermark", needsOpts: false },
              { label: t("toolbar.merge"), key: "merge", needsOpts: false },
            ].map((item) => {
              const handleClick = () => {
                setShowTools(false);
                if (item.key === "merge") {
                  window.location.href = "/merge-pdf";
                  return;
                }
                if (!pdfDoc || !pdfBytesRef.current) return;
                if (item.needsOpts) {
                  if (item.key === "compress") setShowCompressOptions(true);
                  else if (item.key === "split") setShowSplitOptions(true);
                  else if (item.key === "rotate") setShowRotateOptions(true);
                  else if (item.key === "pagenum") setShowPageNumOptions(true);
                  return;
                }
                if (item.key === "word") processInline("word");
                else if (item.key === "excel") processInline("excel");
                else if (item.key === "watermark") processInline("watermark");
              };
              return (
                <div
                  key={item.key}
                  onClick={handleClick}
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
                  {item.label}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <button
        onClick={() => {
          if (docBlocks.length) setBlocks([]);
        }}
        style={{ ...btn, color: "#ef4444", borderColor: "#fecaca" }}
      >
        {t("toolbar.clear")}
      </button>
      {pdfDoc && (
        <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: 4 }}>
          {fileName} — p.{page}/{totalPages}
        </span>
      )}
    </div>
  );
}
