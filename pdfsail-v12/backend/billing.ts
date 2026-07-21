import express from "express";
import Stripe from "stripe";
import { createPayPalOrder, capturePayPalOrder, isPayPalConfigured } from "../billing/paypal.js";

// ── Stripe Init ──

const stripeKey = process.env.STRIPE_KEY;
const stripe = stripeKey
  ? new Stripe(stripeKey, { apiVersion: "2024-06-20" })
  : null;

if (!stripeKey) console.warn("⚠️  STRIPE_KEY not set. Stripe mock mode.");
if (!isPayPalConfigured()) console.warn("⚠️  PAYPAL_CLIENT_ID/SECRET not set. PayPal mock mode.");

export const billingRouter = express.Router();

// ── Free tier limits ──

const EXPORT_LIMITS = {
  free: { maxExportsPerDay: 3, maxFileSizeMB: 10 },
  pro: { maxExportsPerDay: 100, maxFileSizeMB: 100 },
  enterprise: { maxExportsPerDay: 9999, maxFileSizeMB: 500 },
};

const usageTracker = new Map<string, { date: string; count: number }>();

// ── Stripe Checkout ──

async function createStripeCheckout(params: {
  fileId: string;
  origin: string;
}): Promise<{ url: string | null; mockMode: boolean }> {
  if (!stripe) {
    return { url: null, mockMode: true };
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: "PDF Export - Pro" },
          unit_amount: 199,
        },
        quantity: 1,
      },
    ],
    success_url: `${params.origin}/editor?success=stripe`,
    cancel_url: `${params.origin}/editor?canceled=true`,
    metadata: { fileId: params.fileId },
  });

  return { url: session.url, mockMode: false };
}

// ── PayPal Checkout ──

function buildPayPalReturnUrls(origin: string) {
  const base = `${origin}/editor`;
  return {
    return_url: `${base}?paypal=success`,
    cancel_url: `${base}?paypal=cancel`,
  };
}

// ── Unified Checkout ──

billingRouter.post("/billing/checkout", async (req, res) => {
  try {
    const { fileId, method = "stripe", productKey = "pdfExport" } = req.body;
    const userId = req.ip || "anonymous";
    const origin = req.headers.origin || "http://localhost:5173";

    // Check daily limit
    const today = new Date().toISOString().split("T")[0];
    const usage = usageTracker.get(userId);

    // Free tier still has remaining exports → no payment needed
    if (!(usage && usage.date === today && usage.count >= EXPORT_LIMITS.free.maxExportsPerDay)) {
      if (usage && usage.date === today) usage.count++;
      else usageTracker.set(userId, { date: today, count: 1 });

      return res.json({
        url: null,
        allowed: true,
        exportsRemaining: EXPORT_LIMITS.free.maxExportsPerDay - ((usage?.count || 0) + 1),
        method,
      });
    }

    // ── Pay via Stripe ──
    if (method === "stripe") {
      try {
        const checkout = await createStripeCheckout({ fileId, origin });
        return res.json({
          url: checkout.url,
          mockMode: checkout.mockMode,
          method: "stripe",
          message: checkout.mockMode
            ? "Stripe not configured. Running in mock mode."
            : undefined,
        });
      } catch (err: any) {
        console.error("Stripe checkout error:", err);
        return res.status(500).json({ error: "Payment service unavailable" });
      }
    }

    // ── Pay via PayPal ──
    if (method === "paypal") {
      try {
        const order = await createPayPalOrder({
          productKey,
          metadata: {
            fileId,
            ...buildPayPalReturnUrls(origin),
          },
        });

        return res.json({
          url: order.approvalUrl,
          orderId: order.id,
          mockMode: order.mockMode,
          method: "paypal",
          message: order.mockMode
            ? "PayPal not configured. Running in mock mode."
            : undefined,
        });
      } catch (err: any) {
        console.error("PayPal order error:", err);
        return res.status(500).json({ error: "PayPal service unavailable" });
      }
    }

    return res.status(400).json({ error: `Unknown payment method: ${method}` });
  } catch (err: any) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

// ── PayPal Capture (called after buyer approves) ──

billingRouter.post("/billing/paypal/capture", async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "orderId required" });
    }

    const capture = await capturePayPalOrder(orderId);
    const success = capture.status === "COMPLETED";

    if (success) {
      console.log(`PayPal payment captured: ${capture.id} ($${capture.amount})`);
      // In production: unlock export for this file
    }

    res.json({
      success,
      orderId: capture.id,
      captureId: capture.captureId,
      amount: capture.amount,
      status: capture.status,
    });
  } catch (err: any) {
    console.error("PayPal capture error:", err);
    res.status(500).json({ error: "PayPal capture failed" });
  }
});

// ── Usage Info ──

billingRouter.get("/billing/usage", (req, res) => {
  const userId = req.ip || "anonymous";
  const today = new Date().toISOString().split("T")[0];
  const usage = usageTracker.get(userId);

  res.json({
    userId,
    date: today,
    exportsUsed: usage?.date === today ? usage.count : 0,
    exportsRemaining: EXPORT_LIMITS.free.maxExportsPerDay - (usage?.date === today ? usage.count : 0),
    plan: "free",
    paymentMethods: {
      stripe: !!stripeKey,
      paypal: isPayPalConfigured(),
    },
  });
});

// ── Stripe Webhook ──

billingRouter.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) {
    return res.status(200).json({ received: true, mockMode: true });
  }

  const sig = req.headers["stripe-signature"] as string;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret!);
  } catch (err: any) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  switch (event.type) {
    case "checkout.session.completed":
      const session = event.data.object;
      console.log("Stripe payment successful:", session.id, session.metadata?.fileId);
      break;
    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  res.json({ received: true });
});
