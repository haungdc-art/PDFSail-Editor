// ──────────────────────────────────────────────
// PayPal REST API Integration
// ──────────────────────────────────────────────

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_API = process.env.PAYPAL_SANDBOX === "false"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

let _accessToken: { token: string; expiresAt: number } | null = null;

/**
 * Get PayPal OAuth2 access token (cached until expiry)
 */
async function getAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _accessToken.expiresAt) {
    return _accessToken.token;
  }

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    console.warn("⚠️  PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set. Using mock mode.");
    return "mock-token";
  }

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal auth failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  _accessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return _accessToken.token;
}

/**
 * Export configuration
 */
export const PAYPAL_PRODUCTS = {
  pdfExport: {
    name: "PDF Export - Pro",
    description: "Export your edited PDF document",
    amount: "1.99",        // USD
    currency: "USD",
  },
  proMonthly: {
    name: "PDFSail Pro (Monthly)",
    description: "Unlimited PDF editing, OCR, and exports",
    amount: "9.99",
    currency: "USD",
  },
  proYearly: {
    name: "PDFSail Pro (Yearly)",
    description: "Save 50% with annual billing",
    amount: "59.99",
    currency: "USD",
  },
};

export type PayPalOrderResult = {
  id: string;
  status: string;
  approvalUrl: string | null;
  mockMode: boolean;
};

/**
 * Create a PayPal order and return the approval URL.
 * The frontend redirects the user to approvalUrl to complete payment.
 */
export async function createPayPalOrder(params: {
  productKey: string;
  metadata?: Record<string, string>;
}): Promise<PayPalOrderResult> {
  const product = PAYPAL_PRODUCTS[params.productKey as keyof typeof PAYPAL_PRODUCTS];
  if (!product) {
    throw new Error(`Unknown PayPal product: ${params.productKey}`);
  }

  // Mock mode if credentials are missing
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return {
      id: `mock-order-${Date.now()}`,
      status: "CREATED",
      approvalUrl: null,
      mockMode: true,
    };
  }

  const token = await getAccessToken();

  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: params.productKey,
        description: product.description,
        amount: {
          currency_code: product.currency,
          value: product.amount,
        },
        custom_id: params.metadata?.fileId || "",
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
          landing_page: "LOGIN",
          user_action: "PAY_NOW",
          return_url: params.metadata?.return_url || "http://localhost:5173/editor?paypal=success",
          cancel_url: params.metadata?.cancel_url || "http://localhost:5173/editor?paypal=cancel",
        },
      },
    },
  };

  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "PayPal-Request-Id": `ps-${params.productKey}-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal create order failed: ${res.status} ${text}`);
  }

  const order = await res.json();

  // Find the approval URL in the response links
  const approvalLink = order.links?.find(
    (l: any) => l.rel === "approve"
  )?.href || null;

  return {
    id: order.id,
    status: order.status,
    approvalUrl: approvalLink,
    mockMode: false,
  };
}

/**
 * Capture an order after buyer approval (called via webhook or redirect)
 */
export async function capturePayPalOrder(orderId: string): Promise<{
  id: string;
  status: string;
  captureId: string | null;
  amount: string;
}> {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return {
      id: orderId,
      status: "COMPLETED",
      captureId: `mock-capture-${Date.now()}`,
      amount: "1.99",
    };
  }

  const token = await getAccessToken();

  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal capture failed: ${res.status} ${text}`);
  }

  const capture = await res.json();

  const captureId =
    capture.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;

  return {
    id: capture.id,
    status: capture.status,
    captureId,
    amount: capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || "0",
  };
}

/**
 * Check if PayPal is configured (has valid credentials)
 */
export function isPayPalConfigured(): boolean {
  return !!(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);
}
