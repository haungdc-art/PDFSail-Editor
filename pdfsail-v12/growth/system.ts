// ──────────────────────────────────────────────
// V13 Full System Orchestrator — Connect all 4 systems
// ──────────────────────────────────────────────

import { generateBatch, generateSEOPages, generateFromBaseKeywords } from "./seo/generator.js";
import { generateCompetitorBatch, generateCompetitorPages } from "./competitor/generator.js";
import { ABTestEngine, TITLE_TEST_TEMPLATES } from "./abtest/engine.js";
import { ConversionEngine, AutoOptimizer, conversionEngine, autoOptimizer } from "./conversion/engine.js";
import { initAndStart, scheduler, registerAllDefaultJobs } from "./scheduler.js";
import { db } from "./db.js";
import { adsOptimizer } from "./adsOptimizer.js";
import { keywordDB } from "./keywordDB.js";

// ──────────────────────────────────────────────
// Base data
// ──────────────────────────────────────────────

export const BASE_KEYWORDS = [
  "edit pdf",
  "compress pdf",
  "convert pdf to word",
  "merge pdf files",
  "split pdf",
  "rotate pdf pages",
  "sign pdf",
  "unlock pdf",
  "pdf ocr",
  "delete pages from pdf",
  "reorder pdf pages",
  "extract pdf pages",
  "resize pdf",
  "pdf to jpg",
  "pdf to png",
  "add text to pdf",
  "remove text from pdf",
  "watermark pdf",
  "flatten pdf",
  "optimize pdf",
];

export const COMPETITOR_LIST = [
  "Smallpdf",
  "iLovePDF",
  "PDF24",
  "Adobe Acrobat",
  "PDF Candy",
];

// ──────────────────────────────────────────────
// Build System — Generate all pages
// ──────────────────────────────────────────────

export function buildSystem() {
  console.log("[V13 System] Building all pages...");

  // 1. SEO Pages — from base keywords (expandable to 1000+)
  const seoPages = generateSEOPages();
  const expandedSEOPages = generateFromBaseKeywords(BASE_KEYWORDS);
  console.log(`[V13 System] SEO: ${seoPages.length} predefined + ${expandedSEOPages.length} expanded`);

  // 2. Competitor Pages
  const compPages = generateCompetitorPages();
  console.log(`[V13 System] Competitor: ${compPages.length} pages`);

  // 3. A/B Test setup
  const abtest = new ABTestEngine("landing-hero");
  const variants = abtest.createBatch(TITLE_TEST_TEMPLATES["landing-hero"]);
  console.log(`[V13 System] A/B Test: ${variants.length} variants configured`);

  // 4. Conversion engine ready
  console.log(`[V13 System] Conversion engine ready`);

  // 5. Ads optimizer
  adsOptimizer.seedDemoData();
  const adsAnalysis = adsOptimizer.analyzeAll();
  console.log(`[V13 System] Ads: ${adsAnalysis.length} campaigns analyzed`);

  return {
    seoPages: expandedSEOPages,
    compPages,
    abtest: {
      engine: abtest,
      variants,
    },
    conversion: {
      engine: conversionEngine,
      optimizer: autoOptimizer,
    },
    ads: {
      campaigns: adsAnalysis,
    },
  };
}

// ──────────────────────────────────────────────
// Start System — Build + Schedule
// ──────────────────────────────────────────────

export function startSystem() {
  const system = buildSystem();

  // Register and start all scheduled jobs
  registerAllDefaultJobs(BASE_KEYWORDS);
  scheduler.start();

  console.log(`
╔══════════════════════════════════════════════╗
║       🚀 PDFSail V13 Growth System          ║
║──────────────────────────────────────────────║
║  SEO Pages:    ${system.seoPages.length} generated       ║
║  Competitor:   ${system.compPages.length} pages           ║
║  A/B Variants: ${system.abtest.variants.length} active    ║
║  Ad Campaigns: ${system.ads.campaigns.length} running     ║
║  Scheduler:    ${scheduler.getStatus().toUpperCase()}                  ║
╚══════════════════════════════════════════════╝
  `);

  return system;
}

export default {
  buildSystem,
  startSystem,
  BASE_KEYWORDS,
  COMPETITOR_LIST,
  generateBatch,
  generateCompetitorBatch,
  ABTestEngine,
  ConversionEngine,
  AutoOptimizer,
  scheduler,
  db,
};
