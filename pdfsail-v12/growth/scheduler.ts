// ──────────────────────────────────────────────
// V13 Scheduler — Automated daily/weekly job runner
// ──────────────────────────────────────────────

import { generateFromBaseKeywords } from "./seo/generator.js";
import { generateCompetitorPages } from "./competitor/generator.js";
import { conversionEngine, autoOptimizer } from "./conversion/engine.js";
import { db } from "./db.js";

export type ScheduledJob = {
  id: string;
  name: string;
  intervalMs: number;
  lastRun: number;
  runCount: number;
  fn: () => Promise<void> | void;
};

type JobStatus = "running" | "idle" | "error";

// ──────────────────────────────────────────────
// Scheduler Engine
// ──────────────────────────────────────────────

class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private status: JobStatus = "idle";

  register(job: Omit<ScheduledJob, "lastRun" | "runCount">) {
    this.jobs.set(job.id, {
      ...job,
      lastRun: 0,
      runCount: 0,
    });
  }

  start(jobId?: string) {
    if (jobId) {
      this.startJob(jobId);
    } else {
      for (const id of this.jobs.keys()) {
        this.startJob(id);
      }
    }
    this.status = "running";
  }

  private startJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;

    // Clear existing timer
    this.stopJob(id);

    const timer = setInterval(async () => {
      try {
        job.lastRun = Date.now();
        job.runCount++;
        await job.fn();
      } catch (err) {
        console.error(`[Scheduler] Job "${job.name}" failed:`, err);
      }
    }, job.intervalMs);

    this.timers.set(id, timer);

    // Run immediately on start
    setTimeout(async () => {
      try {
        job.lastRun = Date.now();
        job.runCount++;
        await job.fn();
      } catch (err) {
        console.error(`[Scheduler] Job "${job.name}" initial run failed:`, err);
      }
    }, 1000);
  }

  stop(jobId?: string) {
    if (jobId) {
      this.stopJob(jobId);
    } else {
      for (const id of this.timers.keys()) {
        this.stopJob(id);
      }
      this.status = "idle";
    }
  }

  private stopJob(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  getJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  getStatus(): JobStatus {
    return this.status;
  }

  remove(id: string) {
    this.stopJob(id);
    this.jobs.delete(id);
  }

  clear() {
    this.stop();
    this.jobs.clear();
  }
}

export const scheduler = new Scheduler();

// ──────────────────────────────────────────────
// Built-in Jobs
// ──────────────────────────────────────────────

const ONE_HOUR = 1000 * 60 * 60;
const ONE_DAY = ONE_HOUR * 24;

/** Generate SEO pages from base keywords */
export function registerSEOJob(
  baseKeywords: string[],
  intervalMs = ONE_DAY
) {
  scheduler.register({
    id: "seo-generator",
    name: "SEO Page Generator",
    intervalMs,
    fn: async () => {
      console.log("[SEO Job] Generating pages...");
      const pages = generateFromBaseKeywords(baseKeywords);

      const col = db.collection<{
        id: string;
        slug: string;
        title: string;
        generatedAt: number;
      }>("seo_pages");

      let inserted = 0;
      for (const page of pages) {
        const existing = col.find({ slug: page.slug });
        if (existing.length === 0) {
          col.insert({
            id: page.slug,
            slug: page.slug,
            title: page.title,
            generatedAt: Date.now(),
          });
          inserted++;
        }
      }

      console.log(`[SEO Job] Generated ${inserted} new pages (${pages.length} total)`);
    },
  });
}

/** Generate competitor pages */
export function registerCompetitorJob(intervalMs = ONE_DAY) {
  scheduler.register({
    id: "competitor-generator",
    name: "Competitor Page Generator",
    intervalMs,
    fn: async () => {
      console.log("[Competitor Job] Generating pages...");
      const pages = generateCompetitorPages();

      const col = db.collection<{
        id: string;
        slug: string;
        competitor: string;
        generatedAt: number;
      }>("competitor_pages");

      let inserted = 0;
      for (const page of pages) {
        const existing = col.find({ slug: page.slug });
        if (existing.length === 0) {
          col.insert({
            id: page.slug,
            slug: page.slug,
            competitor: page.competitor,
            generatedAt: Date.now(),
          });
          inserted++;
        }
      }

      console.log(`[Competitor Job] Generated ${inserted} new pages`);
    },
  });
}

/** Optimize ads based on conversion data */
export function registerAdsOptimizationJob(intervalMs = ONE_HOUR * 6) {
  scheduler.register({
    id: "ads-optimizer",
    name: "Ads ROI Optimizer",
    intervalMs,
    fn: async () => {
      console.log("[Ads Job] Running auto-optimization...");
      // In production, this would read from ad platform APIs
      const campaigns = db
        .collection<{
          id: string;
          name: string;
          clicks: number;
          conversions: number;
          spend: number;
        }>("ad_campaigns")
        .find();

      if (campaigns.length === 0) {
        console.log("[Ads Job] No campaigns to optimize");
        return;
      }

      const decisions = autoOptimizer.decideBatch(campaigns);
      const paused = decisions.filter((d) => d.decision.action === "PAUSE_ADS");
      const scaled = decisions.filter((d) => d.decision.action === "SCALE_ADS");

      console.log(
        `[Ads Job] Analyzed ${campaigns.length} campaigns: ` +
          `PAUSED ${paused.length}, SCALED ${scaled.length}`
      );
    },
  });
}

/** Daily cleanup and maintenance */
export function registerMaintenanceJob(intervalMs = ONE_DAY) {
  scheduler.register({
    id: "maintenance",
    name: "Daily Maintenance",
    intervalMs,
    fn: async () => {
      console.log("[Maintenance] Running daily cleanup...");
      // Clear old logs
      conversionEngine.clear();

      // Log health
      const seoCount = db.collection("seo_pages").count();
      const compCount = db.collection("competitor_pages").count();
      const campaignCount = db.collection("ad_campaigns").count();

      console.log(
        `[Maintenance] Health: ${seoCount} SEO pages, ${compCount} competitor pages, ${campaignCount} campaigns`
      );
    },
  });
}

/** Register all default jobs */
export function registerAllDefaultJobs(baseKeywords: string[]) {
  registerSEOJob(baseKeywords);
  registerCompetitorJob();
  registerAdsOptimizationJob();
  registerMaintenanceJob();
}

// ──────────────────────────────────────────────
// Helper: run once immediately (for dev/testing)
// ──────────────────────────────────────────────

export function runOnce(fn: () => void) {
  return setImmediate(fn);
}

/** Run all jobs once immediately, then schedule */
export function initAndStart(baseKeywords: string[]) {
  registerAllDefaultJobs(baseKeywords);
  scheduler.start();
  console.log("[Scheduler] All jobs registered and running");
  return scheduler;
}
