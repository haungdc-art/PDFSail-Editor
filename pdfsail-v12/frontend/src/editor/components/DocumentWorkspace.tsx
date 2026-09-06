/**
 * DocumentWorkspace — Document Workspace (Interaction Layer / Sprint B 终态)
 *
 * 产品定位转变：从 "PDF Editor" 到 "AI understands your document."
 *
 * 布局（四段式，未来几乎不用推翻）：
 *   Selection     当前选中文字
 *   Understanding 对选区的理解（Type / Language / Selection）—— 今天为占位，未来 AI 的锚点
 *   Actions       Primary(Update Text) + AI(Translate / Explain)
 *   Result        未来 AI 结果直接显示在此（不弹窗）
 *
 * 交互模型（AI 增强 Editor，不替代 Editor）：
 *   Editor 是 Primary Action，而不是默认行为。
 *   Update Text → 进入现有 TextEditOverlay（保留全部手工编辑能力）。
 *
 * 第一版范围：
 *   - Understanding：全部占位/假数据，不接 AI。
 *   - Update Text：真正动作，进入现有编辑。
 *   - Translate / Explain：假按钮，Result 区显示占位。
 *
 * 架构：Editor 只知道"选中了什么"（selectedText）+ "编辑意图"（pendingEdit），
 *       Update Text 通过 onUpdateText 回调把 intent 交给 PDFEditor 打开 overlay。
 *       本组件不改任何编辑核心 / Renderer / Document Model / Kernel。
 */

import { useEffect, useState } from "react";
import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";
import { recordWorkspaceEvent } from "./workspace-telemetry";

