import express from "express";
import { adsOptimizer } from "../growth/adsOptimizer.js";
import { keywordDB } from "../growth/keywordDB.js";
import type { AdCampaign, ROIAnalysis } from "../shared/types.js";

export const growthRouter = express.Router();

// ── Campaign Management ──

growthRouter.post("/ads/campaign", (req, res) => {
  const campaign: AdCampaign = req.body;
  adsOptimizer.registerCampaign(campaign);
  res.json({ success: true, campaignId: campaign.id });
});

growthRouter.get("/ads/campaigns", (_req, res) => {
  const campaigns = adsOptimizer.getActiveCampaigns();
  res.json({ total: campaigns.length, campaigns });
});

growthRouter.put("/ads/campaign/:id", (req, res) => {
  const { id } = req.params;
  adsOptimizer.updateCampaign(id, req.body);
  res.json({ success: true });
});

// ── ROI Analysis ──

growthRouter.get("/ads/analyze/:id", (req, res) => {
  const { id } = req.params;
  const analysis = adsOptimizer.analyze(id);
  if (!analysis) {
    return res.status(404).json({ error: "Campaign not found" });
  }
  res.json(analysis);
});

growthRouter.get("/ads/analyze", (_req, res) => {
  const analyses = adsOptimizer.analyzeAll();
  res.json({ total: analyses.length, analyses });
});

// ── Auto Optimization ──

growthRouter.post("/ads/optimize", (_req, res) => {
  const result = adsOptimizer.autoOptimize();
  res.json({
    success: true,
    scaled: result.scaled.length,
    stopped: result.stopped.length,
    scaledCampaigns: result.scaled,
    stoppedCampaigns: result.stopped,
  });
});

growthRouter.get("/ads/history", (_req, res) => {
  res.json({ history: adsOptimizer.getHistory() });
});

// ── Keyword Research ──

growthRouter.get("/keywords/search", (req, res) => {
  const query = (req.query.q as string) || "";
  const results = keywordDB.search(query);
  res.json({ total: results.length, keywords: results.slice(0, 50) });
});

growthRouter.get("/keywords/opportunities", (_req, res) => {
  const opportunities = keywordDB.getBestOpportunities();
  res.json({ total: opportunities.length, keywords: opportunities });
});

growthRouter.get("/keywords/category/:category", (req, res) => {
  const { category } = req.params;
  const results = keywordDB.getByCategory(category);
  res.json({ total: results.length, keywords: results });
});
