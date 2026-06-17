import { jwtVerify, SignJWT } from "jose";

/**
 * Pathway Invoice Proxy
 * =====================
 * Sits between the Shopify customer-account UI extension (runs in the customer's
 * browser) and the Pathway billing API. Two reasons it must exist:
 *
 *   1. The Pathway API key is secret and must never reach the browser.
 *   2. Pathway's PDF links are pre-signed and expire after ~60 seconds, so a
 *      static link on a button would be dead by the time the customer clicks
 *      it. We fetch a FRESH link at click-time and redirect to it.
 *
 * Endpoints:
 *   GET /health
 *   GET /invoices?orderId=<gid|numeric>[&refundIds=a,b]
 *       Auth: Authorization: Bearer <Shopify session token>
 *       → [{ id, label, type, downloadUrl }]   (downloadUrl points back here)
 *   GET /download?t=<signed token>
 *       → 302 redirect to a freshly-signed Pathway PDF URL
 *
 * Auth modes (auto-selected):
 *   - DISABLE_AUTH=true                 → no auth (LOCAL DEV ONLY)
 *   - SHOPIFY_ADMIN_TOKEN set           → "airtight": verify customer owns order
 *   - otherwise                         → "session-only": require a valid login
 */

// -----------------------------
// Config / env
// -----------------------------
function mustGetEnv(name: string): string {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
function getEnv(name: string, fallback = ""): string {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

// Pathway
const PATHWAY_BASE_URL = getEnv(
  "PATHWAY_BASE_URL",
  "https://billing.platform.pathway-solutions.de",
).replace(/\/+$/, "");
const PATHWAY_SHOP_ID = getEnv("PATHWAY_SHOP_ID", "bfe811.myshopify.com");
function pathwayApiKey(): string {
  return mustGetEnv("PATHWAY_API_KEY");
}

// Shopify session-token verification
const SHOPIFY_APP_CLIENT_ID = getEnv("SHOPIFY_APP_CLIENT_ID");
const SHOPIFY_APP_CLIENT_SECRET = getEnv("SHOPIFY_APP_CLIENT_SECRET");

// Shopify Admin API — OPTIONAL. Enables "airtight" ownership verification and
// automatic credit-note (Gutschrift) discovery via the order's refunds.
const SHOPIFY_STORE_DOMAIN = getEnv("SHOPIFY_STORE_DOMAIN", "bfe811.myshopify.com");
const SHOPIFY_ADMIN_TOKEN = getEnv("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_ADMIN_API_VERSION = getEnv("SHOPIFY_ADMIN_API_VERSION", "2025-07");

const DISABLE_AUTH = getEnv("DISABLE_AUTH") === "true";
const OWNERSHIP_CHECK = !DISABLE_AUTH && !!SHOPIFY_ADMIN_TOKEN;

// PREVIEW/DEMO: when set, /invoices serves the documents for THIS fixed order id
// regardless of which order is being viewed. Use it to preview the real card
// (with a working download) on a store whose orders aren't in Pathway — e.g. a
// dev store. MUST be left empty in production.
const DEMO_INVOICE_ORDER_ID = getEnv("DEMO_INVOICE_ORDER_ID");

const PORT = Number(getEnv("PORT", "8080"));

// Secret used to sign short-lived /download links. Reuse the Shopify app secret
// (or fall back to the Pathway key) so there's nothing extra to configure.
function downloadSecret(): Uint8Array {
  const s = SHOPIFY_APP_CLIENT_SECRET || getEnv("PATHWAY_API_KEY") || "dev-only-secret";
  return new TextEncoder().encode(s);
}

// -----------------------------
// HTTP helpers
// -----------------------------
const CORS_HEADERS: Record<string, string> = {
  // UI extensions run in a worker with a `null` origin, so we must allow `*`.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function selfOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

// -----------------------------
// Session token (JWT) verification
// -----------------------------
type SessionClaims = { sub?: string; dest?: string; aud?: string };

async function verifySessionToken(
  req: Request,
): Promise<{ ok: true; claims: SessionClaims } | { ok: false; response: Response }> {
  if (DISABLE_AUTH) return { ok: true, claims: {} };

  if (!SHOPIFY_APP_CLIENT_SECRET || !SHOPIFY_APP_CLIENT_ID) {
    return {
      ok: false,
      response: json({ ok: false, error: "server-misconfigured: missing Shopify app credentials" }, 500),
    };
  }

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { ok: false, response: json({ ok: false, error: "missing bearer token" }, 401) };

  try {
    const { payload } = await jwtVerify(token, downloadSecretFromClientSecret(), {
      algorithms: ["HS256"],
      audience: SHOPIFY_APP_CLIENT_ID,
      clockTolerance: 10,
    });
    return { ok: true, claims: payload as SessionClaims };
  } catch (e: any) {
    return { ok: false, response: json({ ok: false, error: `invalid session token: ${e?.message || e}` }, 401) };
  }
}
// Session tokens are signed with the Shopify app's client secret specifically.
function downloadSecretFromClientSecret(): Uint8Array {
  return new TextEncoder().encode(SHOPIFY_APP_CLIENT_SECRET);
}

// -----------------------------
// Shopify Admin API (airtight mode only)
// -----------------------------
async function shopifyAdminGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify Admin API ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (data.errors) throw new Error(`Shopify Admin API errors: ${JSON.stringify(data.errors)}`);
  return data.data as T;
}

type OrderInfo = {
  id: string;
  customer: { id: string } | null;
  refunds: { legacyResourceId: string }[];
};

async function fetchOrderInfo(orderGid: string): Promise<OrderInfo | null> {
  const query = /* GraphQL */ `
    query GetOrder($id: ID!) {
      order(id: $id) {
        id
        customer { id }
        refunds(first: 50) { legacyResourceId }
      }
    }
  `;
  const data = await shopifyAdminGraphQL<{ order: OrderInfo | null }>(query, { id: orderGid });
  return data.order;
}

// -----------------------------
// Pathway
// -----------------------------
type PathwayDoc = {
  id: number | string;
  type: string; // e.g. "INVOICE"
  number?: string; // e.g. "RE-26"
  s3FilePath?: string; // pre-signed PDF URL, expires ~60s
};

function pathwayDocPath(numericOrderId: string, refundId?: string): string {
  const qs = new URLSearchParams({ json: "true" });
  if (refundId) qs.set("refund", refundId);
  return `/billing/documents/shopify/${PATHWAY_SHOP_ID}/order/${numericOrderId}?${qs.toString()}`;
}

/** Returns the document metadata, or null if Pathway has no such document (404). */
async function fetchPathwayDoc(numericOrderId: string, refundId?: string): Promise<PathwayDoc | null> {
  const res = await fetch(`${PATHWAY_BASE_URL}${pathwayDocPath(numericOrderId, refundId)}`, {
    headers: { "pathway-api-key": pathwayApiKey() },
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Pathway ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as PathwayDoc;
}

function isCreditNote(type: string): boolean {
  const t = (type || "").toUpperCase();
  return t.includes("REVERSAL") || t.includes("CREDIT") || t.includes("REFUND") || t.includes("GUTSCHRIFT");
}

function labelFor(doc: PathwayDoc): string {
  const credit = isCreditNote(doc.type);
  const noun = credit ? "Gutschrift" : "Rechnung";
  return doc.number ? `${noun} ${doc.number}` : noun;
}

// -----------------------------
// Signed /download links
// -----------------------------
async function signDownloadToken(numericOrderId: string, refundId?: string): Promise<string> {
  const jwt = new SignJWT({ o: numericOrderId, ...(refundId ? { r: refundId } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m");
  return jwt.sign(downloadSecret());
}

async function verifyDownloadToken(token: string): Promise<{ o: string; r?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, downloadSecret(), { algorithms: ["HS256"], clockTolerance: 10 });
    if (typeof payload.o !== "string") return null;
    return { o: payload.o, r: typeof payload.r === "string" ? payload.r : undefined };
  } catch {
    return null;
  }
}

// -----------------------------
// Handlers
// -----------------------------
function parseOrderGid(orderId: string): { gid: string; numeric: string } | null {
  const m = orderId.match(/^(?:gid:\/\/shopify\/Order\/)?(\d+)$/);
  if (!m) return null;
  return { gid: `gid://shopify/Order/${m[1]}`, numeric: m[1] };
}

async function handleInvoices(req: Request, url: URL): Promise<Response> {
  const auth = await verifySessionToken(req);
  if (!auth.ok) return auth.response;

  const parsed = parseOrderGid((url.searchParams.get("orderId") || "").trim());
  if (!parsed) return json({ ok: false, error: "invalid or missing orderId" }, 400);

  // Which order to actually fetch from Pathway, and which refunds for credit notes.
  let targetOrderId = parsed.numeric;
  let refundIds: string[] = [];
  if (DEMO_INVOICE_ORDER_ID) {
    // Preview mode: serve a known real invoice even on a store without Pathway data.
    targetOrderId = DEMO_INVOICE_ORDER_ID;
  } else if (OWNERSHIP_CHECK) {
    const customerGid = auth.claims.sub;
    if (!customerGid) return json({ ok: false, error: "not signed in" }, 403);
    let order: OrderInfo | null;
    try {
      order = await fetchOrderInfo(parsed.gid);
    } catch (e: any) {
      console.error(`[invoices] admin lookup failed: ${e?.message || e}`);
      return json({ ok: false, error: "could not verify order" }, 502);
    }
    if (!order) return json({ ok: false, error: "order not found" }, 404);
    if (order.customer?.id !== customerGid) return json({ ok: false, error: "forbidden" }, 403);
    refundIds = order.refunds.map((r) => r.legacyResourceId);
  } else {
    // session-only: the extension may optionally pass refund ids it knows about.
    refundIds = (url.searchParams.get("refundIds") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Build the document list: main invoice + one credit note per refund.
  const origin = selfOrigin(req);
  const out: { id: string; label: string; type: string; downloadUrl: string }[] = [];

  const queries: { refundId?: string }[] = [{}, ...refundIds.map((r) => ({ refundId: r }))];
  const docs = await Promise.all(
    queries.map(async (q) => {
      try {
        const doc = await fetchPathwayDoc(targetOrderId, q.refundId);
        return doc ? { doc, refundId: q.refundId } : null;
      } catch (e) {
        console.warn(`[invoices] pathway fetch failed (refund=${q.refundId ?? "-"}): ${e}`);
        return null;
      }
    }),
  );

  for (const entry of docs) {
    if (!entry) continue;
    const token = await signDownloadToken(targetOrderId, entry.refundId);
    out.push({
      id: String(entry.doc.id),
      label: labelFor(entry.doc),
      type: entry.doc.type,
      downloadUrl: `${origin}/download?t=${encodeURIComponent(token)}`,
    });
  }

  return json(out);
}

async function handleDownload(url: URL): Promise<Response> {
  const token = (url.searchParams.get("t") || "").trim();
  const claims = token ? await verifyDownloadToken(token) : null;
  if (!claims) return json({ ok: false, error: "invalid or expired download link" }, 401);

  let doc: PathwayDoc | null;
  try {
    doc = await fetchPathwayDoc(claims.o, claims.r); // fresh signed URL every time
  } catch (e: any) {
    console.error(`[download] pathway fetch failed: ${e?.message || e}`);
    return json({ ok: false, error: "could not load document" }, 502);
  }
  if (!doc?.s3FilePath) return json({ ok: false, error: "document not found" }, 404);

  return new Response(null, {
    status: 302,
    headers: { location: doc.s3FilePath, ...CORS_HEADERS },
  });
}

// -----------------------------
// Server
// -----------------------------
Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/invoices" && req.method === "GET") return handleInvoices(req, url);
    if (url.pathname === "/download" && req.method === "GET") return handleDownload(url);
    return json({ ok: true, message: "Use /health, /invoices?orderId=..., or /download?t=..." });
  },
});

const mode = DISABLE_AUTH ? "DISABLED (dev)" : OWNERSHIP_CHECK ? "airtight (ownership)" : "session-only";
console.log(`[pathway-invoice-proxy] listening on 0.0.0.0:${PORT}`);
console.log(`  shop=${PATHWAY_SHOP_ID} auth=${mode}`);
