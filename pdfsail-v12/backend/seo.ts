import express from "express";
import { generateSEOPages, generateSEOPage } from "../growth/seo/generator.js";

export const seoRouter = express.Router();

// API: Get all SEO pages
seoRouter.get("/seo/pages", (_req, res) => {
  const pages = generateSEOPages();
  res.json({
    total: pages.length,
    pages,
  });
});

// API: Get SEO page for a specific keyword
seoRouter.get("/seo/page/:keyword", (req, res) => {
  const { keyword } = req.params;
  const page = generateSEOPage(decodeURIComponent(keyword));
  res.json(page);
});

// API: SEO sitemap data
seoRouter.get("/seo/sitemap", (_req, res) => {
  const pages = generateSEOPages();
  const sitemap = pages.map((p) => ({
    loc: `https://pdfsail.com/${p.slug}`,
    lastmod: new Date().toISOString().split("T")[0],
    priority: (p.difficulty ?? 100) < 30 ? "1.0" : (p.difficulty ?? 100) < 50 ? "0.8" : "0.6",
  }));
  res.json(sitemap);
});
