import React from "react";
import PDFEditor from "../editor/PDFEditor";
import SEOPage from "../landing/SEOPage";
import CompetitorPage from "../landing/CompetitorPage";
import CompressPage from "../compress/CompressPage";
import MergePage from "../merge/MergePage";
import SplitPage from "../split/SplitPage";
import RotatePage from "../rotate/RotatePage";
import PageNumPage from "../pagenum/PageNumPage";
import PdfToWordPage from "../pdftoword/PdfToWordPage";
import PdfToExcelPage from "../pdftoexcel/PdfToExcelPage";
import WatermarkPage from "../watermark/WatermarkPage";
import ValueProbePage from "../value-probe/ValueProbePage";
import AdminDashboard from "../admin/AdminDashboard";
import DynamicPage from "./DynamicPage";

export interface RouteConfig {
  path: string;
  element: React.ReactElement;
  title?: string;
}

export const routes: RouteConfig[] = [
  { path: "/", element: <SEOPage keyword="edit PDF online free" />, title: "Home" },
  { path: "/editor", element: <PDFEditor />, title: "PDF Editor" },
  { path: "/edit-pdf", element: <PDFEditor />, title: "Edit PDF" },
  { path: "/compress-pdf", element: <CompressPage />, title: "Compress PDF" },
  { path: "/merge-pdf", element: <MergePage />, title: "Merge PDF" },
  { path: "/split-pdf", element: <SplitPage />, title: "Split PDF" },
  { path: "/rotate-pdf", element: <RotatePage />, title: "Rotate PDF" },
  { path: "/add-page-numbers", element: <PageNumPage />, title: "Add Page Numbers" },
  { path: "/pdf-to-word", element: <PdfToWordPage />, title: "PDF to Word" },
  { path: "/pdf-to-excel", element: <PdfToExcelPage />, title: "PDF to Excel" },
  { path: "/remove-watermark", element: <WatermarkPage />, title: "Remove Watermark" },
  { path: "/smallpdf-alternative", element: <CompetitorPage competitor="Smallpdf" />, title: "Smallpdf Alternative" },
  { path: "/ilovepdf-alternative", element: <CompetitorPage competitor="iLovePDF" />, title: "iLovePDF Alternative" },
  { path: "/pdf24-alternative", element: <CompetitorPage competitor="PDF24" />, title: "PDF24 Alternative" },
  { path: "/adobe-acrobat-alternative", element: <CompetitorPage competitor="Adobe Acrobat" />, title: "Adobe Acrobat Alternative" },
  { path: "/pdf-candy-alternative", element: <CompetitorPage competitor="PDF Candy" />, title: "PDF Candy Alternative" },
  { path: "/value-probe", element: <ValueProbePage />, title: "PDF Value Probe" },
  { path: "/admin", element: <AdminDashboard />, title: "Admin Dashboard" },
  { path: "/p/:slug", element: <DynamicPage />, title: "SEO Page" },
];
