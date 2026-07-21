import React from "react";
import { keywords } from "../../../shared/keywords";
import type { KeywordItem } from "../../../shared/types";

interface SEOPageProps {
  keyword?: string;
}

function findKeyword(keyword?: string): KeywordItem | undefined {
  if (!keyword) return undefined;
  return keywords.find(
    (k) =>
      k.keyword.toLowerCase() === keyword.toLowerCase() ||
      k.slug === keyword.toLowerCase()
  );
}

function getAllKeywordsByCategory() {
  const grouped: Record<string, KeywordItem[]> = {};
  for (const kw of keywords) {
    if (!grouped[kw.category]) grouped[kw.category] = [];
    grouped[kw.category].push(kw);
  }
  return grouped;
}

export default function SEOPage({ keyword }: SEOPageProps) {
  const kw = findKeyword(keyword);

  // If a specific keyword is matched, render a dedicated SEO landing page
  if (kw) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>
        {/* Hero */}
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <h1
            style={{
              fontSize: 42,
              fontWeight: 800,
              marginBottom: 16,
              color: "#1a1a2e",
              lineHeight: 1.2,
            }}
          >
            {kw.h1}
          </h1>
          <p
            style={{
              fontSize: 18,
              color: "#555",
              maxWidth: 650,
              margin: "0 auto",
              lineHeight: 1.6,
            }}
          >
            {kw.description}
          </p>
          <a
            href="/editor"
            style={{
              display: "inline-block",
              marginTop: 24,
              padding: "14px 36px",
              background: "#4361ee",
              color: "#fff",
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 16,
              textDecoration: "none",
              transition: "background 0.2s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#3651d4")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "#4361ee")
            }
          >
            Try It Free Now →
          </a>
        </div>

        {/* Content */}
        <div
          style={{
            background: "#fff",
            borderRadius: 12,
            padding: 32,
            boxShadow: "0 2px 16px rgba(0,0,0,0.06)",
            marginBottom: 48,
            lineHeight: 1.8,
            fontSize: 16,
            color: "#333",
          }}
        >
          <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16, color: "#1a1a2e" }}>
            How to {kw.keyword}
          </h2>
          <p>{kw.content}</p>

          <div
            style={{
              margin: "24px 0",
              padding: 20,
              background: "#f0f4ff",
              borderRadius: 8,
              borderLeft: "4px solid #4361ee",
            }}
          >
            <strong>✨ Why choose PDFSail?</strong>
            <ul style={{ marginTop: 8, paddingLeft: 20 }}>
              <li>100% free - no hidden charges</li>
              <li>No signup or registration required</li>
              <li>Processes in your browser - maximum privacy</li>
              <li>No file size limits</li>
              <li>No watermarks on your documents</li>
            </ul>
          </div>
        </div>

        {/* Related Tools */}
        <div>
          <h2
            style={{
              fontSize: 22,
              fontWeight: 700,
              marginBottom: 20,
              color: "#1a1a2e",
            }}
          >
            More Free PDF Tools
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
              gap: 16,
            }}
          >
            {keywords
              .filter((k) => k.slug !== kw.slug)
              .slice(0, 6)
              .map((k) => (
                <a
                  key={k.slug}
                  href={`/${k.slug}`}
                  style={{
                    padding: 16,
                    background: "#fff",
                    borderRadius: 8,
                    border: "1px solid #eee",
                    textDecoration: "none",
                    color: "#333",
                    transition: "box-shadow 0.2s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.boxShadow =
                      "0 4px 12px rgba(0,0,0,0.08)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.boxShadow = "none")
                  }
                >
                  <strong style={{ color: "#4361ee" }}>{k.seoTitle}</strong>
                  <p style={{ fontSize: 13, marginTop: 6, color: "#888" }}>
                    {k.description.slice(0, 100)}...
                  </p>
                </a>
              ))}
          </div>
        </div>
      </div>
    );
  }

  // Default: render all keyword landing as a sitemap-style index
  const grouped = getAllKeywordsByCategory();

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "48px 24px" }}>
      {/* Hero */}
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <h1
          style={{
            fontSize: 40,
            fontWeight: 800,
            color: "#1a1a2e",
            marginBottom: 12,
          }}
        >
          Free Online PDF Tools
        </h1>
        <p style={{ fontSize: 18, color: "#555" }}>
          Edit, merge, compress, convert, sign, and manage PDFs — all free, all
          in your browser
        </p>
        <a
          href="/editor"
          style={{
            display: "inline-block",
            marginTop: 20,
            padding: "14px 36px",
            background: "#4361ee",
            color: "#fff",
            borderRadius: 8,
            fontWeight: 600,
            fontSize: 16,
            textDecoration: "none",
          }}
        >
          Open PDF Editor →
        </a>
      </div>

      {/* Category Sections */}
      {Object.entries(grouped).map(([category, kws]) => (
        <div key={category} style={{ marginBottom: 40 }}>
          <h2
            style={{
              fontSize: 22,
              fontWeight: 700,
              marginBottom: 16,
              color: "#1a1a2e",
              textTransform: "capitalize",
            }}
          >
            {category} Tools
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {kws.map((k) => (
              <a
                key={k.slug}
                href={`/${k.slug}`}
                style={{
                  padding: 20,
                  background: "#fff",
                  borderRadius: 10,
                  border: "1px solid #eee",
                  textDecoration: "none",
                  color: "#333",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow =
                    "0 4px 16px rgba(0,0,0,0.08)";
                  e.currentTarget.style.borderColor = "#4361ee";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = "none";
                  e.currentTarget.style.borderColor = "#eee";
                }}
              >
                <h3
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: "#4361ee",
                    marginBottom: 8,
                  }}
                >
                  {k.seoTitle}
                </h3>
                <p style={{ fontSize: 13, color: "#777", lineHeight: 1.5 }}>
                  {k.description.slice(0, 120)}...
                </p>
                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    gap: 8,
                    fontSize: 11,
                    color: "#aaa",
                  }}
                >
                  <span>🔍 {k.volume.toLocaleString()}/mo</span>
                  <span>📊 Difficulty: {k.difficulty}%</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
