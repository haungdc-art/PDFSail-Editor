/**
 * usePayment — Commit 3 / Feature 4
 *
 * 支付业务能力：Stripe + PayPal checkout。
 * 从 PDFEditor.tsx L466-507 提取。
 *
 * 跨 feature 依赖：支付成功后调用 handleExport(skipPay=true) 完成导出，
 * 因此 handleExport 通过参数注入（避免 feature 间直接耦合 state）。
 */

import { useEditor } from "../core/EditorProvider";
import type { ExportResult } from "./useExport";

interface UsePaymentParams {
  handleExport: (skipPay?: boolean, download?: boolean) => Promise<ExportResult | null>;
}

export function usePayment({ handleExport }: UsePaymentParams) {
  const { setShowPayModal } = useEditor();

  const handlePaypalPay = async () => {
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "paypal", productKey: "pdfExport" }),
      });
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank");
        // 在 PayPal 页面打开后允许用户返回时继续导出
        setShowPayModal(false);
      } else if (data.mockMode) {
        // Mock 模式：直接导出
        setShowPayModal(false);
        handleExport(true);
      }
    } catch (err) {
      console.error("PayPal error:", err);
      setShowPayModal(false);
    }
  };

  const handleStripePay = async () => {
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "stripe", productKey: "pdfExport" }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.mockMode) {
        setShowPayModal(false);
        handleExport(true);
      }
    } catch (err) {
      console.error("Stripe error:", err);
      setShowPayModal(false);
    }
  };

  return { handleStripePay, handlePaypalPay };
}
