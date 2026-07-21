// ──────────────────────────────────────────────
// SEO v2 — AI Traffic Growth OS
// Page Factory + Keyword Expansion + FAQ + Internal Links + Kill Engine
// ──────────────────────────────────────────────

import { generateSEOPage, type SEOPage } from "./generator.js";
import { generateCompetitorPage, COMPETITOR_LIST, type CompetitorPage } from "../competitor/generator.js";

// ── ① Keyword Discovery Engine ──

export function keywordDiscovery(seed: string): string[] {
  const modifiers = [
    "free", "online", "without signup", "no watermark",
    "best", "alternative", "tool", "editor",
    "in browser", "for free", "no limits",
  ];
  const intents = [
    `how to ${seed}`, `${seed} on mac`, `${seed} on mobile`,
    `${seed} for free`, `${seed} without installing`,
  ];
  const commercial = [
    `best ${seed}`, `${seed} alternative`, `${seed} vs`,
    `top ${seed}`, `${seed} review`,
  ];
  return [...new Set([
    seed,
    ...modifiers.map(m => `${seed} ${m}`),
    ...intents,
    ...commercial,
  ])];
}

export function expandKeywordCluster(seed: string, count: number = 10): string[] {
  return keywordDiscovery(seed).slice(0, count);
}

// ── ② FAQ Generator ──

export interface FAQ {
  question: string;
  answer: string;
}

export function generateFAQ(keyword: string): FAQ[] {
  const base = [
    {
      question: `How to ${keyword}?`,
      answer: `Upload your PDF file to PDFSail, select "${keyword}" option, and download the result. No signup required, works in your browser instantly.`,
    },
    {
      question: `Is ${keyword} free?`,
      answer: `Yes! PDFSail offers ${keyword} completely free. No hidden charges, no watermark, and no credit card required.`,
    },
    {
      question: `Can I ${keyword} online without installing software?`,
      answer: `Absolutely. Everything runs directly in your browser. No downloads, no installations, no plugins needed.`,
    },
    {
      question: `Is it safe to ${keyword}?`,
      answer: `Yes. All PDF processing happens in your browser. Your files are never uploaded to our servers during processing.`,
    },
    {
      question: `What is the best tool to ${keyword}?`,
      answer: `PDFSail is the top-rated free tool for ${keyword}. It's fast, secure, and works on any device with zero limits.`,
    },
    {
      question: `Can I ${keyword} on mobile?`,
      answer: `Yes, PDFSail works on any device with a modern browser, including phones and tablets.`,
    },
  ];
  return base;
}

// ── ③ Internal Linking Engine ──

export interface InternalLink {
  title: string;
  url: string;
  keyword: string;
}

export function buildInternalLinks(
  currentSlug: string,
  allPages: { slug: string; title: string; keyword: string; category?: string }[],
  maxLinks: number = 5
): InternalLink[] {
  const current = allPages.find(p => p.slug === currentSlug);
  const others = allPages.filter(p => p.slug !== currentSlug);

  // Prioritize same-category pages
  const sameCat = current
    ? others.filter(p => p.category === current.category)
    : [];
  const diffCat = others.filter(p => !sameCat.includes(p));

  const sorted = [...sameCat, ...diffCat].slice(0, maxLinks);
  return sorted.map(p => ({
    title: p.title,
    url: `/${p.slug}`,
    keyword: p.keyword,
  }));
}

export function addInternalLinksToPage(
  page: SEOPage,
  allPages: { slug: string; title: string; keyword: string; category?: string }[]
): SEOPage & { faq: FAQ[]; internalLinks: InternalLink[]; relatedKeywords: string[] } {
  const faq = generateFAQ(page.keyword);
  const internalLinks = buildInternalLinks(page.slug, allPages);
  const relatedKeywords = keywordDiscovery(page.keyword).slice(1, 6);

  return { ...page, faq, internalLinks, relatedKeywords };
}

// ── ④ Enhanced SEO Page Generator (v2) ──

export function generateSEOPageV2(
  keyword: string,
  allPages?: { slug: string; title: string; keyword: string; category?: string }[],
  options?: { category?: string; volume?: number; difficulty?: number }
): SEOPage & { faq: FAQ[]; internalLinks: InternalLink[]; relatedKeywords: string[] } {
  const base = generateSEOPage(keyword, options);
  const faq = generateFAQ(keyword);
  const relatedKeywords = keywordDiscovery(keyword).slice(1, 6);

  let internalLinks: InternalLink[] = [];
  if (allPages && allPages.length > 0) {
    internalLinks = buildInternalLinks(base.slug, allPages);
  }

  return { ...base, faq, internalLinks, relatedKeywords };
}

