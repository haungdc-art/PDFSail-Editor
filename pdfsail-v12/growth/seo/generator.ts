// ──────────────────────────────────────────────
// V13 AI SEO Generator — Template-based bulk page generation
// ──────────────────────────────────────────────

export type SEOPage = {
  slug: string;
  title: string;
  h1: string;
  description: string;
  content: string;
  keyword: string;
  category?: string;
  volume?: number;
  difficulty?: number;
};

// Title templates — randomly selected per keyword
const titleTemplates = [
  "Free online {keyword} tool — No signup needed",
  "Best way to {keyword} in seconds",
  "{keyword} — fast & secure PDF tool",
  "How to {keyword} online for free",
  "{keyword} instantly in your browser",
  "The easiest way to {keyword}",
  "Free {keyword} — no limits, no watermark",
  "{keyword} online — try it now",
];

const h1Templates = [
  "Free Online Tool to {keyword}",
  "How to {keyword} — Fast & Free",
  "{keyword} Online",
  "Best {keyword} Tool",
];

const descriptionTemplates = [
  "Use PDFSail to {keyword} instantly in your browser. No signup, no watermark, 100% free.",
  "Free online tool to {keyword}. Fast, secure, and works on any device. Try it now!",
  "Looking to {keyword}? PDFSail makes it easy. Free, browser-based, no installation needed.",
];

