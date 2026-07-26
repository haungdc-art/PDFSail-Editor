/**
 * PostLoadModal — Commit 4 +
 *
 * PDF 加载完成后显示的引导弹框：
 *   - Edit Text → 关闭弹框，激活文本编辑模式（showTextLayer = true）
 *   - Compress PDF → 关闭弹框，打开 Compress 选项弹框
 *   - PDF to Word → 直接调用 processInline("word")
 *   - PDF to JPG → 直接调用 processInline("jpg")
 *
 * 集成 i18n（en + pt-BR）。
 */

import { useI18n } from "../../i18n/I18nProvider";

interface PostLoadModalProps {
  onClose: () => void;
  onEditText: () => void;
  onCompress: () => void;
  onToWord: () => void;
  onToJpg: () => void;
}

export function PostLoadModal({ onClose, onEditText, onCompress, onToWord, onToJpg }: PostLoadModalProps) {
  const { t } = useI18n();

  const cards = [
    {
      icon: "✏️",
      title: t("postload.editText"),
      desc: t("postload.editTextDesc"),
      color: "#3b82f6",
      credits: 199,
      price: "$1.99",
      onClick: onEditText,
    },
    {
      icon: "📦",
      title: t("postload.compress"),
      desc: t("postload.compressDesc"),
      color: "#f59e0b",
      credits: 199,
      price: "$1.99",
      onClick: onCompress,
    },
    {
      icon: "📝",
      title: t("postload.toWord"),
      desc: t("postload.toWordDesc"),
      color: "#10b981",
      credits: 199,
      price: "$1.99",
      onClick: onToWord,
    },
    {
      icon: "🖼",
      title: t("postload.toJpg"),
      desc: t("postload.toJpgDesc"),
      color: "#8b5cf6",
      credits: 199,
      price: "$1.99",
      onClick: onToJpg,
    },
  ];

  const perks = [
    "✓ Preview before payment",
    "✓ No subscription",
    "✓ Secure processing",
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9998,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: "32px 36px",
          width: 520,
          maxWidth: "90vw",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
          <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 700, color: "#1e293b" }}>
            {t("postload.title")}
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
            {t("postload.subtitle")}
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {cards.map((c) => (
            <button
              key={c.title}
              onClick={c.onClick}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 6,
                padding: 16,
                background: "#fff",
                border: `2px solid ${c.color}22`,
                borderRadius: 10,
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = c.color;
                e.currentTarget.style.background = `${c.color}08`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = `${c.color}22`;
                e.currentTarget.style.background = "#fff";
              }}
            >
              <span style={{ fontSize: 24 }}>{c.icon}</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>{c.title}</span>
              <span style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4 }}>{c.desc}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: c.color, marginTop: 2 }}>
                {c.credits} Credits ≈ {c.price}
              </span>
            </button>
          ))}
        </div>

        <div
          style={{
            marginTop: 16,
            padding: "12px 16px",
            background: "#f0fdf4",
            borderRadius: 8,
            border: "1px solid #bbf7d0",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {perks.map((p) => (
            <span key={p} style={{ fontSize: 12, color: "#15803d", fontWeight: 600 }}>
              {p}
            </span>
          ))}
        </div>

        <div style={{ textAlign: "center", marginTop: 20 }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 20px",
              background: "transparent",
              color: "#64748b",
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t("postload.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
