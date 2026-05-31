# SmartPOS.ai — Design Spec

**Date:** 2026-05-31
**Owner:** Islam Inamdar
**Status:** Draft, pending implementation plan

---

## 1. Product summary

SmartPOS.ai is an AI-first point-of-sale product for small, owner-operated UAE restaurants and cafés (1–3 outlets, 50–500 covers/day). It enters the market as an **AI sidecar** that runs alongside the restaurant's existing POS (Foodics, Loyverse, OrderPin, paper tickets, anything), then evolves into a full standalone POS over phase 2.

Wedge: voice ordering in 5 languages, WhatsApp customer concierge, and a natural-language owner dashboard. Subscription: **100 AED/month** flat for the beachhead product.

## 2. Target customer

- 1–3 outlet independent restaurants and cafés in UAE
- Owner-operated, 50–500 covers/day
- Heavy WhatsApp use for customer comms
- Multilingual staff (Arabic, English, Hindi, Urdu, Tagalog)
- Already on Talabat / Deliveroo / Careem for 40–70% of revenue

## 3. Phased product plan

### Phase 1 — AI Sidecar (months 0–2, ship to first paying customer)

A standalone web app + WhatsApp bot that the owner installs in parallel with their existing POS. Three features:

1. **Voice Order Console** — staff opens a tablet/phone web page, taps and speaks the order in any of 5 languages; AI transcribes (Whisper / Gemini / equivalent) and parses to a structured ticket; ticket prints on any Wi-Fi ESC/POS thermal printer and shows on a KDS browser tab in the kitchen.
2. **WhatsApp AI Concierge** — restaurant's WhatsApp Business number is connected via Meta Cloud API; customers can order, reserve, ask menu questions, and submit complaints in natural language; AI handles ~80%, escalates the rest to the owner; orders that come in route to the same KDS as voice orders.
3. **Voice/Chat Owner Dashboard** — owner opens an app on phone, asks in natural language: "how did we do yesterday vs last Friday?", "what's selling best this week?", "any complaints today?" — AI answers from the data captured by features 1 and 2.

What's deliberately **not** in Phase 1: full menu/inventory management, table management, cash drawer, formal VAT invoices, aggregator sync, payment processing. The restaurant's existing POS still owns those.

Subscription: **100 AED/month**, no hardware sold, BYOD (any Android tablet / iPhone / iPad / laptop with a browser).

### Phase 2 — Full POS Substrate (months 3–6)

The AI layer stays. Underneath it we ship a real cloud POS that replaces the restaurant's existing system:

- Menu, modifiers, combos, half-and-half
- Table & floor management
- KDS for kitchen + bar
- VAT-compliant invoicing (UAE FTA rules)
- End-of-day reports, shift management, multi-user
- Hardware bundle option (Sunmi/Epson printer + Android tablet, ~1,500 AED at break-even)
- **Aggregator sync via Deliverect** (Talabat + Deliveroo + Careem on day one)
- **Payment terminal integration** (Network International / Magnati / Geidea)

Pricing ladder activates:
- **Starter — 100 AED/mo:** POS + voice + WhatsApp + dashboard (no aggregator)
- **Pro — 199 AED/mo:** + aggregator sync via Deliverect + multi-user
- **Scale — 349 AED/mo:** + multi-outlet + advanced AI (demand forecasting, menu engineering, dine-in analytics)

### Phase 3 — AI Upsells (months 6+)
Demand forecasting & auto-prep, AI menu engineering, camera+AI dine-in analytics (separate hardware), direct aggregator integrations replacing Deliverect to recapture margin.

## 4. Architecture (Phase 1 detail)

### 4.1 Components

