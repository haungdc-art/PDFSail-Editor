import React, { useState, useEffect, useCallback } from "react";

const API = import.meta.env.VITE_API_BASE || "";

type Tab = "overview" | "seo" | "competitor" | "abtest" | "conversion" | "ads" | "scheduler" | "db" | "valueprobe";

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    if (tab === "overview") fetch(`${API}/api/v13/status`).then(r => r.json()).then(setStatus).catch(() => {});
  }, [tab]);

  const nav: { key: Tab; label: string }[] = [
    { key: "overview", label: "📊 Overview" },
    { key: "seo", label: "🔍 SEO v2" },
    { key: "competitor", label: "⚔️ Competitor" },
    { key: "abtest", label: "🧪 A/B Test" },
    { key: "conversion", label: "📈 Conversion" },
    { key: "ads", label: "💰 Ads Optimizer" },
    { key: "scheduler", label: "⏱ Scheduler" },
    { key: "db", label: "🗄 Database" },
    { key: "valueprobe", label: "🔬 Value Probe" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "calc(100vh - 60px)", fontFamily: "system-ui,sans-serif" }}>
      <div style={{ width: 200, flexShrink: 0, background: "#0f0f23", color: "#ccc", padding: "16px 0", fontSize: 13 }}>
        <div style={{ padding: "0 16px 12px", fontSize: 11, fontWeight: 700, color: "#7c5cfc", textTransform: "uppercase", letterSpacing: 1 }}>Growth Engine</div>
        {nav.map((n) => (
          <div key={n.key}
            onClick={() => setTab(n.key)}
            style={{ padding: "10px 16px", cursor: "pointer", background: tab === n.key ? "rgba(124,92,252,0.15)" : "transparent", borderLeft: tab === n.key ? "3px solid #7c5cfc" : "3px solid transparent", color: tab === n.key ? "#fff" : "#888", fontWeight: tab === n.key ? 600 : 400 }}
          >{n.label}</div>
        ))}
      </div>
      <div style={{ flex: 1, padding: 24, background: "#f8fafc", overflowY: "auto" }}>
        {tab === "overview" && <OverviewPanel status={status} />}
        {tab === "seo" && <SEOPanel />}
        {tab === "competitor" && <CompetitorPanel />}
        {tab === "abtest" && <ABTestPanel />}
        {tab === "conversion" && <ConversionPanel />}
        {tab === "ads" && <AdsPanel />}
        {tab === "scheduler" && <SchedulerPanel />}
        {tab === "db" && <DBPanel />}
        {tab === "valueprobe" && <ValueProbePanel />}
      </div>
    </div>
  );
}

function OverviewPanel({ status }: { status: any }) {
  return (
    <div>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, color: "#1e293b" }}>System Overview</h2>
      {!status && <p style={{ color: "#94a3b8" }}>Loading...</p>}
      {status && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 16 }}>
          <StatCard label="Version" value={status.version} />
          <StatCard label="Scheduler" value={status.scheduler} />
          <StatCard label="Jobs" value={String(status.jobs)} />
          <StatCard label="Base Keywords" value={String(status.baseKeywords)} />
          <StatCard label="Competitors" value={String(status.competitors)} />
          {status.modules?.map((m: any) => <StatCard key={m.name} label={m.name} value={typeof m.pages === "number" ? `${m.pages} pages` : String(m.active || m.events || m.jobs || "OK")} />)}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", padding: "16px" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1e293b" }}>{value}</div>
    </div>
  );
}

// ── SEO v2 Panel ──

