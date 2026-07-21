import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { routes, RouteConfig } from "./routing/routes";
import { I18nProvider } from "./i18n/I18nProvider";
import { LangSwitcher } from "./i18n/LangSwitcher";

function renderRoute(route: RouteConfig) {
  return (
    <Route
      key={route.path}
      path={route.path}
      element={route.element}
    />
  );
}

export default function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Navigation */}
          <nav
            style={{
              background: "#1a1a2e",
              color: "#fff",
              padding: "16px 24px",
              display: "flex",
              alignItems: "center",
              gap: 32,
            }}
          >
            <a
              href="/"
              style={{
                color: "#fff",
                fontSize: 20,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              PDFSail
            </a>
            <div style={{ display: "flex", gap: 20, fontSize: 14, flex: 1 }}>
              <a href="/editor" style={{ color: "#ccc", textDecoration: "none" }}>
                Editor
              </a>
              {/* 隐藏入口（仍可通过 URL 直接访问） */}
              <a
                href="/smallpdf-alternative"
                style={{ color: "#ccc", textDecoration: "none", display: "none" }}
              >
                Smallpdf Alternative
              </a>
              <a
                href="/ilovepdf-alternative"
                style={{ color: "#ccc", textDecoration: "none", display: "none" }}
              >
                iLovePDF Alternative
              </a>
              <a
                href="/pdf24-alternative"
                style={{ color: "#ccc", textDecoration: "none", display: "none" }}
              >
                PDF24 Alternative
              </a>
              <a href="/admin" style={{ color: "#7c5cfc", textDecoration: "none", fontWeight: 600, display: "none" }}>
                Admin
              </a>
            </div>
            <LangSwitcher />
          </nav>

        {/* Main Content */}
        <main style={{ flex: 1 }}>
          <Routes>{routes.map(renderRoute)}</Routes>
        </main>

        {/* Footer */}
        <footer
          style={{
            background: "#1a1a2e",
            color: "#888",
            padding: "24px",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          <p>PDFSail V12 — Free Online PDF Tools</p>
          <p style={{ marginTop: 4 }}>
            Edit, Merge, Compress, Convert & Sign PDFs Online
          </p>
        </footer>
      </div>
    </BrowserRouter>
    </I18nProvider>
  );
}
