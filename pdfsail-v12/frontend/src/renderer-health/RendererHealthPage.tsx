/**
 * RendererHealthPage.tsx — Renderer Health Dashboard（Sprint-78 Task-004）
 *
 * 展示：Legacy / Painter / Diff / Performance / Memory / Errors。
 * 纯展示组件：接收 RendererHealthReport，渲染健康状态表。
 *
 * PM Rule-033：Renderer 不知 Migration（本页面只读健康数据，不碰 Renderer）。
 * 不参与渲染逻辑，只做展示。
 */

import * as React from "react";
import type { RendererHealthReport } from "./renderer-health";

const HEALTH_COLOR: Record<string, string> = {
  healthy: "#22c55e",
  degraded: "#f59e0b",
  unhealthy: "#ef4444",
};

export function RendererHealthPage({ report }: { report: RendererHealthReport }): React.ReactElement {
  const color = HEALTH_COLOR[report.health] ?? "#94a3b8";
  return React.createElement(
    "div",
    { "data-testid": "renderer-health", style: { padding: 16, fontFamily: "monospace" } },
    // Header
    React.createElement("h2", null, `Renderer Health：${report.health}`),
    // 摘要
    React.createElement(
      "div",
      { style: { display: "flex", gap: 24, marginBottom: 16 } },
      React.createElement("span", null, `Pages: ${report.passPages}/${report.totalPages} pass`),
      React.createElement("span", { style: { color } }, `Health: ${report.health}`),
      React.createElement("span", null, `MaxBBoxDiff: ${report.maxBBoxDiff.toFixed(4)}`),
      React.createElement("span", null, `AvgPaintTime: ${report.avgPaintTime.toFixed(1)}ms`),
    ),
    // 错误
    report.errors.length > 0
      ? React.createElement(
          "div",
          { style: { color: "#ef4444", marginBottom: 16 } },
          report.errors.map((e, i) => React.createElement("div", { key: i }, `ERR: ${e}`)),
        )
      : null,
    // 表格
    React.createElement(
      "table",
      { style: { borderCollapse: "collapse" } },
      React.createElement(
        "thead",
        null,
        React.createElement(
          "tr",
          null,
          ["Page", "Legacy", "Painter", "BBoxDiff", "RotDiff", "MaskDiff", "PatchDiff", "Paint(ms)", "Render(ms)", "Pass"].map((h) =>
            React.createElement("th", { key: h, style: { border: "1px solid #ccc", padding: "4px 8px" } }, h),
          ),
        ),
      ),
      React.createElement(
        "tbody",
        null,
        report.rows.map((r) =>
          React.createElement(
            "tr",
            { key: r.page },
            [
              String(r.page),
              String(r.legacyCount),
              String(r.painterCount),
              r.bboxDiff.toFixed(4),
              r.rotationDiff.toFixed(2),
              String(r.maskDiff),
              String(r.patchDiff),
              r.paintTime.toFixed(1),
              r.renderTime.toFixed(1),
              r.pass ? "PASS" : "FAIL",
            ].map((cell, j) =>
              React.createElement(
                "td",
                { key: j, style: { border: "1px solid #ccc", padding: "4px 8px", color: j === 9 && !r.pass ? "#ef4444" : undefined } },
                cell,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
