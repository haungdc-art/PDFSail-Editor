import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import SEOPage from "../landing/SEOPage";
import CompetitorPage from "../landing/CompetitorPage";

const API = import.meta.env.VITE_API_BASE || "";

export default function DynamicPage() {
  const { slug } = useParams<{ slug: string }>();
  const [pageData, setPageData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);

    // Check if it's a competitor page
    const competitors = ["smallpdf","ilovepdf","pdf24","adobe","pdfcandy","sodapdf","sejda","nitro","foxit","pdfescape","lightpdf","hipdf","xodo"];
    const isCompetitor = competitors.some(c => slug.includes(c));

    if (isCompetitor) {
      // Extract competitor name from slug
      const name = slug.split("-alternative")[0];
      const compName = name.charAt(0).toUpperCase() + name.slice(1);
      setPageData({ type: "competitor", competitor: compName });
      setLoading(false);
      return;
    }

    // Try to load from API
    fetch(`${API}/api/v13/seo/page/${slug}`)
      .then(r => r.json())
      .then(data => {
        if (data.keyword) {
          setPageData({ type: "seo", keyword: data.keyword });
        } else {
          // Generate keyword from slug
          const keyword = slug.replace(/-/g, " ");
          setPageData({ type: "seo", keyword });
        }
        setLoading(false);
      })
      .catch(() => {
        const keyword = slug.replace(/-/g, " ");
        setPageData({ type: "seo", keyword });
        setLoading(false);
      });
  }, [slug]);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>Loading...</div>;
  if (!pageData) return <div style={{ padding: 40, textAlign: "center", color: "#ef4444" }}>Page not found</div>;

  if (pageData.type === "competitor") {
    return <CompetitorPage competitor={pageData.competitor} />;
  }
  return <SEOPage keyword={pageData.keyword} />;
}