function SEOPanel() {
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [seed, setSeed] = useState("edit pdf");
  const [v2, setV2] = useState<any>(null);
  const [faqOpen, setFaqOpen] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch(`${API}/api/v13/seo/pages`); const d = await r.json(); setPages(d.pages || []); } catch {}
    setLoading(false);
  }, []);
  const generate = useCallback(async () => {
    setLoading(true);
    try { await fetch(`${API}/api/v13/seo/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromBase: true }) }); await load(); } catch {}
    setLoading(false);
  }, [load]);
  const runV2 = useCallback(() => {
    const mods = ["free","online","without signup","no watermark","best","alternative","tool","editor","in browser","on mac"];
    const kw = [...new Set([seed, ...mods.map(m=>`${seed} ${m}`), `how to ${seed}`, `${seed} for free`])].slice(0,10);
    const faq = [
      {q:`How to ${seed}?`,a:`Upload PDF → Select tool → Download. No signup needed.`},
      {q:`Is ${seed} free?`,a:`Yes! PDFSail is 100% free with no watermark or limits.`},
      {q:`Can I ${seed} online?`,a:`Everything runs in browser. Nothing to install.`},
      {q:`Best tool for ${seed}?`,a:`PDFSail is the fastest and most reliable.`},
    ];
    setV2({ keywords: kw, faq });
    setFaqOpen(true);
  }, [seed]);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20, flexWrap:"wrap" }}>
        <h2 style={{ margin:0, fontSize:20, color:"#1e293b" }}>🔍 SEO v2 — Page Factory</h2>
        <button onClick={generate} disabled={loading} style={{ padding:"8px 16px", background:"#7c5cfc", color:"#fff", border:"none", borderRadius:6, cursor:"pointer", fontSize:13, fontWeight:600, opacity:loading?0.5:1 }}>{loading?"Generating...":"Generate All"}</button>
      </div>
      <div style={{ background:"#fff", borderRadius:10, border:"1px solid #e2e8f0", padding:20, marginBottom:20 }}>
        <div style={{ fontSize:14, fontWeight:700, color:"#7c5cfc", marginBottom:12 }}>🚀 Keyword Discovery + FAQ + Internal Links</div>
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <input value={seed} onChange={e=>setSeed(e.target.value)} style={{ flex:1, padding:"8px 12px", borderRadius:6, border:"1px solid #e2e8f0", fontSize:13 }} placeholder="Seed keyword" />
          <button onClick={runV2} style={{ padding:"8px 20px", background:"#059669", color:"#fff", border:"none", borderRadius:6, cursor:"pointer", fontSize:13, fontWeight:600 }}>Discover</button>
        </div>
        {v2 && (
          <div style={{ fontSize:12, color:"#475569" }}>
            <div style={{ fontWeight:600, marginBottom:4 }}>Expanded Keywords ({v2.keywords.length})</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:12 }}>
              {v2.keywords.map((k:string,i:number)=> <span key={i} style={{ padding:"2px 8px", background:"#f1f5f9", borderRadius:4, fontSize:11 }}>{k}</span>)}
            </div>
            <div style={{ fontWeight:600, marginBottom:4, cursor:"pointer", userSelect:"none" }} onClick={()=>setFaqOpen(!faqOpen)}>📄 FAQ ({v2.faq.length} items) {faqOpen?"▲":"▼"}</div>
            {faqOpen && v2.faq.map((f:any,i:number)=> (
              <div key={i} style={{ padding:"6px 8px", borderLeft:"2px solid #e2e8f0", marginBottom:4 }}>
                <div style={{ fontWeight:500 }}>Q: {f.q}</div>
                <div style={{ color:"#64748b" }}>A: {f.a}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ background:"#fff", borderRadius:10, border:"1px solid #e2e8f0", overflow:"hidden" }}>
        <div style={{ padding:"12px 16px", borderBottom:"1px solid #e2e8f0", fontSize:12, color:"#94a3b8" }}>{pages.length} existing pages</div>
        <div style={{ maxHeight:400, overflowY:"auto" }}>
          {pages.slice(0,50).map((p,i)=> (
            <div key={i} style={{ padding:"8px 16px", borderBottom:"1px solid #f1f5f9", fontSize:12, color:"#475569", display:"flex", gap:8 }}>
              <span style={{ color:"#7c5cfc", fontWeight:600, minWidth:120 }}>/{p.slug}</span>
              <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.title}</span>
              <span style={{ color:"#94a3b8", minWidth:60, textAlign:"right" }}>{p.category}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Competitor Panel ──

function CompetitorPanel() {
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [seed, setSeed] = useState("Smallpdf");
  const [v2, setV2] = useState<any>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch(`${API}/api/v13/competitor/pages`); const d = await r.json(); setPages(d.pages || []); } catch {}
    setLoading(false);
  }, []);
  const generate = useCallback(async () => {
    setLoading(true);
    try { await fetch(`${API}/api/v13/competitor/generate`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({}) }); await load(); } catch {}
    setLoading(false);
  }, [load]);
  const runV2 = useCallback(() => {
    const kw = [`${seed} alternative`,`best ${seed} alternative`,`free ${seed} alternative`,`${seed} vs PDFSail`];
    const faq = [
      {q:`Is ${seed} free?`,a:`It has limits. PDFSail is completely free.`},
      {q:`Why choose PDFSail over ${seed}?`,a:`No signup, no watermark, unlimited usage.`},
    ];
    setV2({ keywords: kw, faq });
  }, [seed]);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20, flexWrap:"wrap" }}>
        <h2 style={{ margin:0, fontSize:20, color:"#1e293b" }}>⚔️ Competitor Pages</h2>
        <button onClick={generate} disabled={loading} style={{ padding:"8px 16px", background:"#7c5cfc", color:"#fff", border:"none", borderRadius:6, cursor:"pointer", fontSize:13, fontWeight:600, opacity:loading?0.5:1 }}>{loading?"Generating...":"Generate All"}</button>
      </div>
      <div style={{ background:"#fff", borderRadius:10, border:"1px solid #e2e8f0", padding:20, marginBottom:20 }}>
        <div style={{ fontSize:14, fontWeight:700, color:"#059669", marginBottom:12 }}>🚀 Competitor Keyword Expansion</div>
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <input value={seed} onChange={e=>setSeed(e.target.value)} style={{ flex:1, padding:"8px 12px", borderRadius:6, border:"1px solid #e2e8f0", fontSize:13 }} />
          <button onClick={runV2} style={{ padding:"8px 20px", background:"#059669", color:"#fff", border:"none", borderRadius:6, cursor:"pointer", fontSize:13, fontWeight:600 }}>Expand</button>
        </div>
        {v2 && (
          <div style={{ fontSize:12, color:"#475569" }}>
            <div style={{ fontWeight:600, marginBottom:4 }}>Target Pages</div>
            {v2.keywords.map((k:string,i:number)=> <div key={i} style={{ padding:"4px 0", color:"#059669", fontSize:12 }}>/{k.replace(/\s+/g,"-")}</div>)}
            <div style={{ fontWeight:600, margin:"8px 0 4px" }}>Pitch FAQ</div>
            {v2.faq.map((f:any,i:number)=> (
              <div key={i} style={{ borderLeft:"2px solid #059669", padding:"4px 8px", marginBottom:4, fontSize:12 }}>
                <div style={{ fontWeight:500 }}>{f.q}</div>
                <div style={{ color:"#64748b" }}>{f.a}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ background:"#fff", borderRadius:10, border:"1px solid #e2e8f0", overflow:"hidden" }}>
        <div style={{ padding:"12px 16px", borderBottom:"1px solid #e2e8f0", fontSize:12, color:"#94a3b8" }}>{pages.length} pages</div>
        <div style={{ maxHeight:400, overflowY:"auto" }}>
          {pages.map((p,i)=> (
            <div key={i} style={{ padding:"8px 16px", borderBottom:"1px solid #f1f5f9", fontSize:12, color:"#475569", display:"flex", gap:8 }}>
              <span style={{ color:"#059669", fontWeight:600, minWidth:180 }}>/{p.slug}</span>
              <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.title}</span>
              <span style={{ color:"#94a3b8" }}>vs {p.competitor}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── A/B Test Panel ──

function ABTestPanel() {
  const [testName, setTestName] = useState("default");
  const [titles, setTitles] = useState("");
  const [results, setResults] = useState<any>(null);
  const [resultKey, setResultKey] = useState(0);

  const createTest = useCallback(async () => {
    const list = titles.split("\n").filter(Boolean);
    if (list.length < 2) return alert("Enter at least 2 titles (one per line)");
    const r = await fetch(`${API}/api/v13/abtest/create`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testName, titles: list }),
    });
    const d = await r.json();
    setResults(d);
  }, [testName, titles]);

  const loadResults = useCallback(async () => {
    const r = await fetch(`${API}/api/v13/abtest/results?name=${testName}`);
    const d = await r.json();
    setResults(d);
  }, [testName]);

  const recordImpression = useCallback(async (id: string) => {
    await fetch(`${API}/api/v13/abtest/impression`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName, variantId: id }),
    });
    loadResults();
  }, [testName, loadResults]);

  const recordClick = useCallback(async (id: string) => {
    await fetch(`${API}/api/v13/abtest/click`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName, variantId: id }),
    });
    loadResults();
  }, [testName, loadResults]);

  const reset = useCallback(async () => {
    await fetch(`${API}/api/v13/abtest/reset?name=${testName}`, { method: "POST" });
    loadResults();
  }, [testName, loadResults]);

  useEffect(() => { loadResults(); }, [resultKey, loadResults]);

  return (
    <div>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, color: "#1e293b" }}>🧪 A/B Test Engine — Title Optimizer</h2>
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", padding: 20, marginBottom: 20 }}>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Test Name</label>
          <input value={testName} onChange={(e) => setTestName(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13 }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Title Variants (one per line)</label>
          <textarea value={titles} onChange={(e) => setTitles(e.target.value)} rows={5} style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 13, fontFamily: "monospace" }} />
        </div>
        <button onClick={createTest} style={{ padding: "8px 20px", background: "#7c5cfc", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Create A/B Test</button>
      </div>
      {results && (
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>Results: {results.testName}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setResultKey(k => k + 1)} style={{ padding: "4px 12px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>Refresh</button>
              <button onClick={reset} style={{ padding: "4px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 4, cursor: "pointer", fontSize: 11, color: "#ef4444" }}>Reset</button>
            </div>
          </div>
          {results.variants?.map((v: any) => (
            <div key={v.id} style={{ padding: "10px 12px", borderBottom: "1px solid #f1f5f9", fontSize: 13, display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ flex: 1, color: "#1e293b" }}>{v.title}</span>
              <span style={{ color: "#64748b" }}>👁 {v.impressions}</span>
              <span style={{ color: "#64748b" }}>🖱 {v.clicks}</span>
              <span style={{ fontWeight: 600, color: v.impressions > 0 && v.clicks / v.impressions > 0.1 ? "#059669" : "#64748b" }}>CTR: {v.impressions > 0 ? ((v.clicks / v.impressions) * 100).toFixed(1) : 0}%</span>
              <button onClick={() => recordImpression(v.id)} style={{ padding: "2px 8px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 4, cursor: "pointer", fontSize: 10 }}>+Impr</button>
              <button onClick={() => recordClick(v.id)} style={{ padding: "2px 8px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 4, cursor: "pointer", fontSize: 10 }}>+Click</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Conversion Panel ──

function ConversionPanel() {
  const [trend, setTrend] = useState<any>(null);
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/api/v13/conversion/trend`); const d = await r.json(); setTrend(d); } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);
  const logEvent = useCallback(async () => {
    await fetch(`${API}/api/v13/conversion/log`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: "test", clicks: 10, conversions: 2 }) });
    load();
  }, [load]);
  return (
    <div>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, color: "#1e293b" }}>📈 Conversion Engine</h2>
      <button onClick={logEvent} style={{ padding: "8px 20px", background: "#7c5cfc", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 20 }}>Log Test Event</button>
      {trend && (
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", padding: 20 }}>
          <div style={{ marginBottom: 12 }}><span style={{ fontSize: 12, color: "#64748b" }}>Trend: </span><span style={{ fontWeight: 600, color: trend.trend === "improving" ? "#059669" : trend.trend === "declining" ? "#ef4444" : "#f59e0b" }}>{trend.trend}</span></div>
          <div style={{ marginBottom: 12 }}><span style={{ fontSize: 12, color: "#64748b" }}>Rolling CVR: </span><span style={{ fontWeight: 700, fontSize: 18 }}>{(trend.rollingAverage * 100).toFixed(1)}%</span></div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>{trend.history?.length || 0} events recorded</div>
        </div>
      )}
    </div>
  );
}