const contentSections = [
  `<h2>How to {keyword}</h2>
<p>Upload your PDF file, make your changes, and download the result. It's that simple with PDFSail.</p>
<p>No software to install, no account to create. Everything runs securely in your browser.</p>`,

  `<h2>Why Choose PDFSail for {keyword}?</h2>
<ul>
  <li>✅ 100% free — no hidden fees or credit card required</li>
  <li>✅ No signup or registration needed</li>
  <li>✅ Works in your browser — nothing to download</li>
  <li>✅ No file size limits</li>
  <li>✅ No watermarks on your documents</li>
  <li>✅ Fast processing — results in seconds</li>
</ul>`,

  `<h2>What Users Say</h2>
<p>"PDFSail is the best tool for {keyword}. I use it every day and it never disappoints."</p>
<p>"Finally a free tool that works! No limits, no tricks, just {keyword} done right."</p>`,

  `<h2>Frequently Asked Questions</h2>
<h3>Is it really free to {keyword}?</h3>
<p>Yes! PDFSail is completely free. There are no hidden charges, no premium tiers, and no credit card required.</p>
<h3>Do I need to create an account?</h3>
<p>No account needed. Just upload your file and start editing immediately.</p>
<h3>Is my data secure?</h3>
<p>Yes. All processing happens in your browser. Your files are never uploaded to our servers unless you choose to export.</p>`,
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fill(template: string, keyword: string): string {
  return template.replace(/\{keyword\}/g, keyword);
}

export function generateSEOPage(keyword: string, options?: {
  category?: string;
  volume?: number;
  difficulty?: number;
}): SEOPage {
  const title = fill(pick(titleTemplates), keyword);
  const h1 = fill(pick(h1Templates), keyword.charAt(0).toUpperCase() + keyword.slice(1));
  const description = fill(pick(descriptionTemplates), keyword);

  // Build content from sections, shuffled for variety
  const shuffled = [...contentSections].sort(() => Math.random() - 0.5);
  const selectedSections = shuffled.slice(0, 2 + Math.floor(Math.random() * 2));

  const contentBody = selectedSections
    .map((s) => fill(s, keyword))
    .join("\n");

  const cta = `<div class="cta-box">
  <a href="/editor" class="cta-button">Start {keyword} Now — Free →</a>
</div>`;

  const content = `${fill(cta, keyword)}\n${contentBody}\n${fill(cta, keyword)}`;

  return {
    slug: keyword.toLowerCase().replace(/\s+/g, "-"),
    title,
    h1,
    description,
    content,
    keyword,
    category: options?.category || "general",
    volume: options?.volume || 1000,
    difficulty: options?.difficulty || 30,
  };
}

export function generateSEOPages(): SEOPage[] {
  return PREDEFINED_KEYWORDS.map((k) =>
    generateSEOPage(k.keyword, {
      category: k.category,
      volume: k.volume,
      difficulty: k.difficulty,
    })
  );
}

export function generateBatch(keywords: string[]): SEOPage[] {
  return keywords.map((k) => generateSEOPage(k));
}

// ──────────────────────────────────────────────
// 1000+ Expansion Keyword Patterns
// ──────────────────────────────────────────────

export function expandKeywords(baseKeywords: string[]): string[] {
  const actions = [
    "edit", "merge", "split", "compress", "convert", "rotate",
    "sign", "unlock", "resize", "delete pages from", "extract pages from",
    "reorder pages in", "add text to", "add image to", "remove text from",
    "remove image from", "watermark", "stamp", "number pages in",
    "flatten", "optimize", "reduce size of", "change format of",
  ];
  const qualifiers = [
    "online free", "free online", "in browser", "without signup",
    "without watermark", "without installing software", "quickly",
    "in seconds", "on mac", "on windows", "on linux", "on mobile",
    "high quality", "for free", "no limits",
  ];

  const expanded = new Set<string>();

  for (const base of baseKeywords) {
    expanded.add(base);
    for (const action of actions) {
      expanded.add(`${action} ${base}`);
    }
    for (const q of qualifiers) {
      expanded.add(`${base} ${q}`);
    }
    for (const action of actions) {
      for (const q of qualifiers) {
        expanded.add(`${action} ${base} ${q}`);
      }
    }
  }

  return Array.from(expanded).slice(0, 1500);
}

export function generateFromBaseKeywords(baseKeywords: string[]): SEOPage[] {
  const allKeywords = expandKeywords(baseKeywords);
  return generateBatch(allKeywords);
}

// ──────────────────────────────────────────────
// Base Keywords (seed list — expand to 1000+ pages)
// ──────────────────────────────────────────────

export const PREDEFINED_KEYWORDS = [
  { keyword: "edit PDF", category: "edit", volume: 33000, difficulty: 65 },
  { keyword: "merge PDF files", category: "merge", volume: 45000, difficulty: 72 },
  { keyword: "compress PDF", category: "compress", volume: 38000, difficulty: 68 },
  { keyword: "convert PDF to Word", category: "convert", volume: 52000, difficulty: 75 },
  { keyword: "split PDF", category: "split", volume: 28000, difficulty: 45 },
  { keyword: "rotate PDF pages", category: "edit", volume: 12000, difficulty: 25 },
  { keyword: "sign PDF", category: "sign", volume: 20000, difficulty: 40 },
  { keyword: "unlock PDF", category: "security", volume: 18000, difficulty: 35 },
  { keyword: "PDF OCR", category: "ocr", volume: 15000, difficulty: 30 },
  { keyword: "delete pages from PDF", category: "edit", volume: 16000, difficulty: 28 },
  { keyword: "reorder PDF pages", category: "edit", volume: 8000, difficulty: 20 },
  { keyword: "extract PDF pages", category: "split", volume: 14000, difficulty: 32 },
  { keyword: "resize PDF", category: "edit", volume: 9000, difficulty: 22 },
  { keyword: "PDF to JPG", category: "convert", volume: 25000, difficulty: 50 },
  { keyword: "PDF to PNG", category: "convert", volume: 11000, difficulty: 28 },
  { keyword: "add text to PDF", category: "edit", volume: 12000, difficulty: 35 },
  { keyword: "remove text from PDF", category: "edit", volume: 8000, difficulty: 30 },
  { keyword: "watermark PDF", category: "security", volume: 7000, difficulty: 25 },
  { keyword: "flatten PDF", category: "edit", volume: 5000, difficulty: 20 },
  { keyword: "optimize PDF", category: "compress", volume: 6000, difficulty: 22 },
];

export const BASE_KEYWORDS = PREDEFINED_KEYWORDS.map((k) => k.keyword);
