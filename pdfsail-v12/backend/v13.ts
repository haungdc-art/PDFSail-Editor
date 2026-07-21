// ──────────────────────────────────────────────
// V13 Growth Engine API Routes
// ──────────────────────────────────────────────

import express from "express";
import { generateSEOPages, generateSEOPage, generateBatch, generateFromBaseKeywords, BASE_KEYWORDS } from "../growth/seo/generator.js";
import { generateCompetitorPages, generateCompetitorBatch, COMPETITOR_LIST } from "../growth/competitor/generator.js";
import { ABTestEngine, TITLE_TEST_TEMPLATES } from "../growth/abtest/engine.js";
import { conversionEngine, autoOptimizer } from "../growth/conversion/engine.js";
import { scheduler } from "../growth/scheduler.js";
import { db } from "../growth/db.js";
import { buildSystem, startSystem } from "../growth/system.js";

export const v13Router = express.Router();

// ── Health & System Info ──

v13Router.get("/v13/status", (_req, res) => {
  const jobCount = scheduler.getJobs().length;
  res.json({
    version: "13.0.0",
    scheduler: scheduler.getStatus(),
    jobs: jobCount,
    collections: ["seo_pages", "competitor_pages", "ad_campaigns"],
  });
});

v13Router.post("/v13/build", (_req, res) => {
  const system = buildSystem();
  res.json({
    success: true,
    seoPages: system.seoPages.length,
    compPages: system.compPages.length,
    abVariants: system.abtest.variants.length,
    adCampaigns: system.ads.campaigns.length,
  });
});

v13Router.post("/v13/start", (_req, res) => {
  const system = startSystem();
  res.json({
    success: true,
    message: "V13 Growth System started",
    stats: {
      seoPages: system.seoPages.length,
      compPages: system.compPages.length,
    },
  });
});

// ── SEO Generator ──

v13Router.get("/v13/seo/pages", (_req, res) => {
  const pages = generateSEOPages();
  res.json({ total: pages.length, pages });
});

v13Router.get("/v13/seo/page/:keyword", (req, res) => {
  const keyword = req.params.keyword.replace(/-/g, " ");
  const page = generateSEOPages().find((p) => p.keyword.toLowerCase() === keyword.toLowerCase())
    || generateSEOPage(keyword);
  res.json(page);
});

v13Router.post("/v13/seo/generate", (req, res) => {
  const { keywords, fromBase } = req.body;
  let pages;

  if (fromBase) {
    pages = generateFromBaseKeywords(BASE_KEYWORDS);
  } else if (keywords && Array.isArray(keywords)) {
    pages = generateBatch(keywords);
  } else {
    pages = generateSEOPages();
  }

  res.json({ total: pages.length, pages: pages.slice(0, 100) });
});

v13Router.post("/v13/seo/expand", (_req, res) => {
  const pages = generateFromBaseKeywords(BASE_KEYWORDS);
  res.json({ total: pages.length, sample: pages.slice(0, 10) });
});

// ── Competitor Generator ──

v13Router.get("/v13/competitor/pages", (_req, res) => {
  const pages = generateCompetitorPages();
  res.json({ total: pages.length, pages });
});

v13Router.post("/v13/competitor/generate", (req, res) => {
  const { competitors } = req.body;
  const list = competitors || COMPETITOR_LIST;
  const pages = generateCompetitorBatch(list);
  res.json({ total: pages.length, pages });
});

// ── A/B Test Engine ──

// In-memory A/B test sessions
const abTests = new Map<string, ABTestEngine>();

v13Router.post("/v13/abtest/create", (req, res) => {
  const { name, titles } = req.body;
  if (!titles || !Array.isArray(titles)) {
    return res.status(400).json({ error: "titles array required" });
  }

  const engine = new ABTestEngine(name || `test-${Date.now()}`);
  const variants = engine.createBatch(titles);
  abTests.set(name || "default", engine);

  res.json({
    success: true,
    testName: name || "default",
    variants: engine.getRanked().map((v) => ({
      id: v.id,
      title: v.title,
      clicks: v.clicks,
      impressions: v.impressions,
    })),
  });
});

v13Router.post("/v13/abtest/impression", (req, res) => {
  const { testName, variantId } = req.body;
  const engine = abTests.get(testName || "default");
  if (!engine) return res.status(404).json({ error: "Test not found" });

  engine.trackImpression(variantId);
  res.json({ success: true });
});

