// ──────────────────────────────────────────────
// V13 Competitor Page Generator — Smallpdf, iLovePDF, PDF24 hijacking
// ──────────────────────────────────────────────

export type CompetitorPage = {
  slug: string;
  title: string;
  h1: string;
  description: string;
  content: string;
  competitor: string;
  cta: string;
};

export function generateCompetitorPage(name: string): CompetitorPage {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const content = `
<h1>${name} Alternative</h1>

<p>Looking for a faster, simpler, and truly free alternative to ${name}?</p>

<p>PDFSail gives you everything ${name} offers — without the limits, without the watermark, and without the signup.</p>

<h2>Why PDFSail beats ${name}</h2>
<ul>
  <li>✅ No signup or account required</li>
  <li>✅ No watermark on your documents</li>
  <li>✅ 100% browser-based — nothing to install</li>
  <li>✅ No file size limits on free tier</li>
  <li>✅ Unlimited exports — pay only for premium features</li>
  <li>✅ Faster processing with no queues</li>
  <li>✅ Your privacy — files process in your browser</li>
</ul>

<h2>Features Comparison</h2>
<table>
  <tr>
    <th>Feature</th>
    <th>PDFSail</th>
    <th>${name}</th>
  </tr>
  <tr>
    <td>Free tier</td>
    <td>✅ Unlimited</td>
    <td>❌ Limited</td>
  </tr>
  <tr>
    <td>Watermark</td>
    <td>✅ None</td>
    <td>❌ Yes (free)</td>
  </tr>
  <tr>
    <td>Signup required</td>
    <td>✅ No</td>
    <td>❌ Often required</td>
  </tr>
  <tr>
    <td>Browser based</td>
    <td>✅ Yes</td>
    <td>❌ Varies</td>
  </tr>
  <tr>
    <td>File size limit</td>
    <td>✅ None on free</td>
    <td>❌ Restricted</td>
  </tr>
</table>

<h2>What Users Say</h2>
<p>"I switched from ${name} to PDFSail and never looked back. It's faster, simpler, and actually free."</p>
<p>"PDFSail does everything ${name} does, but without the headaches. Highly recommended!"</p>

<div class="cta-box">
  <a href="/editor" class="cta-button">Try PDFSail Free →</a>
</div>
`;

  return {
    slug: `${slug}-alternative`,
    title: `Best ${name} Alternative — Free & Better`,
    h1: `${name} Alternative`,
    description: `Looking for a free alternative to ${name}? PDFSail offers everything ${name} does — no signup, no watermark, 100% browser-based.`,
    content,
    competitor: name,
    cta: "/editor",
  };
}

export function generateCompetitorPages(): CompetitorPage[] {
  return COMPETITOR_LIST.map((name) => generateCompetitorPage(name));
}

export function generateCompetitorBatch(list: string[]): CompetitorPage[] {
  return list.map(generateCompetitorPage);
}

export const COMPETITOR_LIST = [
  "Smallpdf",
  "iLovePDF",
  "PDF24",
  "Adobe Acrobat",
  "PDF Candy",
  "Soda PDF",
  "Sejda",
  "Nitro PDF",
  "Foxit PhantomPDF",
  "PDFescape",
  "PDFPro",
  "PDFSimpli",
  "PDF2Go",
  "PDFZilla",
  "LightPDF",
  "HiPDF",
  "PDFfiller",
  "Xodo PDF",
  "PDF Expert for Web",
  "PDF Buddy",
];