```
┌─────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐
│  Voice Order PWA    │  │  Owner Dashboard PWA │  │  Kitchen KDS PWA   │
│  (tablet / phone)   │  │  (phone / desktop)   │  │  (any browser)     │
└──────────┬──────────┘  └──────────┬───────────┘  └─────────┬──────────┘
           │                        │                        │
           └────────────┬───────────┴────────────┬───────────┘
                        │                        │
                        ▼                        │
                ┌───────────────────────────┐    │
                │  Next.js 14 App (Vercel)  │◀───┘
                │  - Server actions         │
                │  - Realtime via Pusher    │
                │  - Auth via Supabase      │
                └────────────┬──────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌──────────────────┐ ┌───────────────────┐ ┌──────────────────────┐
│ Supabase Postgres│ │ AI Services       │ │ Meta WhatsApp Cloud  │
│ - tenants        │ │ - Whisper (STT)   │ │ - Inbound webhook    │
│ - menus          │ │ - Claude/GPT      │ │ - Outbound send      │
│ - orders         │ │   (NLU + answers) │ │                      │
│ - conversations  │ │ - ElevenLabs(TTS) │ └──────────────────────┘
└──────────────────┘ └───────────────────┘
                             │
                             ▼
                ┌───────────────────────────┐
                │ Printer Bridge            │
                │ (PrintNode or local agent │
                │  → ESC/POS thermal)       │
                └───────────────────────────┘
```

### 4.2 Tech stack

- **Frontend:** Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui. Three PWAs share one codebase: `/order`, `/dashboard`, `/kds`. Multilingual UI via `next-intl` (Arabic RTL + English LTR for v1; Hindi/Urdu/Tagalog limited to voice input only at launch).
- **Backend:** Next.js server actions + Supabase (Postgres + Auth + Storage + Realtime).
- **Realtime:** Supabase Realtime for KDS order updates. Fallback: server-sent events.
- **AI:**
  - Speech-to-text: OpenAI Whisper API (multilingual) or Gemini 2.0 Flash (also multilingual + cheaper).
  - NLU & order parsing: Claude Sonnet 4.6 with structured-output tool calling against the tenant's menu schema.
  - Owner dashboard Q&A: Claude Sonnet 4.6 with read-only SQL tool over the tenant's data.
  - TTS (only on WhatsApp voice notes): ElevenLabs.
- **WhatsApp:** Meta Cloud API direct (not BSP) — restaurant onboards their own WhatsApp Business number. Webhook lives in Next.js.
- **Printing:** PrintNode for cloud-managed printing to ESC/POS thermal printers; small downloadable Windows/Mac/Android agent for restaurants that prefer LAN-only.
- **Hosting:** Vercel for the app, Supabase for data, Cloudflare R2 for audio uploads.
- **Observability:** Sentry + Supabase logs + a simple admin "tenant health" page.

### 4.3 Data model (Phase 1)

Tenant-scoped (RLS on every table):
- `tenants` — restaurant account
- `users` — owner + staff with role
- `menu_categories`, `menu_items`, `menu_modifiers` — for the AI to parse against
- `orders`, `order_items` — captured tickets (voice + WhatsApp)
- `conversations`, `messages` — WhatsApp threads, owner-dashboard chat threads
- `printers` — registered ESC/POS endpoints

### 4.4 AI order-parsing contract

Voice transcription + WhatsApp text both feed into one function: `parseOrder(rawText, tenantMenu) → StructuredOrder`. The LLM is forced via tool-calling to emit only items that exist in `menu_items` for that tenant, with modifiers limited to allowed values. Unknown items → clarification question back to staff/customer rather than silent failure.

### 4.5 Owner dashboard Q&A safety

The dashboard LLM gets a read-only Postgres role scoped to the tenant via RLS, plus a SQL tool. Every query is logged. Hallucination guardrail: answers must cite at least one row count or aggregate; if the tool returns empty, the answer says "no data" rather than fabricating.

## 5. UI/UX direction

- **Design system:** shadcn/ui base, custom theme. Two visual modes:
  - Voice Order PWA & KDS — high-contrast, large tap targets (kitchen gloves), minimal chrome, optimized for 10" tablets.
  - Owner Dashboard — premium "AI-first" feel; soft gradient surfaces, glassmorphism cards, generous whitespace. Reference look: Linear meets Cron meets Notion AI.
- **RTL support is first-class** — every layout is mirrored cleanly for Arabic, not bolted on.
- **Empty states sell the product** — every empty screen has a "try it now" voice prompt with a sample phrase in 5 languages.
- **Onboarding** is a single guided flow: scan QR to import menu (or upload PDF/photo of menu → AI extracts items), connect WhatsApp, register printer, done. Target: 10 minutes from signup to first AI-parsed order.