v13Router.post("/v13/abtest/click", (req, res) => {
  const { testName, variantId } = req.body;
  const engine = abTests.get(testName || "default");
  if (!engine) return res.status(404).json({ error: "Test not found" });

  engine.trackClick(variantId);
  res.json({ success: true });
});

v13Router.get("/v13/abtest/results", (req, res) => {
  const testName = (req.query.name as string) || "default";
  const engine = abTests.get(testName);
  if (!engine) return res.status(404).json({ error: "Test not found" });

  res.json({
    testName,
    totalImpressions: engine.totalImpressions,
    totalClicks: engine.totalClicks,
    best: engine.getBest(),
    variants: engine.getResults(),
  });
});

v13Router.post("/v13/abtest/reset", (req, res) => {
  const testName = (req.query.name as string) || "default";
  const engine = abTests.get(testName);
  if (engine) engine.reset();
  res.json({ success: true });
});

// ── Conversion Engine ──

v13Router.post("/v13/conversion/evaluate", (req, res) => {
  const { clicks, conversions } = req.body;
  const result = conversionEngine.evaluate(clicks, conversions);
  res.json(result);
});

v13Router.post("/v13/conversion/log", (req, res) => {
  const { page, clicks, conversions } = req.body;
  conversionEngine.logEvent(page, clicks, conversions);
  res.json({ success: true, rollingCVR: conversionEngine.getRollingAverage() });
});

v13Router.get("/v13/conversion/trend", (_req, res) => {
  res.json({
    trend: conversionEngine.getTrend(),
    rollingAverage: conversionEngine.getRollingAverage(),
    history: conversionEngine.getHistory(),
  });
});

// ── Auto Optimizer ──

v13Router.post("/v13/optimizer/decide", (req, res) => {
  const { clicks, conversions, context } = req.body;
  const decision = autoOptimizer.decide(clicks, conversions, context);
  res.json(decision);
});

v13Router.post("/v13/optimizer/decide-batch", (req, res) => {
  const { campaigns } = req.body;
  if (!campaigns || !Array.isArray(campaigns)) {
    return res.status(400).json({ error: "campaigns array required" });
  }
  const decisions = autoOptimizer.decideBatch(campaigns);
  res.json({ total: decisions.length, decisions });
});

// ── Database ──

v13Router.get("/v13/db/collections", (_req, res) => {
  // MemoryDB doesn't expose collection names directly, so expose via known names
  const names = ["seo_pages", "competitor_pages", "ad_campaigns"];
  const info = names.map((n) => ({
    name: n,
    count: db.collection(n).count(),
  }));
  res.json({ collections: info });
});

v13Router.get("/v13/db/:collection", (req, res) => {
  const { collection } = req.params;
  const filter = req.query.filter ? JSON.parse(req.query.filter as string) : undefined;
  const docs = db.collection(collection).find(filter);
  res.json({ total: docs.length, docs });
});

// ── Scheduler ──

v13Router.get("/v13/scheduler/status", (_req, res) => {
  const jobs = scheduler.getJobs().map((j) => ({
    id: j.id,
    name: j.name,
    lastRun: j.lastRun,
    runCount: j.runCount,
    intervalMs: j.intervalMs,
  }));
  res.json({ status: scheduler.getStatus(), jobs });
});

v13Router.post("/v13/scheduler/start", (_req, res) => {
  scheduler.start();
  res.json({ success: true, status: scheduler.getStatus() });
});

v13Router.post("/v13/scheduler/stop", (_req, res) => {
  scheduler.stop();
  res.json({ success: true, status: scheduler.getStatus() });
});

// ── Full System ──

v13Router.get("/v13/system/status", (_req, res) => {
  res.json({
    version: "13.0.0",
    name: "PDFSail V13 Growth System",
    modules: [
      { name: "SEO Generator", pages: generateSEOPages().length },
      { name: "Competitor Generator", pages: generateCompetitorPages().length },
      { name: "A/B Test", active: abTests.size },
      { name: "Conversion Engine", events: conversionEngine.getHistory().length },
      { name: "Scheduler", status: scheduler.getStatus(), jobs: scheduler.getJobs().length },
    ],
    baseKeywords: BASE_KEYWORDS.length,
    competitors: COMPETITOR_LIST.length,
  });
});
