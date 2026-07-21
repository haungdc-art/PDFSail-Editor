import type { KeywordItem } from "../shared/types.js";
import { keywords } from "../shared/keywords.js";

export interface KeywordData {
  keyword: string;
  volume: number;
  difficulty: number;
  cpc: number;
  category: string;
}

export class KeywordDB {
  private keywords: KeywordData[] = [];

  constructor() {
    this.seed();
  }

  private seed() {
    this.keywords = keywords.map((k) => ({
      keyword: k.keyword,
      volume: k.volume,
      difficulty: k.difficulty,
      cpc: k.cpc,
      category: k.category,
    }));
  }

  search(query: string): KeywordData[] {
    const q = query.toLowerCase();
    return this.keywords.filter(
      (k) =>
        k.keyword.toLowerCase().includes(q) ||
        k.category.toLowerCase().includes(q)
    );
  }

  getByCategory(category: string): KeywordData[] {
    return this.keywords.filter((k) => k.category === category);
  }

  getLowDifficulty(maxDifficulty = 30): KeywordData[] {
    return this.keywords
      .filter((k) => k.difficulty <= maxDifficulty)
      .sort((a, b) => b.volume - a.volume);
  }

  getHighVolume(minVolume = 1000): KeywordData[] {
    return this.keywords
      .filter((k) => k.volume >= minVolume)
      .sort((a, b) => a.difficulty - b.difficulty);
  }

  /** Best SEO opportunities: high volume + low difficulty */
  getBestOpportunities(): KeywordData[] {
    return this.keywords
      .filter((k) => k.difficulty <= 40 && k.volume >= 500)
      .sort((a, b) => b.volume / b.difficulty - a.volume / a.difficulty);
  }

  /** Get keywords sorted by CPC (high value) */
  getHighCPC(minCpc = 2.0): KeywordData[] {
    return this.keywords
      .filter((k) => k.cpc >= minCpc)
      .sort((a, b) => b.cpc - a.cpc);
  }

  /** All keywords */
  getAll(): KeywordData[] {
    return [...this.keywords];
  }

  /** Total search volume across all keywords */
  getTotalVolume(): number {
    return this.keywords.reduce((sum, k) => sum + k.volume, 0);
  }
}

export const keywordDB = new KeywordDB();
