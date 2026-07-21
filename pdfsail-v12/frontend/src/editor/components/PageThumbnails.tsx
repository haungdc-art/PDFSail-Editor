/**
 * PageThumbnails — Commit 2
 *
 * 左侧缩略图面板（可收展）。
 * 从 PDFEditor.tsx L656-713 提取。
 *
 * State 全部来自 useEditor()，无 props。
 */

import { useEditor } from "../core/EditorProvider";

export function PageThumbnails() {
  const {
    pdfDoc,
    thumbnailCol,
    setThumbnailCol,
    thumbnails,
    page,
    setPage,
  } = useEditor();

  if (!pdfDoc) return null;

  return (
    <div
      style={{
        width: thumbnailCol ? 150 : 28,
        flexShrink: 0,
        background: "#f8fafc",
        borderRight: "1px solid #e2e8f0",
        transition: "width 0.2s",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {thumbnailCol ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 10px 4px",
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b" }}>
              Pages {thumbnails.length > 0 ? `(${thumbnails.length})` : ""}
            </span>
            <button
              onClick={() => setThumbnailCol(false)}
              style={{
                background: "none",
                border: "none",
                color: "#94a3b8",
                cursor: "pointer",
                fontSize: 12,
                padding: "2px 6px",
                borderRadius: 3,
                lineHeight: 1,
              }}
            >
              ◀
            </button>
          </div>
          <div
            style={{
              padding: "4px 8px 10px",
              maxHeight: "calc(100vh - 140px)",
              overflowY: "auto",
            }}
          >
            {thumbnails.map((url, i) => {
              const pg = i + 1;
              const isActive = pg === page;
              return (
                <div
                  key={pg}
                  onClick={() => setPage(pg)}
                  style={{
                    cursor: "pointer",
                    marginBottom: 6,
                    borderRadius: 6,
                    overflow: "hidden",
                    border: isActive
                      ? "2px solid #3b82f6"
                      : "2px solid transparent",
                    boxShadow: isActive
                      ? "0 0 0 1px #3b82f6"
                      : "0 1px 3px rgba(0,0,0,0.08)",
                    transition: "border 0.15s",
                    position: "relative",
                  }}
                >
                  {url ? (
                    <img
                      src={url}
                      alt={`Page ${pg}`}
                      style={{ display: "block", width: "100%", height: "auto" }}
                    />
                  ) : (
                    <div
                      style={{
                        width: "100%",
                        aspectRatio: "0.707",
                        background: "#e2e8f0",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#94a3b8",
                        fontSize: 10,
                      }}
                    >
                      —
                    </div>
                  )}
                  <div
                    style={{
                      position: "absolute",
                      bottom: 2,
                      right: 2,
                      background: isActive ? "#3b82f6" : "rgba(0,0,0,0.5)",
                      color: "#fff",
                      fontSize: 9,
                      padding: "1px 5px",
                      borderRadius: 3,
                      fontWeight: isActive ? 700 : 500,
                    }}
                  >
                    {pg}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "8px 0",
          }}
        >
          <button
            onClick={() => setThumbnailCol(true)}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              fontSize: 14,
              padding: "4px",
              lineHeight: 1,
            }}
          >
            ▶
          </button>
          <span
            style={{
              fontSize: 9,
              color: "#94a3b8",
              writingMode: "vertical-rl",
              marginTop: 8,
            }}
          >
            Pages
          </span>
        </div>
      )}
    </div>
  );
}