// ── Ads Panel ──

function AdsPanel() {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/api/ads/campaigns`); const d = await r.json(); setCampaigns(d.campaigns || []); } catch {}
  }, []);
  const analyze = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/ads/analyze`); const d = await r.json();
      if (d.analyses) setCampaigns(d.analyses);
    } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, color: "#1e293b" }}>💰 Ads Optimizer — ROI Engine</h2>
        <button onClick={analyze} disabled={loading} style={{ padding: "8px 16px", background: "#7c5cfc", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, opacity: loading ? 0.5 : 1 }}>{loading ? "Analyzing..." : "Analyze All"}</button>
      </div>
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        {campaigns.map((c, i) => (
          <div key={i} style={{ padding: "12px 16px", borderBottom: "1px solid #f1f5f9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{c.campaignName || c.name}</div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                {c.spend !== undefined && `Spend: $${c.spend}`}
                {c.revenue !== undefined && ` · Revenue: $${c.revenue}`}
                {c.roas !== undefined && ` · ROAS: ${c.roas}x`}
                {c.ctr !== undefined && ` · CTR: ${(c.ctr * 100).toFixed(1)}%`}
              </div>
            </div>
            <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: (c.action || c.recommendation) === "STOP" ? "#fef2f2" : (c.action || c.recommendation) === "SCALE" ? "#ecfdf5" : "#fefce8", color: (c.action || c.recommendation) === "STOP" ? "#ef4444" : (c.action || c.recommendation) === "SCALE" ? "#059669" : "#d97706" }}>{c.action || c.recommendation || "HOLD"}</span>
          </div>
        ))}
        {campaigns.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>No campaigns loaded. Click "Analyze All" to seed demo data.</div>}
      </div>
    </div>
  );
}

