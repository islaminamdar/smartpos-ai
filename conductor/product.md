# Product: SmartPOS.ai

**Last Updated:** 2026-06-12
**Status:** Phase 1 (AI Sidecar) in development

## Description

SmartPOS.ai is an AI-first point-of-sale product for small, owner-operated UAE
restaurants and cafés (1–3 outlets, 50–500 covers/day). It launches as an **AI sidecar**
that runs alongside the restaurant's existing POS, then evolves into a full standalone
cloud POS in later phases.

The wedge is three AI capabilities sold at a flat **100 AED/month** subscription (BYOD,
no hardware): multilingual voice ordering, a WhatsApp customer concierge, and a
natural-language owner dashboard.

## Target Users

- 1–3 outlet independent restaurants and cafés in the UAE, owner-operated.
- Multilingual staff (Arabic, English, Hindi, Urdu, Tagalog).
- Heavy WhatsApp users, already on Talabat / Deliveroo / Careem for a large share of revenue.

## Core Features (Phase 1)

1. **Voice Order Console** (`/order`) — staff speak an order in 5 languages; AI transcribes
   (Whisper) and parses it into a structured ticket validated against the tenant's menu;
   prints to ESC/POS thermal printers and shows on the KDS.
2. **WhatsApp AI Concierge** (`/api/whatsapp/webhook`) — customers order/reserve/ask via the
   restaurant's own WhatsApp Business number (Meta Cloud API); AI handles ~80%, escalates
   the rest; orders route to the same KDS.
3. **Owner Dashboard** (`/dashboard`) — owner asks natural-language questions; AI answers
   from captured data via a read-only, tenant-scoped SQL tool.
4. **Kitchen Display (KDS)** (`/kds`) — real-time order screen for the kitchen.
5. **Onboarding** (`/onboarding`) — guided menu import, WhatsApp connect, printer setup.

## Tech Stack

- **App:** Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui; multilingual via
  `next-intl` (Arabic RTL + English LTR). One codebase serves all PWAs.
- **Backend:** Next.js server actions + API routes.
- **Data / Auth / Realtime:** Supabase (Postgres + Auth + Realtime), RLS on every table,
  tenant-scoped. Schema in `supabase/migrations/`.
- **AI:** Anthropic Claude Sonnet (order parsing + dashboard Q&A); OpenAI Whisper (STT).
- **Integrations:** Meta WhatsApp Cloud API, PrintNode (ESC/POS), Stripe (billing),
  Sentry (observability).
- **Package manager:** pnpm (Node 20+).

## Repository Layout

- `app/` — routes (marketing, auth, app PWAs, API).
- `components/` — UI + feature components.
- `lib/` — `ai/`, `db/`, `whatsapp/`, `printing/`, `billing/`, `auth/`, `realtime/`, `i18n/`.
- `supabase/migrations/` — database schema, RLS, seed, RPC.
- `tests/` — `unit/` (Vitest) and `e2e/` (Playwright).

## Key Commands

- Dev: `pnpm dev` (http://localhost:3000)
- Typecheck: `pnpm typecheck`
- Unit tests: `pnpm test`
- E2E tests: `pnpm test:e2e`
- Lint: see `AGENTS.md` (Next 14 flat-config caveat)

## Non-Goals (Phase 1)

No payment processing, no aggregator sync, no native apps (PWA only), no
inventory/accounting, UAE-only, no multi-outlet hierarchy.
