# Pathway Invoice Download for Shopify

Adds a **"Rechnung"** card to the customer's order detail page (the
`account.vitafant.com/orders/...` pages) with a download button for every
invoice document Pathway has for that order — the main invoice plus any credit
notes (Gutschriften) from refunds.

## How it works (the 30-second version)

```
Customer's order page (Shopify)
   │  "Rechnung" card                ┌──────────────────────────────────┐
   │  (extension/, in browser)       │  Backend proxy (backend/)         │
   │                                 │  holds the secret Pathway key     │
   │  1. GET /invoices?orderId=...   │                                   │
   │     Bearer <session token>  ───►│  verify login (+ownership)        │
   │                                 │  ask Pathway which docs exist ───►│ Pathway API (?json=true)
   │  ◄── [{label, type,             │                                   │
   │        downloadUrl }]           │                                   │
   │                                 │                                   │
   │  2. click button → /download?t= │  fetch a FRESH signed PDF URL ───►│ Pathway API
   │     ───────────────────────────►│  302 redirect to the PDF          │
   └─────────────────────────────────┴──────────────────────────────────┘
```

Two parts, two folders:

| Folder       | What it is                                              | Where it runs                    |
|--------------|---------------------------------------------------------|----------------------------------|
| `backend/`   | Bun/TS HTTP proxy (same style as your token-manager)    | Railway (or any host)            |
| `extension/` | Shopify customer-account UI extension (the card)        | Inside Shopify, on the order page|

**Why a backend at all?** Two reasons, both confirmed by testing the real API:
1. The Pathway API key is secret — it must never reach the customer's browser.
2. Pathway's PDF links are pre-signed and **expire after ~60 seconds**, so a
   static link on a button would be dead by the time the customer clicks it. The
   backend fetches a *fresh* link on every click (`/download` → 302 redirect).

**Verified working (2026-06-17):** the key authenticates against `bfe811`, the
`?json=true` response shape is known (`type`, `number`, `s3FilePath`), and the
signed URL serves a real `%PDF` invoice. See "What we confirmed" at the bottom.

---

## Part A — Collect your secrets first

For the default ("session-only") setup you need just **two** things:

1. **Pathway API key** — Pathway dashboard → *Datenabruf über API* → click ➕ → copy the key.
   (Already in hand and verified for `bfe811`.)
2. **Shopify app Client ID + Client secret** — from the app you created
   (`VF-invoice-Download`): Dev Dashboard → your app → *Client credentials*.

**Optional (only for "airtight" ownership checks):** a Shopify Admin API token
with `read_orders`. In 2026 this comes from a one-time OAuth install (the old
"reveal once" custom-app flow was deprecated Jan 1 2026). Skip it to start — the
backend runs fine without it.

---

## Part B — Deploy the backend

```bash
cd backend
bun install            # creates bun.lockb so Railway uses Bun
```

1. Push `backend/` to a GitHub repo (or use `railway up`).
2. On Railway: **New Project → Deploy from GitHub repo** → pick it.
3. Add the environment variables (see `backend/.env.example`):
   - `PATHWAY_API_KEY` (your key)
   - `PATHWAY_SHOP_ID` = `bfe811.myshopify.com`
   - `SHOPIFY_APP_CLIENT_ID` = `075daad98ab1144c5692e3aa16228e76`
   - `SHOPIFY_APP_CLIENT_SECRET` (the `shpss_…` value)
   - *(optional, airtight only)* `SHOPIFY_ADMIN_TOKEN` + `SHOPIFY_STORE_DOMAIN`
4. Deploy. Note the public URL, e.g. `https://pathway-invoice-proxy.up.railway.app`.
5. Check it's alive: open `<url>/health` → should return `{"ok":true}`.

> **Local testing without auth:** set `DISABLE_AUTH=true` and run `bun run dev`,
> then `curl "http://localhost:8080/invoices?orderId=5746475827531"` (a real
> production order with an invoice). Never set `DISABLE_AUTH=true` in production.

