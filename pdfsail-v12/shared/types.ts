// ──────────────────────────────────────────────
// Core Block Types
// ──────────────────────────────────────────────

export type BlockType = "text" | "image" | "highlight";

export type Block = {
  id: string;
  type: BlockType;
  page: number;

  x: number;
  y: number;
  w: number;
  h: number;

  content?: string;
  src?: string;
};

export type PageData = {
  pageNumber: number;
  blocks: Block[];
};

// ──────────────────────────────────────────────
// API Types
// ──────────────────────────────────────────────

export type ExportFormat = "pdf" | "png" | "jpg";

export type ExportRequest = {
  fileId: string;
  format: ExportFormat;
  pages: number[];
  blocks?: PageData[];
};

export type ExportResponse = {
  url: string;
  fileName: string;
  format: ExportFormat;
};

export type UploadResponse = {
  fileId: string;
  fileName: string;
  totalPages: number;
  size: number;
};

export type OCRResponse = {
  text: string;
  confidence: number;
  page: number;
};

// ──────────────────────────────────────────────
// Billing Types
// ──────────────────────────────────────────────

export type PlanTier = "free" | "pro" | "enterprise";

export type PlanLimits = {
  tier: PlanTier;
  maxFileSize: number; // MB
  maxExportsPerDay: number;
  ocrEnabled: boolean;
  removeWatermark: boolean;
  prioritySupport: boolean;
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    tier: "free",
    maxFileSize: 10,
    maxExportsPerDay: 3,
    ocrEnabled: false,
    removeWatermark: false,
    prioritySupport: false,
  },
  pro: {
    tier: "pro",
    maxFileSize: 100,
    maxExportsPerDay: 100,
    ocrEnabled: true,
    removeWatermark: true,
    prioritySupport: false,
  },
  enterprise: {
    tier: "enterprise",
    maxFileSize: 500,
    maxExportsPerDay: 9999,
    ocrEnabled: true,
    removeWatermark: true,
    prioritySupport: true,
  },
};

// ──────────────────────────────────────────────
// SEO Types
// ──────────────────────────────────────────────

export type SEOPageData = {
  title: string;
  url: string;
  h1: string;
  description: string;
  content: string;
  keyword: string;
  category: string;
  volume: number;
  difficulty: number;
};

export type CompetitorPageData = {
  title: string;
  url: string;
  competitor: string;
  content: string;
  benefits: string[];
  cta: string;
};

// ──────────────────────────────────────────────
// Ads / ROI Types
// ──────────────────────────────────────────────

export type CampaignStatus = "ACTIVE" | "PAUSED";

export type AdCampaign = {
  id: string;
  name: string;
  platform: "google" | "bing" | "other";
  spend: number;
  clicks: number;
  impressions: number;
  conversions: number;
  revenue: number;
  status: CampaignStatus;
  dailyBudget: number;
};

export type ROIAnalysis = {
  campaignId: string;
  campaignName: string;
  ctr: number;
  cpc: number;
  conversionRate: number;
  roi: number;
  roas: number;
  action: "SCALE" | "HOLD" | "STOP";
  recommendation: string;
};

// ──────────────────────────────────────────────
// Keyword Types
// ──────────────────────────────────────────────

export type KeywordItem = {
  keyword: string;
  slug: string;
  h1: string;
  seoTitle: string;
  description: string;
  content: string;
  volume: number;
  difficulty: number;
  cpc: number;
  category: string;
};
