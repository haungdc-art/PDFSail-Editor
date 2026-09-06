/**
 * DocumentActions — Document Actions Workspace (Interaction Layer)
 *
 * 产品目标（Adobe Killer / Point & Understand）：
 *   用户点击一句话 → 右侧出现 Document Actions → 展示当前选中文字 + 动作。
 *
 * 命名原则：用户不是在操作软件，而是在操作文档。
 *   有选区时：What would you like to do with this selection?
 *
 * 交互模型（AI 增强 Editor，不替代 Editor）：
 *   Editor 是 Primary Action，而不是默认行为。
 *
 *   点击文字
 *     ↓
 *   Document Actions
 *     ├── Primary: 📝 Update Text  → 进入现有 TextEditOverlay（保留全部手工编辑）
 *     └── AI:       🌍 Translate   → 占位（未来，结果直接显示在 Result 区）
 *                  💡 Explain      → 占位（未来，结果直接显示在 Result 区）
 *
 * 布局（选择 → 动作 → 结果）：
 *   Selected Text
 *   ─────────────
 *   Actions
 *   ─────────────
 *   Result        ← 未来 AI 结果直接显示在此（不弹窗）
 *
 * 第一版：只有 Update Text 真正动作；Translate / Explain 为占位。
 * 架构：Editor 只知道"选中了什么"（selectedText）+ "编辑意图"（pendingEdit），
 *       Update Text 通过 onUpdateText 回调把 intent 交给 PDFEditor 打开 overlay。
 *       本组件不改任何编辑核心 / Renderer / Document Model。
 */

import { useState } from "react";
import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";

interface DocumentActionsProps {
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

export function DocumentActions({ onUpdateText }: DocumentActionsProps) {
  const { selectedText, setSelectedText, pendingEdit } = useEditor();
  const { t } = useI18n();
  // Result 区：未来 AI 结果直接显示在这里（不弹窗）。
  const [result, setResult] = useState<{ kind: FutureAction; text: string } | null>(null);

  // 无选中时整个面板隐藏（纯 Interaction，不占版面）
  if (!selectedText) return null;

  const preview = selectedText.length > 140
    ? selectedText.substring(0, 140) + "…"
    : selectedText;

  const handleUpdateText = () => {
    if (!pendingEdit) return;
    console.log("[DocumentActions] Update Text → open existing TextEditOverlay", {
      blockId: pendingEdit.blockId,
      text: pendingEdit.text.substring(0, 40),
    });
    onUpdateText(pendingEdit);
  };

  // 未来动作占位：点击后在 Result 区显示"即将支持"，不弹窗。
  const handleFutureAction = (kind: FutureAction) => {
    console.log(`[DocumentActions] ${kind} clicked (coming soon)`);
    setResult({ kind, text: t("action.comingSoon") });
  };

  return (
    <div
      style={{
        width: 280,
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
          onClick={() => {
            setSelectedText(null);
            setResult(null);
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

      {/* 主问题：有选区时用 "this selection" */}
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

      {/* Selected Text */}
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
          {t("action.selected")}
        </div>
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
      </div>

      {/* Actions */}
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
          {t("action.actions")}
        </div>

        {/* Primary Action: Update Text（视觉突出，80~90% 用户点击文字就是为了修改） */}
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

        {/* AI Actions（次级） */}
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
      </div>

      {/* Result 区：未来 AI 结果直接显示在此（不弹窗） */}
      <div style={{ marginTop: 4 }}>
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
          {t("action.result")}
        </div>
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
            {t("action.resultPlaceholder")}
          </div>
        )}
      </div>
    </div>
  );
}