> ⚠️ **Dev vs production store:** your Pathway key is for the **production**
> store `bfe811`. You've been testing the extension on **Vitafant Dev** (a
> different store), which has its own Pathway setup/key. Point `PATHWAY_API_KEY`
> + `PATHWAY_SHOP_ID` at whichever store you're actually deploying to.

---

## Part C — Build & deploy the extension

You need the Shopify CLI (`shopify version`; install with `npm i -g @shopify/cli`).

**1. Create the Shopify app** (this gives you the Client ID/secret for Part B):

```bash
shopify app init --name vitafant-invoice-app
cd vitafant-invoice-app
```

Find the **Client ID** and **Client secret** in the Shopify Partners dashboard
under this app → put them into the backend's env vars (Part B.3) and redeploy.

**2. Generate the extension, then drop in our code:**

```bash
shopify app generate extension --template customer_account_ui --name rechnung-block
# choose the TypeScript React template
```

This creates `extensions/rechnung-block/`. Replace its generated files with the
ones in this repo's `extension/` folder:

```bash
cp ../path-to-this-repo/extension/shopify.extension.toml extensions/rechnung-block/
cp ../path-to-this-repo/extension/src/RechnungBlock.tsx   extensions/rechnung-block/src/
```

**3. Point the card at your backend:** in `RechnungBlock.tsx`, set

```ts
const BACKEND_URL = "https://pathway-invoice-proxy.up.railway.app"; // your Part B URL
```

**4. Preview it:**

```bash
shopify app dev
```

Open the preview link, log in as a customer, open an order → you should see the
**Rechnung** card.

**5. Deploy:**

```bash
shopify app deploy
```

For the **live** store you must also request **network access** for the
extension in the Partner Dashboard (App → Extensions → request access) — until
that's granted, `fetch()` only works in dev.

---

## Part D — Place the card on the order page

1. Shopify admin → **Settings → Customer accounts** → open the editor (Customize).
2. Go to the **Order** (order status / detail) page.
3. Add the **Rechnung** block where you want it (e.g. under the order summary).
4. Save. Open a real order in the customer account to confirm the invoice
   downloads work.

---

## Things you'll likely want to tweak

- **Labels / language:** wording lives in `extension/src/RechnungBlock.tsx`
  ("Rechnung", "herunterladen", error text).
- **Card placement / heading:** in `RechnungBlock.tsx`.
- **Credit-note label detection:** `isCreditNote()` in `backend/index.ts` flags a
  document as a *Gutschrift* when its `type` contains REVERSAL/CREDIT/REFUND. We
  confirmed `type: "INVOICE"` for a normal invoice; once we see a real refunded
  order's document type, adjust that check if Pathway uses a different word.

## What we confirmed (live test, 2026-06-17)

- The key authenticates for `bfe811.myshopify.com` (valid key → 404 on a missing
  doc, garbage key → 403).
- `GET …/order/{numericOrderId}?json=true` returns a **single** document:
  ```json
  { "id": 42288597, "type": "INVOICE", "number": "RE-26",
    "s3FilePath": "https://storage.googleapis.com/…?X-Goog-Expires=60&…" }
  ```
- `s3FilePath` is a pre-signed URL that **expires in ~60s** and serves a real
  `%PDF` (174 KB). → handled by the `/download` fetch-fresh-then-redirect flow.

## Still to confirm (when a refunded order is available)

- `?json=true` returns only the **main** invoice. Credit notes (Gutschriften)
  come from the `?refund={refundId}` variant. The backend already queries those
  — in airtight mode it auto-discovers refund IDs via the Admin API; in
  session-only mode the extension can pass them as `?refundIds=a,b`.
- We haven't yet seen a real credit-note document's `type` value — verify
  `isCreditNote()` against one (e.g. dev order #1161, which is refunded).
