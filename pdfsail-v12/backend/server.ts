import express from "express";
import cors from "cors";
import path from "path";
import { uploadRouter } from "./upload.js";
import { exportRouter } from "./export.js";
import { billingRouter } from "./billing.js";
import { seoRouter } from "./seo.js";
import { growthRouter } from "./growth.js";
import { v13Router } from "./v13.js";
import { valueProbeRouter } from "./value-probe.js";
import { workspaceRouter } from "./workspace.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "13.0.0",
    name: "PDFSail V13",
    timestamp: Date.now(),
    uptime: process.uptime(),
  });
});

// Routes — V12 legacy
app.use("/api", uploadRouter);
app.use("/api", exportRouter);
app.use("/api", billingRouter);
app.use("/api", seoRouter);
app.use("/api", growthRouter);

// Routes — V13 Growth System
app.use("/api", v13Router);

// Routes — PDF Value Probe v0 (experiment)
app.use("/api", valueProbeRouter);

// Routes — Multi-Stage Document Workspace v0
app.use("/api", workspaceRouter);

// 生产模式：serve 前端静态文件（Commit 4+ 部署改造）
// Render / CF Pages 等平台部署时，前端 build 产物在 dist/
if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(process.cwd(), "dist");
  app.use(express.static(distPath));
  // SPA fallback：所有非 /api 路由返回 index.html
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// Error handler
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Server error:", err);
    res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       🚀  PDFSail V13 Growth Server          ║
║──────────────────────────────────────────────║
║  API:    http://localhost:${PORT}/api          ║
║  Health: http://localhost:${PORT}/api/health   ║
║  V13:    http://localhost:${PORT}/api/v13      ║
║  Value:  http://localhost:${PORT}/api/value   ║
║  CORS:   ${process.env.CORS_ORIGIN || "http://localhost:5173"}  ║
║  Mode:   ${process.env.NODE_ENV || "development"}  ║
╚══════════════════════════════════════════════╝
  `);
});