## 6. Pricing & billing

- **Phase 1:** flat 100 AED/mo, monthly subscription, 14-day free trial. Stripe in test mode for build; for UAE launch, switch to **Stripe + Mamo Pay** or **Telr** to accept local cards. Auto-pause account 7 days after first failed charge.
- Cost-of-goods per active tenant at 100 AED/mo, rough envelope:
  - AI usage: ~15–25 AED/mo (Whisper + Claude calls, capped via per-tenant budget alerts)
  - Supabase + Vercel slice: ~5 AED/mo
  - WhatsApp Cloud API: free for service conversations, ~0.10 AED per marketing message
  - PrintNode: $5 = ~18 AED/mo per location
  - Stripe fees: ~3 AED/mo
  - **Gross margin target: ~50% at 100 AED/mo**, improves with scale

## 7. Success criteria (Phase 1)

- Ship first paying customer by **week 8** of build start
- 10 paying tenants by **end of month 4**
- Median time-to-first-AI-order < **10 minutes** from signup
- Voice order parse accuracy ≥ **92%** measured across the 5 launch languages on a held-out sample
- WhatsApp concierge resolves ≥ **70%** of customer messages without owner intervention
- Tenant monthly churn < **6%** after month 3

## 8. Non-goals (explicit)

- No payment processing in Phase 1 (no Network International / Magnati integration)
- No aggregator sync in Phase 1
- No native iOS/Android apps — PWA only
- No hardware sold or rented in Phase 1
- No accounting/inventory in Phase 1
- No multi-currency / multi-country — UAE-only at launch
- No franchise / multi-outlet hierarchy in Phase 1

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Voice parse accuracy poor in dialectal Arabic | Pre-collect a 500-utterance evaluation set per language; ship a per-tenant menu-vocabulary boost into the prompt; fallback "did you mean…" UI |
| WhatsApp Cloud API account suspension | Onboard each restaurant on **their own** WhatsApp number, not ours; comply with Meta policy from day one; rate-limit outbound |
| LLM cost overrun on heavy tenants | Per-tenant monthly token budget with auto-throttle; cache menu embeddings; route simple intents to a cheap model |
| Restaurants won't pay for a "sidecar" they didn't ask for | Free 14-day trial; pricing held at 100 AED/mo until phase 2; sales motion is "give us 30 minutes, we'll save you 5 hours/week" |
| FTA / VAT compliance scope creep in Phase 2 | Defer all VAT invoicing to Phase 2 design; consult a UAE tax advisor before phase 2 build starts |
| Single-developer bus factor (me + Claude) | Keep the codebase small and conventional (Next.js + Supabase = hireable stack); write tests on the AI parsing contract |

## 10. Open questions for Phase 2 (deferred)

- Aggregator middleware: Deliverect confirmed vs Otter vs direct Talabat — needs vendor pricing call
- Payment terminal: Network International POS Connect vs Magnati Connect — needs partner-program intake
- Hardware kit SKU finalization
- VAT compliance audit with UAE-based accountant
- Multi-outlet hierarchy and reporting design

---

## Appendix A — Phase 1 page inventory

Routes in the single Next.js app:

- `/` — public marketing site (later, not week 1)
- `/signup`, `/login`
- `/onboarding` — guided menu import, WhatsApp link, printer setup
- `/order` — Voice Order Console (staff)
- `/kds` — Kitchen Display
- `/dashboard` — owner home (chat + summary cards)
- `/dashboard/orders` — order log + receipts reprint
- `/dashboard/menu` — menu editor (manual override of AI-imported menu)
- `/dashboard/whatsapp` — WhatsApp conversation inbox + AI takeover
- `/dashboard/settings` — printers, users, billing
- `/api/whatsapp/webhook` — Meta Cloud API receiver
- `/api/print` — print job dispatcher (PrintNode or local agent)
- `/api/ai/parse-order` — voice/text → structured order
- `/api/ai/dashboard-query` — owner Q&A endpoint
