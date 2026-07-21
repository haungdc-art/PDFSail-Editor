import React from "react";
import { COMPETITOR_LIST, generateCompetitorPage } from "../../../growth/competitor/generator";

interface CompetitorPageProps {
  competitor?: string;
}

const benefitStyle: React.CSSProperties = {
  padding: "12px 0",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 16,
  color: "#333",
};

export default function CompetitorPageView({ competitor }: CompetitorPageProps) {
  const competitorData = competitor
    ? generateCompetitorPage(competitor)
    : null;

  const allPages = COMPETITOR_LIST.map((name) => {
    const page = generateCompetitorPage(name);
    return { ...page, url: `/${page.slug}` };
  });

  if (!competitorData) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>
        <h1
          style={{
            fontSize: 36,
            fontWeight: 800,
            color: "#1a1a2e",
            marginBottom: 24,
          }}
        >
          PDF Tool Alternatives
        </h1>
        <p style={{ fontSize: 16, color: "#555", marginBottom: 32 }}>
          See why PDFSail is the best alternative to popular PDF tools
        </p>
        <div style={{ display: "grid", gap: 16 }}>
          {allPages.map((page) => (
            <a
              key={page.url}
              href={page.url}
              style={{
                display: "block",
                padding: 24,
                background: "#fff",
                borderRadius: 10,
                border: "1px solid #eee",
                textDecoration: "none",
                color: "#333",
              }}
            >
              <h2 style={{ fontSize: 18, fontWeight: 600, color: "#4361ee" }}>
                {page.title}
              </h2>
              <p style={{ marginTop: 8, color: "#555" }}>
                {page.content.slice(0, 150)}...
              </p>
            </a>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px" }}>
      {/* Hero */}
      <div
        style={{
          textAlign: "center",
          marginBottom: 48,
          padding: "48px 24px",
          background: "linear-gradient(135deg, #4361ee 0%, #7209b7 100%)",
          borderRadius: 16,
          color: "#fff",
        }}
      >
        <h1 style={{ fontSize: 36, fontWeight: 800, marginBottom: 16 }}>
          {competitorData.title}
        </h1>
        <p style={{ fontSize: 18, opacity: 0.9, maxWidth: 600, margin: "0 auto" }}>
          {competitorData.content}
        </p>
        <a
          href="/editor"
          style={{
            display: "inline-block",
            marginTop: 24,
            padding: "14px 40px",
            background: "#fff",
            color: "#4361ee",
            borderRadius: 8,
            fontWeight: 700,
            fontSize: 16,
            textDecoration: "none",
          }}
        >
          Try PDFSail Free →
        </a>
      </div>

      {/* Benefits */}
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 32,
          boxShadow: "0 2px 16px rgba(0,0,0,0.06)",
          marginBottom: 32,
        }}
      >
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            marginBottom: 16,
            color: "#1a1a2e",
          }}
        >
          Why PDFSail beats {competitorData.competitor}
        </h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          <li style={benefitStyle}>✅ No signup or account required</li>
          <li style={benefitStyle}>✅ No watermark on your documents</li>
          <li style={benefitStyle}>✅ 100% browser-based — nothing to install</li>
          <li style={benefitStyle}>✅ No file size limits on free tier</li>
          <li style={benefitStyle}>✅ Unlimited exports — pay only for premium features</li>
          <li
            style={{
              padding: "12px 0",
              fontSize: 16,
              color: "#333",
            }}
          >
            ✅ 100% free with no hidden costs
          </li>
          <li
            style={{
              padding: "12px 0",
              fontSize: 16,
              color: "#333",
            }}
          >
            ✅ Works in your browser - no software to install
          </li>
          <li
            style={{
              padding: "12px 0",
              fontSize: 16,
              color: "#333",
            }}
          >
            ✅ Your files stay private - processed locally
          </li>
        </ul>
      </div>

      {/* Comparison Table */}
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 32,
          boxShadow: "0 2px 16px rgba(0,0,0,0.06)",
          marginBottom: 32,
        }}
      >
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            marginBottom: 16,
            color: "#1a1a2e",
          }}
        >
          Comparison: PDFSail vs {competitorData.competitor}
        </h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #eee" }}>
                <th style={{ padding: 12, textAlign: "left", color: "#555" }}>
                  Feature
                </th>
                <th style={{ padding: 12, textAlign: "center", color: "#4361ee", fontWeight: 700 }}>
                  PDFSail
                </th>
                <th style={{ padding: 12, textAlign: "center", color: "#888" }}>
                  {competitorData.competitor}
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                { feature: "Price", ours: "Free", theirs: "Freemium / Paid" },
                { feature: "File Size Limit", ours: "No limit", theirs: "Limited" },
                { feature: "Watermark", ours: "No watermark", theirs: "Watermark on free" },
                { feature: "Signup Required", ours: "No", theirs: "Often required" },
                { feature: "Browser Based", ours: "Yes", theirs: "Varies" },
                { feature: "Privacy", ours: "100% private", theirs: "Uploads to server" },
                { feature: "Export Quality", ours: "Original quality", theirs: "Compressed" },
              ].map((row, idx) => (
                <tr
                  key={row.feature}
                  style={{
                    borderBottom: "1px solid #f0f0f0",
                    background: idx % 2 === 0 ? "#fafafa" : "#fff",
                  }}
                >
                  <td style={{ padding: "10px 12px", fontWeight: 500 }}>
                    {row.feature}
                  </td>
                  <td
                    style={{
                      padding: "10px 12px",
                      textAlign: "center",
                      color: "#2ec4b6",
                      fontWeight: 600,
                    }}
                  >
                    ✅ {row.ours}
                  </td>
                  <td
                    style={{
                      padding: "10px 12px",
                      textAlign: "center",
                      color: "#e63946",
                    }}
                  >
                    ❌ {row.theirs}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* CTA */}
      <div style={{ textAlign: "center", marginTop: 32 }}>
        <a
          href="/editor"
          style={{
            display: "inline-block",
            padding: "16px 48px",
            background: "#4361ee",
            color: "#fff",
            borderRadius: 8,
            fontWeight: 700,
            fontSize: 18,
            textDecoration: "none",
          }}
        >
          Start Using PDFSail Free →
        </a>
      </div>

      {/* Other alternatives */}
      <div style={{ marginTop: 48 }}>
        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            marginBottom: 16,
            color: "#1a1a2e",
          }}
        >
          More Alternatives
        </h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {allPages
            .filter((p) => p.competitor !== competitorData.competitor)
            .map((p) => (
              <a
                key={p.url}
                href={p.url}
                style={{
                  padding: "10px 20px",
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  textDecoration: "none",
                  color: "#4361ee",
                  fontSize: 14,
                }}
              >
                {p.title}
              </a>
            ))}
        </div>
      </div>
    </div>
  );
}
