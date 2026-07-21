// ──────────────────────────────────────────────
// PDF Value Probe v0 — Analyzer Rule Engine
// Pure rules-based, no AI, no LLM, no embeddings
// ──────────────────────────────────────────────

export type AnalyzeInput = {
  text: string;
  pageCount: number;
  hasImages: boolean;
};

export type AnalyzeResult = {
  valueFlag: "YES" | "NO" | "UNCERTAIN";
  signals: string[];
  score: number;
};

/**
 * Core rule engine — heuristic scoring based on keyword + structure signals.
 *
 * Design principle: "Document second-action likelihood detector"
 * Not AI, just signal detection.
 *
 * Score thresholds:
 *   >= 5 → YES (document has secondary value potential)
 *   <= 2 → NO  (single-use document)
 *   3-4  → UNCERTAIN (ignore in v0 analysis)
 */
export function analyze(doc: AnalyzeInput): AnalyzeResult {
  let score = 0;
  const signals: string[] = [];
  const text = doc.text.toLowerCase();

  // ① Page count signal
  if (doc.pageCount >= 5) {
    score += 2;
    signals.push("multi_page");
  }

  // ② Table-like structure signal
  //   Pipe characters, "table" keyword, percentage patterns
  if (
    text.includes("|") ||
    text.includes("table") ||
    /\d{2,}%/.test(text) ||
    text.includes("column") ||
    text.includes("row")
  ) {
    score += 2;
    signals.push("table_like_structure");
  }

  // ③ Financial document signal
  const financeKeywords = [
    "invoice", "amount", "total", "tax", "payment",
    "balance", "usd", "amount due", "subtotal",
    "receipt", "transaction", "refund",
  ];
  if (financeKeywords.some((k) => text.includes(k))) {
    score += 3;
    signals.push("financial_document");
  }

  // ④ Contract / legal document signal
  const contractKeywords = [
    "agreement", "contract", "party", "terms",
    "liability", "termination", "hereby",
    "indemnify", "confidential", "clause",
  ];
  if (contractKeywords.some((k) => text.includes(k))) {
    score += 3;
    signals.push("contract_document");
  }

  // ⑤ Scanned / OCR-needed signal
  //   Very little text extracted + images present
  if (text.length < 200 && doc.hasImages) {
    score += 2;
    signals.push("likely_scanned");
  }

  // ⑥ Rich text signal
  if (text.length > 2000) {
    score += 2;
    signals.push("rich_text");
  }

  // Decision
  let valueFlag: "YES" | "NO" | "UNCERTAIN" = "UNCERTAIN";
  if (score >= 5) valueFlag = "YES";
  else if (score <= 2) valueFlag = "NO";

  return { valueFlag, signals, score };
}

/**
 * Recommend a single action based on dominant signals.
 * Returns exactly ONE action — no list, no workflow.
 */
export function recommendAction(signals: string[]): {
  action: "extract_tables" | "ocr_text" | "convert_word";
  reason: string;
  title: string;
} {
  // Priority: financial/table → scanned → contract/rich text → default
  if (signals.includes("financial_document") || signals.includes("table_like_structure")) {
    return {
      action: "extract_tables",
      title: "Extract Tables from this document",
      reason: "We detected structured financial data that can be converted to a spreadsheet",
    };
  }

  if (signals.includes("likely_scanned")) {
    return {
      action: "ocr_text",
      title: "OCR — Convert images to searchable text",
      reason: "This document appears to be scanned, text can be unlocked with OCR",
    };
  }

  if (signals.includes("contract_document") || signals.includes("rich_text")) {
    return {
      action: "convert_word",
      title: "Convert to Editable Word Document",
      reason: "We detected rich text content ready for editing",
    };
  }

  // Fallback
  return {
    action: "extract_tables",
    title: "Extract Tables from this document",
    reason: "We detected structured data that can be converted to a spreadsheet",
  };
}
