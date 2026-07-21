import Stripe from "stripe";

const stripeKey = process.env.STRIPE_KEY;
if (!stripeKey) {
  console.warn("⚠️  STRIPE_KEY not set in environment. Billing will use mock mode.");
}

export const stripe = stripeKey
  ? new Stripe(stripeKey, { apiVersion: "2024-06-20" })
  : null;

export type ProductConfig = {
  name: string;
  description: string;
  price: number; // in cents
};

export const PRODUCTS: Record<string, ProductConfig> = {
  pdfExport: {
    name: "PDF Export",
    description: "Export your edited PDF document",
    price: 199, // $1.99
  },
  proMonthly: {
    name: "PDFSail Pro (Monthly)",
    description: "Unlimited PDF editing, OCR, and exports",
    price: 999, // $9.99
  },
  proYearly: {
    name: "PDFSail Pro (Yearly)",
    description: "Save 50% with annual billing",
    price: 5999, // $59.99
  },
};

export async function createCheckoutSession(params: {
  productKey: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}) {
  if (!stripe) {
    return {
      url: null,
      mockMode: true,
      message: "Stripe not configured. Running in mock billing mode.",
    };
  }

  const product = PRODUCTS[params.productKey];
  if (!product) {
    throw new Error(`Unknown product: ${params.productKey}`);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: product.name,
            description: product.description,
          },
          unit_amount: product.price,
        },
        quantity: 1,
      },
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: params.metadata || {},
  });

  return { url: session.url, id: session.id };
}

export async function handleWebhookEvent(
  payload: Buffer,
  signature: string
) {
  if (!stripe) return null;

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
  const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  return event;
}
