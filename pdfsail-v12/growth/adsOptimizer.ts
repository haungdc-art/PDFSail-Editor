import type { AdCampaign, ROIAnalysis } from "../shared/types.js";

export class AdsOptimizer {
  private campaigns = new Map<string, AdCampaign>();
  private history: ROIAnalysis[] = [];
  private readonly PROFIT_THRESHOLD = 1.0; // ROAS break-even
  private readonly SCALE_THRESHOLD = 2.0; // ROAS for scaling

  registerCampaign(campaign: AdCampaign) {
    this.campaigns.set(campaign.id, { ...campaign });
  }

  updateCampaign(id: string, data: Partial<AdCampaign>) {
    const campaign = this.campaigns.get(id);
    if (campaign) {
      Object.assign(campaign, data);
    }
  }

  /** Clicks & conversions tracking */
  track(clicks: number, conversions: number) {
    const roi = conversions / Math.max(clicks, 1);
    return {
      roi,
      action: roi < 0.5 ? "STOP" : roi > 2 ? "SCALE" : "HOLD",
    } as const;
  }

  analyze(id: string): ROIAnalysis | null {
    const campaign = this.campaigns.get(id);
    if (!campaign) return null;

    const ctr =
      campaign.impressions > 0
        ? (campaign.clicks / campaign.impressions) * 100
        : 0;

    const cpc =
      campaign.clicks > 0 ? campaign.spend / campaign.clicks : 0;

    const conversionRate =
      campaign.clicks > 0
        ? (campaign.conversions / campaign.clicks) * 100
        : 0;

    const roi =
      campaign.spend > 0
        ? (campaign.revenue - campaign.spend) / campaign.spend
        : 0;

    const roas =
      campaign.spend > 0 ? campaign.revenue / campaign.spend : 0;

    let action: "SCALE" | "HOLD" | "STOP";
    let recommendation: string;

    if (roas < this.PROFIT_THRESHOLD) {
      action = "STOP";
      recommendation = `ROAS ${roas.toFixed(2)}x below break-even (${this.PROFIT_THRESHOLD}x). Pausing campaign "${campaign.name}" to stop losses.`;
    } else if (roas >= this.SCALE_THRESHOLD) {
      action = "SCALE";
      const increase = Math.min(30, Math.round((roas - this.SCALE_THRESHOLD) * 15 + 20));
      recommendation = `ROAS ${roas.toFixed(2)}x — strong performance. Increase budget by ${increase}% for "${campaign.name}".`;
    } else {
      action = "HOLD";
      const potentialIncrease = ((this.SCALE_THRESHOLD - roas) / roas) * 100;
      recommendation = `ROAS ${roas.toFixed(2)}x — acceptable. Optimize creatives to improve ${potentialIncrease.toFixed(0)}% to reach scale threshold.`;
    }

    const analysis: ROIAnalysis = {
      campaignId: id,
      campaignName: campaign.name,
      ctr,
      cpc,
      conversionRate,
      roi,
      roas,
      action,
      recommendation,
    };

    this.history.push(analysis);
    return analysis;
  }

  analyzeAll(): ROIAnalysis[] {
    return Array.from(this.campaigns.keys())
      .map((id) => this.analyze(id))
      .filter((a): a is ROIAnalysis => a !== null);
  }

  getActiveCampaigns(): AdCampaign[] {
    return Array.from(this.campaigns.values()).filter(
      (c) => c.status === "ACTIVE"
    );
  }

  /** Auto-optimize all active campaigns:
   *  - Stop campaigns below profit threshold
   *  - Return list of campaigns to scale
   */
  autoOptimize(): { scaled: string[]; stopped: string[] } {
    const scaled: string[] = [];
    const stopped: string[] = [];

    for (const [, campaign] of this.campaigns) {
      if (campaign.status !== "ACTIVE") continue;

      const analysis = this.analyze(campaign.id);
      if (!analysis) continue;

      if (analysis.action === "STOP") {
        campaign.status = "PAUSED";
        stopped.push(campaign.id);
        console.log(
          `[AdsOptimizer] STOPPED ${campaign.name} (ROAS: ${analysis.roas.toFixed(2)}x)`
        );
      } else if (analysis.action === "SCALE") {
        campaign.dailyBudget = Math.round(campaign.dailyBudget * 1.25);
        scaled.push(campaign.id);
        console.log(
          `[AdsOptimizer] SCALING ${campaign.name} budget to $${campaign.dailyBudget}/day`
        );
      }
    }

    return { scaled, stopped };
  }

  getHistory(): ROIAnalysis[] {
    return [...this.history];
  }

  /** Demo campaign data for testing */
  seedDemoData() {
    const demos: AdCampaign[] = [
      {
        id: "camp-001",
        name: "PDF Editor - Google Ads",
        platform: "google",
        spend: 500,
        clicks: 120,
        impressions: 5000,
        conversions: 15,
        revenue: 750,
        status: "ACTIVE",
        dailyBudget: 50,
      },
      {
        id: "camp-002",
        name: "Merge PDF - Bing Ads",
        platform: "bing",
        spend: 200,
        clicks: 45,
        impressions: 1800,
        conversions: 3,
        revenue: 120,
        status: "ACTIVE",
        dailyBudget: 25,
      },
      {
        id: "camp-003",
        name: "Competitor: smallpdf",
        platform: "google",
        spend: 350,
        clicks: 80,
        impressions: 3200,
        conversions: 8,
        revenue: 320,
        status: "ACTIVE",
        dailyBudget: 40,
      },
      {
        id: "camp-004",
        name: "Compress PDF - Facebook",
        platform: "google",
        spend: 150,
        clicks: 30,
        impressions: 1200,
        conversions: 1,
        revenue: 40,
        status: "ACTIVE",
        dailyBudget: 20,
      },
      {
        id: "camp-005",
        name: "SEO: PDF to Word",
        platform: "google",
        spend: 100,
        clicks: 25,
        impressions: 900,
        conversions: 6,
        revenue: 300,
        status: "ACTIVE",
        dailyBudget: 15,
      },
    ];

    demos.forEach((d) => this.registerCampaign(d));
    console.log(`[AdsOptimizer] Seeded ${demos.length} demo campaigns`);
  }
}

export const adsOptimizer = new AdsOptimizer();
