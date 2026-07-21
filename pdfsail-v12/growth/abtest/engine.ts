// ──────────────────────────────────────────────
// V13 A/B Test System — Title optimization engine
// ──────────────────────────────────────────────

export type ABVariant = {
  id: string;
  title: string;
  clicks: number;
  impressions: number;
  startDate: number;
};

export type ABTestResult = {
  variantId: string;
  title: string;
  clicks: number;
  impressions: number;
  ctr: number;
  isWinner: boolean;
};

export class ABTestEngine {
  private variants: Map<string, ABVariant> = new Map();
  private history: Map<string, ABTestResult[]> = new Map();
  private testName: string;

  constructor(testName = "default") {
    this.testName = testName;
  }

  create(title: string): string {
    const id = `ab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.variants.set(id, {
      id,
      title,
      clicks: 0,
      impressions: 0,
      startDate: Date.now(),
    });
    return id;
  }

  createBatch(titles: string[]): string[] {
    return titles.map((t) => this.create(t));
  }

  trackImpression(id: string) {
    const v = this.variants.get(id);
    if (v) {
      v.impressions++;
    }
  }

  trackClick(id: string) {
    const v = this.variants.get(id);
    if (v) {
      v.clicks++;
    }
  }

  /** Get the variant with the highest CTR */
  getBest(): ABVariant | null {
    let best: ABVariant | null = null;
    let bestCTR = -1;

    for (const v of this.variants.values()) {
      const ctr = v.impressions > 0 ? v.clicks / v.impressions : 0;
      if (ctr > bestCTR) {
        bestCTR = ctr;
        best = v;
      }
    }

    return best;
  }

  /** Get all variants sorted by CTR (descending) */
  getRanked(): ABVariant[] {
    return Array.from(this.variants.values()).sort(
      (a, b) =>
        (b.clicks / Math.max(b.impressions, 1)) -
        (a.clicks / Math.max(a.impressions, 1))
    );
  }

  /** Get results with computed CTR */
  getResults(): ABTestResult[] {
    const best = this.getBest();
    return this.getRanked().map((v) => ({
      variantId: v.id,
      title: v.title,
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: v.impressions > 0 ? v.clicks / v.impressions : 0,
      isWinner: best !== null && v.id === best.id,
    }));
  }

  /** Reset all data for a fresh test */
  reset() {
    this.variants.clear();
  }

  /** Save current results to history */
  snapshot() {
    if (this.variants.size === 0) return;
    const results = this.getResults();
    const key = `${this.testName}-${Date.now()}`;
    this.history.set(key, results);
    return key;
  }

  /** Get historical test results */
  getHistory(): Map<string, ABTestResult[]> {
    return new Map(this.history);
  }

  /** Get total impressions across all variants */
  get totalImpressions(): number {
    return Array.from(this.variants.values()).reduce(
      (sum, v) => sum + v.impressions,
      0
    );
  }

  /** Get total clicks across all variants */
  get totalClicks(): number {
    return Array.from(this.variants.values()).reduce(
      (sum, v) => sum + v.clicks,
      0
    );
  }
}

// ──────────────────────────────────────────────
// Pre-built test templates for common scenarios
// ──────────────────────────────────────────────

export const TITLE_TEST_TEMPLATES: Record<string, string[]> = {
  "editor-cta": [
    "Free Online PDF Editor — Edit Instantly",
    "Edit PDF Free Without Signup",
    "Fastest PDF Tool in Your Browser",
    "Best PDF Editor Online — No Limits",
  ],
  "merge-cta": [
    "Merge PDFs Free Online — Combine Files",
    "Best Way to Merge PDF Files",
    "Free PDF Merger — No Watermark",
    "Merge PDF Instantly in Browser",
  ],
  "landing-hero": [
    "Your Complete PDF Toolkit — Free",
    "Everything You Need for PDFs",
    "Free Online PDF Tools — No Signup",
    "The Smart Way to Work with PDFs",
  ],
};
