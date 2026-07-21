/**
 * I18nProvider — Commit 4 +
 *
 * 简单的 i18n Context，不引入 react-i18next 依赖。
 *
 * 语言检测优先级：
 *   1. URL query param ?lang=en|pt
 *   2. localStorage["pdfsail.lang"]
 *   3. navigator.language（pt* → pt，其他 → en）
 *   4. 默认 en
 *
 * 切换语言时写入 localStorage 并触发重新渲染。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { translations, type Lang, type TranslationKey } from "./translations";

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = "pdfsail.lang";

function detectLang(): Lang {
  // 1. URL query param
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("lang");
    if (fromUrl === "en" || fromUrl === "pt") return fromUrl;
  }
  // 2. localStorage
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "pt") return saved;
  }
  // 3. navigator.language
  if (typeof navigator !== "undefined") {
    const nav = navigator.language.toLowerCase();
    if (nav.startsWith("pt")) return "pt";
  }
  // 4. default
  return "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, l);
    }
  }, []);

  // 同步到 <html lang> 属性，便于 SEO / 辅助技术
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
    }
  }, [lang]);

  const t = useCallback(
    (key: TranslationKey) => {
      const dict = translations[lang] as Record<string, string>;
      return dict[key] ?? key;
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