// ── ⑤ Batch Generate with Internal Links ──

export function generateFullSite(keywords: {
  keyword: string; category?: string; volume?: number; difficulty?: number
}[]): (SEOPage & { faq: FAQ[]; internalLinks: InternalLink[]; relatedKeywords: string[] })[] {
  const basicPages = keywords.map(k => generateSEOPage(k.keyword, { category: k.category, volume: k.volume, difficulty: k.difficulty }));
  const allRefs = keywords.map(k => ({
    slug: k.keyword.toLowerCase().replace(/\s+/g, "-"),
    title: `Best way to ${k.keyword}`,
    keyword: k.keyword,
    category: k.category,
  }));

  return basicPages.map(p => addInternalLinksToPage(p, allRefs));
}

// ── ⑥ Competitor Page Enhancement ──

export function generateEnhancedCompetitorPage(name: string): CompetitorPage & { faq: FAQ[] } {
  const page = generateCompetitorPage(name);
  const faq = [
    { question: `Is ${name} free?`, answer: `${name} offers limited free features with watermarks. PDFSail is completely free with no restrictions.` },
    { question: `Why choose PDFSail over ${name}?`, answer: `PDFSail requires no signup, has no watermarks, processes files in your browser, and offers unlimited free usage.` },
    { question: `Does ${name} have file size limits?`, answer: `${name} restricts file sizes on its free tier. PDFSail has no file size limits.` },
  ];
  return { ...page, faq };
}

// ── ⑦ Kill Engine — Auto-detect low-value pages ──

export interface PagePerformance {
  slug: string;
  keyword: string;
  impressions: number;
  clicks: number;
  revenue: number;
  cost: number;
}

export function shouldDeletePage(stats: PagePerformance): boolean {
  const ctr = stats.clicks / Math.max(stats.impressions, 1);
  const roi = stats.revenue / Math.max(stats.cost, 1);
  // Delete if: no clicks + low impressions + no revenue
  if (stats.impressions < 100 && stats.clicks === 0 && stats.revenue === 0) return true;
  // Delete if: very low CTR for many impressions
  if (stats.impressions > 500 && ctr < 0.005) return true;
  // Delete if: losing money consistently
  if (stats.cost > 50 && roi < 0.5) return true;
  return false;
}

export function filterDeadPages(allStats: PagePerformance[]): {
  keep: PagePerformance[];
  kill: PagePerformance[];
} {
  const keep: PagePerformance[] = [];
  const kill: PagePerformance[] = [];
  for (const p of allStats) {
    if (shouldDeletePage(p)) kill.push(p);
    else keep.push(p);
  }
  return { keep, kill };
}

// ── ⑧ ROI Engine ──

export function calculateROI(cost: number, revenue: number): number {
  return revenue / Math.max(cost, 1);
}

export type ROIDecision = "SCALE" | "HOLD" | "PAUSE";

export function decideByROI(roi: number): ROIDecision {
  if (roi >= 2) return "SCALE";
  if (roi >= 1) return "HOLD";
  return "PAUSE";
}

// ── ⑨ Full SEO v2 Pipeline ──

export interface SEOPipelineInput {
  seedKeyword: string;
  competitors?: string[];
  allStats?: PagePerformance[];
}

export interface SEOPipelineOutput {
  keywords: string[];
  page: SEOPage & { faq: FAQ[]; internalLinks: InternalLink[]; relatedKeywords: string[] };
  competitorPages: (CompetitorPage & { faq: FAQ[] })[];
  deadPages: PagePerformance[];
  roiDecision: ROIDecision;
}

export function seoV2Pipeline(input: SEOPipelineInput): SEOPipelineOutput {
  const { seedKeyword, competitors, allStats } = input;

  // 1. Discover keywords
  const keywords = keywordDiscovery(seedKeyword);

  // 2. Generate main page
  const page = generateSEOPageV2(seedKeyword);

  // 3. Generate competitor pages
  const compList = competitors || COMPETITOR_LIST.slice(0, 5);
  const competitorPages = compList.map(generateEnhancedCompetitorPage);

  // 4. Kill dead pages
  let deadPages: PagePerformance[] = [];
  if (allStats) {
    deadPages = filterDeadPages(allStats).kill;
  }

  // 5. ROI decision (using mock stats if none provided)
  const roi = calculateROI(allStats?.[0]?.cost || 10, allStats?.[0]?.revenue || 25);
  const roiDecision = decideByROI(roi);

  return {
    keywords,
    page,
    competitorPages,
    deadPages,
    roiDecision,
  };
}
