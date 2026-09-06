/**
 * ActionPanel — Document Action Panel / Context Workspace (Interaction Layer)
 *
 * 产品目标（Adobe Killer / Point & Understand）：
 *   用户点击一句话 → 右侧出现 Context Workspace → 展示当前选中文字 + Action Cards。
 *
 * 交互模型（AI 增强 Editor，不替代 Editor）：
 *   Editor 是 Workspace 的第一个 Action，而不是默认行为。
 *
 *   点击文字
 *     ↓
 *   Context Workspace（本组件）
 *     ├── 📝 Update Text  → 进入现有 TextEditOverlay（保留所有手工编辑能力）
 *     ├── 🌍 Translate    → 占位（未来）
 *     └── 💡 Understand   → 占位（未来）
 *
 * 第一版：只有 Update Text 真正动作；Translate / Explain 为占位（Coming Soon）。
 * 架构：Editor 只知道"选中了什么"（selectedText）+ "编辑意图"（pendingEdit），
 *       Update Text 通过 onUpdateText 回调把 intent 交给 PDFEditor 打开 overlay。
 *       本组件不改任何编辑核心 / Renderer / Document Model。
 */

import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";

interface ActionPanelProps {
  /** 点击 "Update Text" 时调用：用 pendingEdit 打开现有 TextEditOverlay */
  onUpdateText: (intent: {
    blockId: string;
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
    fontSize: number;
    lineId?: string;
    startGlyphIndex?: number;
    endGlyphIndex?: number;
  }) => void;
}

export function ActionPanel({ onUpdateText }: ActionPanelProps) {
  const { selectedText, setSelectedText, pendingEdit } = useEditor();
  const { t } = useI18n();

  // 无选中时整个面板隐藏（纯 Interaction，不占版面）
  if (!selectedText) return null;

  const preview = selectedText.length > 120
    ? selectedText.substring(0, 120) + "…"
    : selectedText;

  const handleUpdateText = () => {
    if (!pendingEdit) return;
    console.log("[ActionPanel] Update Text → open existing TextEditOverlay", {
      blockId: pendingEdit.blockId,
      text: pendingEdit.text.substring(0, 40),
    });
    onUpdateText(pendingEdit);
  };

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        borderLeft: "1px solid #e2e8f0",
        background: "#fff",
        padding: 16,
        fontSize: 13,
        color: "#334155",
        maxHeight: "calc(100vh - 80px)",
        overflowY: "auto",
      }}
    >
      {/* 头部：标题 + 关闭 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontWeight: 700,
            color: "#1e293b",
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {t("action.title")}
        </div>
        <button
          onClick={() => setSelectedText(null)}
          title="Close"
          style={{
            background: "none", border: "none", color: "#94a3b8",
            cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px",
          }}
        >
          ×
        </button>
      </div>

      {/* 主问题 */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "#0f172a",
          lineHeight: 1.4,
          marginBottom: 10,
        }}
      >
        {t("action.prompt")}
      </div>

      {/* 当前选中文字 */}
      <div
        style={{
          padding: "10px 12px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          color: "#475569",
          fontSize: 13,
          lineHeight: 1.5,
          marginBottom: 16,
          maxHeight: 120,
          overflowY: "auto",
        }}
      >
        “{preview}”
      </div>

      {/* Action Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* 📝 Update Text — 真正的动作，进入现有编辑 */}
        <button
          onClick={handleUpdateText}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            width: "100%",
            padding: "10px 12px",
            border: "1px solid #7c5cfc",
            borderRadius: 8,
            background: "rgba(124,92,252,0.06)",
            color: "#1e293b",
            fontSize: 14,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 16 }}>📝</span>
          <span style={{ flex: 1 }}>
            <span style={{ fontWeight: 700, display: "block", color: "#5b3fd4" }}>
              {t("action.updateText")}
            </span>
            <span style={{ fontSize: 12, color: "#64748b" }}>
              {t("action.updateTextDesc")}
            </span>
          </span>
        </button>

        {/* 🌍 Translate — 占位 */}
        <button
          onClick={() => console.log("[ActionPanel] Translate clicked (coming soon)")}
          title={t("action.comingSoon")}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            width: "100%",
            padding: "10px 12px",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#fff",
            color: "#1e293b",
            fontSize: 14,
            cursor: "pointer",
            textAlign: "left",
            opacity: 0.85,
          }}
        >
          <span style={{ fontSize: 16 }}>🌍</span>
          <span style={{ flex: 1 }}>
            <span style={{ fontWeight: 600, display: "block" }}>{t("action.translate")}</span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              {t("action.translateDesc")}
            </span>
          </span>
          <span style={{ fontSize: 10, color: "#cbd5e1", whiteSpace: "nowrap", marginTop: 2 }}>
            {t("action.comingSoon")}
          </span>
        </button>

        {/* 💡 Understand — 占位 */}
        <button
          onClick={() => console.log("[ActionPanel] Explain clicked (coming soon)")}
          title={t("action.comingSoon")}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            width: "100%",
            padding: "10px 12px",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#fff",
            color: "#1e293b",
            fontSize: 14,
            cursor: "pointer",
            textAlign: "left",
            opacity: 0.85,
          }}
        >
          <span style={{ fontSize: 16 }}>💡</span>
          <span style={{ flex: 1 }}>
            <span style={{ fontWeight: 600, display: "block" }}>{t("action.understand")}</span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              {t("action.understandDesc")}
            </span>
          </span>
          <span style={{ fontSize: 10, color: "#cbd5e1", whiteSpace: "nowrap", marginTop: 2 }}>
            {t("action.comingSoon")}
          </span>
        </button>
      </div>
    </div>
  );
}
