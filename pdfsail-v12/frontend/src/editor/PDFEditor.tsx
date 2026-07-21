import React, { useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";
import type { Block, TextBlock } from "./types";
import { LockCoordSystem } from "./coord";
import { EditorProvider, useEditor } from "./core/EditorProvider";
import { PatchBlocksCommand } from "./core/engine";
import { OptionModals } from "./components/OptionModals";
import { PageThumbnails } from "./components/PageThumbnails";
import { MainToolbar } from "./components/MainToolbar";
import { SidePanel } from "./components/SidePanel";
import { PDFCanvas } from "./components/PDFCanvas";
import { DownloadButton } from "./components/DownloadButton";
import { PostLoadModal } from "./components/PostLoadModal";
// Feature hooks (Commit 3)
import { useOCR } from "./features/useOCR";
import { usePageOps } from "./features/usePageOps";
import { useExport } from "./features/useExport";
import { usePayment } from "./features/usePayment";
import { useInlineTools } from "./features/useInlineTools";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export default function PDFEditor() {
  return (
    <EditorProvider>
      <PDFEditorInner />
    </EditorProvider>
  );
}

function PDFEditorInner() {
  // All editor state unified via useEditor() (Commit 1 / Step 7)
  const {
    // document
    page, setPage,
    totalPages, setTotalPages,
    pdfDoc, setPdfDoc,
    fileName, setFileName,
    thumbnails, setThumbnails,
    thumbnailCol, setThumbnailCol,
    renderThumbnails,
    // selection
    docBlocks, setDocBlocks,
    textItems, setTextItems,
    showTextLayer, setShowTextLayer,
    selectedBlockId, setSelectedBlockId,
    editingBlock, setEditingBlock,
    ocrSelect, setOcrSelect,
    undoRef, setBlocks, handleUndo, handleRedo, clearHistory,
    // tool
    textFormat, setTextFormat,
    highlightFormat, setHighlightFormat,
    annoFormat, setAnnoFormat,
    showTools, setShowTools,
    showSignature, setShowSignature,
    addingType, setAddingType,
    // workspace
    workspaceMode, showIntentModal, wsAction, wsHints, wsActionsDone, wsShowFlow,
    setWorkspaceMode, setShowIntentModal, setWsAction, setWsHints, setWsActionsDone, setWsShowFlow,
    generateLocalHints,
    // operation
    processingTool, setProcessingTool, processingLog, setProcessingLog,
    ocrBusy, setOcrBusy, showPayModal, setShowPayModal,
    showCompressOptions, setShowCompressOptions,
    showSplitOptions, setShowSplitOptions,
    showRotateOptions, setShowRotateOptions,
    showPageNumOptions, setShowPageNumOptions,
    splitMode, setSplitMode, splitRange, setSplitRange,
    rotateDeg, setRotateDeg, rotateMode, setRotateMode,
    pageNumOpts, setPageNumOpts, compressQuality, setCompressQuality,
  } = useEditor();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const coordRef = useRef<LockCoordSystem | null>(null);
  const dragRef = useRef<{ id: string; ox: number; oy: number; ox0: number; oy0: number } | null>(null);
  const resizeRef = useRef<{ id: string; startX: number; startY: number; initW: number; initH: number } | null>(null);
  const cssScaleRef = useRef(1); // canvas.clientWidth / canvas.width
  const pdfBytesRef = useRef<ArrayBuffer | null>(null);
  const pdfLibDocRef = useRef<PDFDocument | null>(null);
  // Commit 4: drag/resize 开始时的 blocks snapshot，用于 mouseup 时 push 一个 PatchBlocksCommand
  const dragStartBlocksRef = useRef<Block[] | null>(null);
  // Commit 4+: 加载完成后的引导弹框
  const [showPostLoadModal, setShowPostLoadModal] = useState(false);

  // ── Feature hooks (Commit 3) ──
  const { handleOCR, handleOCRRegion } = useOCR({ canvasRef, cssScaleRef });
  const { handleAddBlankPage, handleDeletePage, handleMovePageUp, handleMovePageDown } = usePageOps({ pdfLibDocRef, pdfBytesRef });
  const { handleExport } = useExport({ coordRef, pdfBytesRef, cssScaleRef });
  const { handleStripePay, handlePaypalPay } = usePayment({ handleExport });
  const { processInline } = useInlineTools({ pdfBytesRef, coordRef });

  // pushUndo + setBlocks migrated to useSelection (Commit 1 / Step 5)

  // 选中 block 时同步工具栏（跨 tool/selection domain，暂留此处）
  useEffect(() => {
    if (!selectedBlockId) return;
    const b = docBlocks.find((x) => x.id === selectedBlockId);
    if (b && b.type === "text") {
      setTextFormat((prev) => ({
        fontFamily: b.fontFamily || prev.fontFamily,
        fontSize: b.fontSize || prev.fontSize,
        color: b.color || prev.color,
      }));
    }
  }, [selectedBlockId]);

  // handleUndo + handleRedo + Ctrl+Z listener migrated to useSelection (Commit 1 / Step 5)

  // Render PDF
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let done = false;
    (async () => {
      const pg = await pdfDoc.getPage(page);
      const vp = pg.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current!;
      canvas.width = vp.width;
      canvas.height = vp.height;
      await pg.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      if (done) return;

      // CSS display scale — canvas pixel vs CSS display
      cssScaleRef.current = canvas.clientWidth / canvas.width;

      coordRef.current = new LockCoordSystem({ scale: 1.5, width: vp.width, height: vp.height });

      // Extract text → CSS display coords (canvas px × cssScale)
      const tc = await pg.getTextContent();
      const s = cssScaleRef.current;
      setTextItems(
        tc.items.filter((i: any) => i.str?.trim()).map((i: any) => {
          const c = coordRef.current!.fromPDF(i);
          return { id: crypto.randomUUID(), text: i.str, x: c.x * s, y: c.y * s, w: c.w * s, h: c.h * s, fontSize: c.fontSize * s };
        })
      );
    })();
    return () => { done = true; };
  }, [pdfDoc, page]);

  // Drag + Resize (Commit 4: drag 期间高频 setDocBlocks 不进 history；mouseup 时 push 一个 PatchBlocksCommand)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      // drag/resize 首次触发时，通过 setDocBlocks updater 拿 latest state（no-op 返回），记录 prev snapshot
      if ((dragRef.current || resizeRef.current) && !dragStartBlocksRef.current) {
        setDocBlocks((prev) => {
          dragStartBlocksRef.current = JSON.parse(JSON.stringify(prev));
          return prev;
        });
      }
      if (dragRef.current) {
        setDocBlocks((prev) =>
          prev.map((b) =>
            b.id === dragRef.current!.id
              ? { ...b, x: dragRef.current!.ox0 + e.clientX - dragRef.current!.ox, y: dragRef.current!.oy0 + e.clientY - dragRef.current!.oy }
              : b
          )
        );
      }
      if (resizeRef.current) {
        setDocBlocks((prev) =>
          prev.map((b) =>
            b.id === resizeRef.current!.id
              ? { ...b, w: Math.max(30, resizeRef.current!.initW + e.clientX - resizeRef.current!.startX), h: Math.max(30, resizeRef.current!.initH + e.clientY - resizeRef.current!.startY) }
              : b,
          )
        );
      }
    };
    const up = () => {
      // drag/resize 结束：push 一个 PatchBlocksCommand(prev, current)，让此次操作进入 undo 历史
      if (dragStartBlocksRef.current) {
        const prevSnapshot = dragStartBlocksRef.current;
        dragStartBlocksRef.current = null;
        let pushed = false;
        setDocBlocks((current) => {
          if (!pushed) {
            undoRef.push(new PatchBlocksCommand(prevSnapshot, current));
            pushed = true;
          }
          return current; // no-op
        });
      }
      dragRef.current = null;
      resizeRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadPdfFromArrayBuffer(await file.arrayBuffer(), file.name);
  };

  /**
   * 从 ArrayBuffer 加载 PDF（Commit 4+：支持 ?file=URL 跨域加载）
   * 被 handleUpload（本地文件）和 loadFromUrl（远程 URL）共用。
   */
  const loadPdfFromArrayBuffer = async (buf: ArrayBuffer, name: string) => {
    setFileName(name);
    setDocBlocks([]);
    setTextItems([]);
    clearHistory(); // Commit 4: 新文档加载，清空 undo/redo 历史
    pdfBytesRef.current = buf;
    pdfLibDocRef.current = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0), cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
    setPdfDoc(pdf);
    setTotalPages(pdf.numPages);
    setPage(1);
    renderThumbnails(pdf);
    if (workspaceMode) setShowIntentModal(true);
    // Commit 4+: 加载完成后显示引导弹框
    setShowPostLoadModal(true);
  };

  // Commit 4+: 检测 URL ?file=URL 参数，自动从远程加载 PDF（支持从 pdfsail.com/en/edit-pdf 跳转）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fileUrl = params.get("file");
    if (!fileUrl) return;
    (async () => {
      try {
        const resp = await fetch(fileUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        // 从 URL 推断文件名
        const name = fileUrl.split("/").pop()?.split("?")[0] || "document.pdf";
        await loadPdfFromArrayBuffer(buf, name);
      } catch (err) {
        console.error("Failed to load PDF from URL:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // renderThumbnails migrated to useDocument (Commit 1 / Step 6)
  // OCR / PageOps / Export / Payment / InlineTools migrated to features/ (Commit 3)

  const updateSelectedFormat = (patch: Partial<{ fontFamily: string; fontSize: number; color: string }>) => {
    if (!selectedBlockId) return;
    setBlocks((prev) => prev.map((b) => b.id === selectedBlockId && b.type === "text" ? { ...b, ...patch } as TextBlock : b));
  };

  const addBlock = (type: Block["type"], extra: any = {}) => {
    setBlocks((prev) => [...prev, { id: uuid(), type, page, x: 100, y: 100, w: 100, h: 30, ...extra } as Block]);
  };

  const imageInputRef = useRef<HTMLInputElement>(null);
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      addBlock("image", { src: reader.result as string, w: 160, h: 160 });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // resize drag state moved up (Commit 4: TDZ fix)

  const pageBlocks = docBlocks.filter((b) => b.page === page);

  // generateLocalHints + origUpload migrated to useWorkspaceState (Commit 1 / Step 2)

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", boxShadow: "0 2px 12px rgba(0,0,0,0.06)", overflow: "hidden" }}>
      {/* ── 顶部 Header Bar：右上角 Download 入口 ── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 20px",
        background: "linear-gradient(90deg,#f8fafc,#f1f5f9)",
        borderBottom: "1px solid #e2e8f0",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>📄 PDFSail Editor</span>
          {pdfDoc && (
            <span style={{ fontSize: 12, color: "#64748b" }}>{fileName}</span>
          )}
        </div>
        <DownloadButton handleExport={handleExport} disabled={!pdfDoc} />
      </div>
      <div style={{ display: "flex" }}>
        {/* ── 左侧缩略图面板（可收展） ── */}
        <PageThumbnails />

        {/* ── 中间：画布区 ── */}
        <div style={{ flex: 1 }}>
        {/* TOOLBAR */}
        <MainToolbar
          handleUpload={handleUpload}
          addBlock={addBlock}
          imageInputRef={imageInputRef}
          handleImageSelect={handleImageSelect}
          handleOCR={handleOCR}
          pdfBytesRef={pdfBytesRef}
          processInline={processInline}
          handleExport={handleExport}
        />

        {/* CANVAS */}
        <PDFCanvas
          canvasRef={canvasRef}
          wrapperRef={wrapperRef}
          dragRef={dragRef}
          resizeRef={resizeRef}
          addBlock={addBlock}
          handleOCRRegion={handleOCRRegion}
        />
      </div>

      {/* ── 右侧：统一上下文面板 ── */}
      <SidePanel
        handleAddBlankPage={handleAddBlankPage}
        handleDeletePage={handleDeletePage}
        handleMovePageUp={handleMovePageUp}
        handleMovePageDown={handleMovePageDown}
        updateSelectedFormat={updateSelectedFormat}
        processInline={processInline}
        handleExport={handleExport}
      />

      <OptionModals
        addBlock={addBlock}
        handleStripePay={handleStripePay}
        handlePaypalPay={handlePaypalPay}
        processInline={processInline}
      />

      {showPostLoadModal && (
        <PostLoadModal
          onClose={() => setShowPostLoadModal(false)}
          onEditText={() => {
            setShowPostLoadModal(false);
            setShowTextLayer(true);
          }}
          onCompress={() => {
            setShowPostLoadModal(false);
            setShowCompressOptions(true);
          }}
          onToWord={() => {
            setShowPostLoadModal(false);
            processInline("word");
          }}
          onToJpg={() => {
            setShowPostLoadModal(false);
            processInline("jpg");
          }}
        />
      )}

      </div>
    </div>
  );
}