interface DocumentWorkspaceProps {
  /** M7.7-003: Workspace 意图。仅 "ai"（Ask AI）时打开；Edit Text 永远 inline（不弹 Workspace）。 */
  intent: "ai" | null;
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

/** 未来动作类型（现在只有 translate / explain 两个占位） */
type FutureAction = "translate" | "explain";

export function DocumentWorkspace({ intent, onUpdateText }: DocumentWorkspaceProps) {
  const { selectedText, setSelectedText, pendingEdit, saveStatus, setSaveStatus } = useEditor();
  const { t } = useI18n();
  // Result 区：未来 AI 结果直接显示在这里（不弹窗）。
  const [result, setResult] = useState<{ kind: FutureAction; text: string } | null>(null);

  // B-3 埋点：Workspace 出现
  useEffect(() => {
    if (selectedText) {
      recordWorkspaceEvent("workspace_open", { textLen: selectedText.length });
    }
  }, [selectedText]);

  // M7.7-003: 只有 "ai" 意图才打开 Workspace（AI Document Workspace）。
  // 拖选/点击编辑一律 inline；不再因任何 selection 而弹出右侧面板（不挤压 PDF）。
  if (intent !== "ai" || !selectedText) return null;

  const preview = selectedText.length > 140
    ? selectedText.substring(0, 140) + "…"
    : selectedText;

  const handleUpdateText = () => {
    if (!pendingEdit) return;
    console.log("[DocumentWorkspace] Update Text → open existing TextEditOverlay", {
      blockId: pendingEdit.blockId,
      text: pendingEdit.text.substring(0, 40),
    });
    // B-3 埋点：Update Text 点击
    recordWorkspaceEvent("update_click", { blockId: pendingEdit.blockId, textLen: pendingEdit.text.length });
    onUpdateText(pendingEdit);
  };

  // 未来动作占位：点击后在 Result 区显示"即将支持"，不弹窗。
  const handleFutureAction = (kind: FutureAction) => {
    console.log(`[DocumentWorkspace] ${kind} clicked (coming soon)`);
    // B-3 埋点：Translate / Explain 点击
    recordWorkspaceEvent(kind === "translate" ? "translate_click" : "explain_click", {
      blockId: pendingEdit?.blockId,
      textLen: pendingEdit?.text.length,
    });
    setResult({ kind, text: t("action.comingSoon") });
  };

  // ── Understanding：今天为占位/假数据，未来 AI 的锚点 ──
  const understandingRows: { label: string; value: string }[] = [
    { label: t("ws.type"), value: t("ws.typePlaceholder") },
    { label: t("ws.language"), value: t("ws.languagePlaceholder") },
    { label: t("ws.selectionKind"), value: t("ws.paragraph") },
  ];

  return (
    <div
      data-workspace="1"
      style={{
        width: 290,
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
      {/* 头部：Document Workspace + 关闭 */}
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
          {t("ws.title")}
        </div>
        <button
          onClick={() => {
            setSelectedText(null);
            setResult(null);
            setSaveStatus("idle");
          }}
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
          marginBottom: 14,
        }}
      >
        {t("ws.prompt")}
      </div>

      {/* B-2：保存成功反馈（保存后不"什么都不发生"） */}
      {saveStatus === "saved" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 8,
            color: "#15803d",
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          ✓ {t("ws.updatedSuccess")}
        </div>
      )}

      {/* ── Selection ── */}
      <Section title={t("ws.selection")}>
        <div
          style={{
            padding: "10px 12px",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            color: "#475569",
            fontSize: 13,
            lineHeight: 1.5,
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          “{preview}”
        </div>
      </Section>

      {/* ── Understanding（未来 AI 的锚点，今天占位） ── */}
      <Section title={t("ws.understanding")}>
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {understandingRows.map((row, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                background: i % 2 === 0 ? "#fafafa" : "#fff",
                borderBottom: i < understandingRows.length - 1 ? "1px solid #eef2f7" : "none",
              }}
            >
              <span style={{ color: "#94a3b8", fontSize: 12 }}>{row.label}</span>
              <span style={{ color: "#1e293b", fontWeight: 500, fontSize: 13 }}>{row.value}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "#cbd5e1",
          }}
        >
          {t("ws.understandingHint")}
        </div>
      </Section>

      {/* ── Actions ── */}
      <Section title={t("ws.actions")}>
        {/* Primary Action: Update Text */}
        <button
          onClick={handleUpdateText}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            width: "100%",
            padding: "12px",
            border: "1px solid #7c5cfc",
            borderRadius: 8,
            background: "linear-gradient(135deg,#7c5cfc,#9f7aea)",
            color: "#fff",
            fontSize: 14,
            cursor: "pointer",
            textAlign: "left",
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>📝</span>
          <span style={{ flex: 1 }}>
            <span style={{ fontWeight: 700, display: "block" }}>
              {t("action.updateText")}
            </span>
            <span style={{ fontSize: 12, opacity: 0.85 }}>
              {t("action.updateTextDesc")}
            </span>
          </span>
        </button>

        {/* AI Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            onClick={() => handleFutureAction("translate")}
            style={{
              display: "flex",
              alignItems: "center",
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
            }}
          >
            <span style={{ fontSize: 16 }}>🌍</span>
            <span style={{ fontWeight: 600, flex: 1 }}>{t("action.translate")}</span>
            <span style={{ fontSize: 10, color: "#cbd5e1" }}>{t("action.comingSoon")}</span>
          </button>
          <button
            onClick={() => handleFutureAction("explain")}
            style={{
              display: "flex",
              alignItems: "center",
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
            }}
          >
            <span style={{ fontSize: 16 }}>💡</span>
            <span style={{ fontWeight: 600, flex: 1 }}>{t("action.understand")}</span>
            <span style={{ fontSize: 10, color: "#cbd5e1" }}>{t("action.comingSoon")}</span>
          </button>
        </div>
      </Section>

      {/* ── Result（未来 AI 结果直接显示，不弹窗） ── */}
      <Section title={t("ws.result")}>
        {result ? (
          <div
            style={{
              padding: "10px 12px",
              background: "#faf5ff",
              border: "1px solid #e9d5ff",
              borderRadius: 8,
              color: "#4c1d95",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {result.text}
          </div>
        ) : (
          <div
            style={{
              padding: "10px 12px",
              border: "1px dashed #e2e8f0",
              borderRadius: 8,
              color: "#cbd5e1",
              fontSize: 12,
            }}
          >
            {t("ws.resultPlaceholder")}
          </div>
        )}
      </Section>
    </div>
  );
}

/** 小节容器：标题 + 内容 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "#94a3b8",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