// ── Scheduler Panel ──

function SchedulerPanel() {
  const [sched, setSched] = useState<any>(null);
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/api/v13/scheduler/status`); const d = await r.json(); setSched(d); } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);
  const start = useCallback(async () => { await fetch(`${API}/api/v13/scheduler/start`, { method: "POST" }); load(); }, [load]);
  const stop = useCallback(async () => { await fetch(`${API}/api/v13/scheduler/stop`, { method: "POST" }); load(); }, [load]);
  return (
    <div>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, color: "#1e293b" }}>⏱ Scheduler — Daily Auto Optimization</h2>
      {sched && (
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>Status: </span>
            <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: sched.status === "running" ? "#ecfdf5" : "#fef2f2", color: sched.status === "running" ? "#059669" : "#ef4444" }}>{sched.status}</span>
            <button onClick={start} disabled={sched.status === "running"} style={{ padding: "6px 14px", background: "#059669", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: sched.status === "running" ? 0.5 : 1 }}>Start</button>
            <button onClick={stop} disabled={sched.status !== "running"} style={{ padding: "6px 14px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: sched.status !== "running" ? 0.5 : 1 }}>Stop</button>
          </div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{sched.jobs?.length || 0} registered jobs</div>
          {sched.jobs?.map((j: any, i: number) => (
            <div key={i} style={{ marginTop: 8, padding: "8px 12px", background: "#f8fafc", borderRadius: 6, fontSize: 12, color: "#475569", display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>{j.name}</span>
              <span style={{ color: "#94a3b8" }}>Runs: {j.runCount} · Last: {j.lastRun ? new Date(j.lastRun).toLocaleString() : "never"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Database Panel ──

function DBPanel() {
  const [collections, setCollections] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [docs, setDocs] = useState<any[]>([]);
  const loadColls = useCallback(async () => {
    try { const r = await fetch(`${API}/api/v13/db/collections`); const d = await r.json(); setCollections(d.collections || []); } catch {}
  }, []);
  const loadDocs = useCallback(async (name: string) => {
    setSelected(name);
    try { const r = await fetch(`${API}/api/v13/db/${name}`); const d = await r.json(); setDocs(d.docs || []); } catch {}
  }, []);
  useEffect(() => { loadColls(); }, [loadColls]);
  return (
    <div>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, color: "#1e293b" }}>🗄 Database</h2>
      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ width: 200, flexShrink: 0 }}>
          {collections.map((c) => (
            <div key={c.name} onClick={() => loadDocs(c.name)} style={{ padding: "8px 12px", borderRadius: 6, cursor: "pointer", background: selected === c.name ? "#7c5cfc" : "#fff", color: selected === c.name ? "#fff" : "#475569", fontWeight: 500, fontSize: 13, marginBottom: 4, border: "1px solid #e2e8f0" }}>
              {c.name}
              <span style={{ float: "right", fontSize: 11, opacity: 0.6 }}>{c.count}</span>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 12, color: "#94a3b8" }}>{selected || "Select a collection"}</div>
          <div style={{ maxHeight: 500, overflowY: "auto", padding: 8, fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
            {docs.length > 0 ? JSON.stringify(docs.slice(0, 20), null, 2) : <span style={{ color: "#94a3b8" }}>Select a collection to view documents</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Value Probe Panel ──

function ValueProbePanel() {
  const [metrics, setMetrics] = useState<any>(null);
  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/api/value/metrics`); const d = await r.json(); setMetrics(d); } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, color: "#1e293b" }}>🔬 Value Probe Metrics</h2>
      {metrics ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
          <StatCard label="Upload Volume" value={String(metrics.upload_volume)} />
          <StatCard label="YES Ratio" value={metrics.yes_ratio} />
          <StatCard label="YES Count" value={String(metrics.yes_count)} />
          <StatCard label="Click Rate" value={metrics.click_rate} />
          <StatCard label="Open Loop Views" value={String(metrics.open_loop_views || 0)} />
          <StatCard label="CTA Clicks" value={String(metrics.open_loop_clicks || 0)} />
          <StatCard label="Downloads" value={String(metrics.downloads || 0)} />
          <StatCard label="Total Events" value={String(metrics.events_total || 0)} />
        </div>
      ) : <p style={{ color: "#94a3b8" }}>No data yet. Upload some PDFs via the Value Probe flow first.</p>}
    </div>
  );
}