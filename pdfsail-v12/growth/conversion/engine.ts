// ──────────────────────────────────────────────
// V13 Conversion Optimization Engine — CVR tracking + Auto decision
// ──────────────────────────────────────────────

export type ConversionResult = {
  cvr: number;
  clicks: number;
  conversions: number;
  status: "FAIL" | "OK" | "GOOD";
};

export type AutoDecision =
  | { action: "PAUSE_ADS"; reason: string }
  | { action: "SCALE_ADS"; reason: string; scaleFactor: number }
  | { action: "HOLD"; reason: string }
  | { action: "OPTIMIZE"; reason: string };

export class ConversionEngine {
  private eventLog: Array<{
    timestamp: number;
    page: string;
    clicks: number;
    conversions: number;
    cvr: number;
  }> = [];

  evaluate(clicks: number, conversions: number): ConversionResult {
    const cvr = conversions / Math.max(clicks, 1);
    return {
      cvr,
      clicks,
      conversions,
      status: cvr < 0.01 ? "FAIL" : cvr < 0.05 ? "OK" : "GOOD",
    };
  }

  logEvent(page: string, clicks: number, conversions: number) {
    const cvr = conversions / Math.max(clicks, 1);
    this.eventLog.push({
      timestamp: Date.now(),
      page,
      clicks,
      conversions,
      cvr,
    });
  }

  /** Get rolling average CVR over last N events */
  getRollingAverage(count = 10): number {
    const recent = this.eventLog.slice(-count);
    const totalClicks = recent.reduce((s, e) => s + e.clicks, 0);
    const totalConversions = recent.reduce((s, e) => s + e.conversions, 0);
    return totalConversions / Math.max(totalClicks, 1);
  }

  /** Get CVR trend (is it improving or declining?) */
  getTrend(windowSize = 5): "improving" | "declining" | "stable" {
    if (this.eventLog.length < windowSize * 2) return "stable";

    const recent = this.getRollingAverage(windowSize);
    const older = this.getRollingAverage(windowSize * 2);

    if (recent > older * 1.1) return "improving";
    if (recent < older * 0.9) return "declining";
    return "stable";
  }

  getHistory() {
    return [...this.eventLog];
  }

  clear() {
    this.eventLog = [];
  }
}

// ──────────────────────────────────────────────
// Auto Optimizer — Automated ad spend decisions
// ──────────────────────────────────────────────

export class AutoOptimizer {
  private conversionEngine: ConversionEngine;
  private readonly PAUSE_THRESHOLD = 0.01; // 1% CVR
  private readonly SCALE_THRESHOLD = 0.08; // 8% CVR
  private readonly MIN_CLICKS_FOR_DECISION = 100;

  constructor(conversionEngine?: ConversionEngine) {
    this.conversionEngine = conversionEngine || new ConversionEngine();
  }

  setConversionEngine(engine: ConversionEngine) {
    this.conversionEngine = engine;
  }

  getConversionEngine(): ConversionEngine {
    return this.conversionEngine;
  }

  /**
   * Make an automated decision based on clicks and conversions
   */
  decide(
    clicks: number,
    conversions: number,
    context?: {
      page?: string;
      campaignId?: string;
      currentSpend?: number;
    }
  ): AutoDecision {
    const cvr = conversions / Math.max(clicks, 1);

    // Log to history
    if (context?.page) {
      this.conversionEngine.logEvent(context.page, clicks, conversions);
    }

    // Not enough data to decide
    if (clicks < this.MIN_CLICKS_FOR_DECISION) {
      return {
        action: "HOLD",
        reason: `Not enough data (${clicks} clicks). Need ${this.MIN_CLICKS_FOR_DECISION} minimum.`,
      };
    }

    // FAIL — pause ads
    if (cvr < this.PAUSE_THRESHOLD) {
      return {
        action: "PAUSE_ADS",
        reason: `CVR ${(cvr * 100).toFixed(2)}% below threshold ${(this.PAUSE_THRESHOLD * 100).toFixed(2)}%. Pausing campaign "${context?.campaignId || "unknown"}" to stop losses. Estimated savings: $${(context?.currentSpend || 0).toFixed(2)}.`,
      };
    }

    // GOOD — scale ads
    if (cvr > this.SCALE_THRESHOLD) {
      const scaleFactor = Math.min(1.5, cvr / this.SCALE_THRESHOLD);
      return {
        action: "SCALE_ADS",
        reason: `CVR ${(cvr * 100).toFixed(2)}% exceeds threshold ${(this.SCALE_THRESHOLD * 100).toFixed(2)}%. Scaling budget by ${Math.round((scaleFactor - 1) * 100)}%.`,
        scaleFactor,
      };
    }

    // OK but not great — hold with optimization suggestions
    const potential =
      ((this.SCALE_THRESHOLD - cvr) / cvr) * 100;
    return {
      action: "HOLD",
      reason: `CVR ${(cvr * 100).toFixed(2)}% is acceptable. Optimize to improve ${potential.toFixed(0)}% to reach scale threshold.`,
    };
  }

  /** Batch decide on multiple campaigns */
  decideBatch(
    campaigns: Array<{
      id: string;
      name: string;
      clicks: number;
      conversions: number;
      spend: number;
    }>
  ): Array<{ campaignId: string; campaignName: string; decision: AutoDecision }> {
    return campaigns.map((c) => ({
      campaignId: c.id,
      campaignName: c.name,
      decision: this.decide(c.clicks, c.conversions, {
        page: c.name,
        campaignId: c.id,
        currentSpend: c.spend,
      }),
    }));
  }
}

export const conversionEngine = new ConversionEngine();
export const autoOptimizer = new AutoOptimizer(conversionEngine);
