/**
 * LangSwitcher — Commit 4 +
 *
 * 顶部导航栏的语言切换器（EN | PT）。
 * 切换后写入 localStorage，刷新页面仍保留。
 */

import { useI18n } from "./I18nProvider";

export function LangSwitcher() {
  const { lang, setLang } = useI18n();
  const btn = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    background: active ? "#7c5cfc" : "transparent",
    color: active ? "#fff" : "#ccc",
    border: active ? "1px solid #7c5cfc" : "1px solid #444",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  });
  return (
    <div style={{ display: "flex", gap: 6, marginLeft: 16 }}>
      <button onClick={() => setLang("en")} style={btn(lang === "en")}>EN</button>
      <button onClick={() => setLang("pt")} style={btn(lang === "pt")}>PT</button>
    </div>
  );
}
