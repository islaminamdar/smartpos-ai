# SmartPOS.ai Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the AI-Sidecar MVP — a Next.js app a UAE restaurant owner can sign up for, import their menu, register a printer, connect WhatsApp, and start taking voice orders + WhatsApp orders + asking the AI dashboard questions, all for 100 AED/month.

**Architecture:** Single Next.js 14 (App Router) codebase serving three role-scoped PWAs (`/order`, `/kds`, `/dashboard`). Supabase for Postgres + Auth + Realtime + Storage with strict tenant RLS. Claude Sonnet 4.6 for menu parsing, order parsing, and dashboard Q&A via tool-use. OpenAI Whisper for STT. Meta WhatsApp Cloud API for the concierge. PrintNode for printer dispatch. Vercel for hosting. Stripe + Telr for billing.

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, shadcn/ui, next-intl, Supabase JS, `@anthropic-ai/sdk`, `openai` (Whisper only), Meta Graph API, PrintNode REST, Stripe + Telr, Vitest, React Testing Library, Playwright, Sentry.

---

## File Structure

Top-level layout under `C:\claude-projects\smartpos-ai\`:

```
app/
  (marketing)/page.tsx                   # public landing
  (auth)/signup/page.tsx
  (auth)/login/page.tsx
  (app)/layout.tsx                       # auth-required shell
  (app)/onboarding/page.tsx              # 4-step wizard
  (app)/order/page.tsx                   # Voice Order Console
  (app)/kds/page.tsx                     # Kitchen Display
  (app)/dashboard/page.tsx               # Owner home (chat + cards)
  (app)/dashboard/orders/page.tsx
  (app)/dashboard/menu/page.tsx
  (app)/dashboard/whatsapp/page.tsx
  (app)/dashboard/settings/page.tsx
  api/whatsapp/webhook/route.ts          # Meta webhook
  api/ai/parse-order/route.ts
  api/ai/dashboard-query/route.ts
  api/ai/import-menu/route.ts
  api/print/route.ts
  api/stripe/webhook/route.ts
components/
  ui/                                    # shadcn primitives
  order/VoicePad.tsx
  order/OrderCart.tsx
  order/LanguagePicker.tsx
  kds/TicketCard.tsx
  kds/KdsBoard.tsx
  dashboard/ChatPanel.tsx
  dashboard/SummaryCards.tsx
  dashboard/WhatsAppInbox.tsx
  onboarding/MenuImportStep.tsx
  onboarding/WhatsAppLinkStep.tsx
  onboarding/PrinterStep.tsx
  shared/RtlBoundary.tsx
lib/
  ai/parseOrder.ts                       # core LLM parsing contract
  ai/dashboardQuery.ts                   # SQL-tool Q&A
  ai/importMenu.ts                       # PDF/image → structured menu
  ai/transcribe.ts                       # Whisper wrapper
  ai/prompts.ts                          # prompt strings, version-pinned
  db/supabase.ts                         # browser + server clients
  db/types.ts                            # generated DB types
  db/queries.ts                          # tenant-scoped query helpers
  whatsapp/client.ts                     # Meta Cloud API wrapper
  whatsapp/handler.ts                    # inbound message orchestration
  printing/printnode.ts                  # PrintNode client + ESC/POS formatter
  billing/stripe.ts
  i18n/config.ts                         # next-intl setup
  i18n/messages/{en,ar}.json
  realtime/orderChannel.ts               # Supabase Realtime helpers
  auth/session.ts                        # server-side auth/tenant resolution
  errors.ts                              # typed error envelope
  logger.ts                              # Sentry + console
supabase/
  migrations/
    20260531000000_init.sql
    20260531000100_rls.sql
    20260531000200_seed_demo.sql
  seed.sql
tests/
  unit/ai/parseOrder.test.ts
  unit/ai/dashboardQuery.test.ts
  unit/ai/importMenu.test.ts
  unit/whatsapp/handler.test.ts
  unit/printing/escpos.test.ts
  unit/db/rls.test.ts
  fixtures/menus/sample-uae-cafe.json
  fixtures/voice/{en,ar,hi,ur,tl}/*.json # transcript snippets + expected order
  fixtures/whatsapp/*.json
  e2e/order-flow.spec.ts
  e2e/onboarding.spec.ts
```

Boundaries:
- `lib/ai/*` is the AI surface. Anything calling Anthropic/OpenAI goes through these helpers. Tests pin the parsing contract.
- `lib/db/*` is the only place that touches Supabase. Routes and components import `queries.ts`, never the raw client.
- `lib/whatsapp/*` and `lib/printing/*` are external-integration wrappers — mocked in unit tests, real in integration tests.
- UI components are presentational; data fetching lives in server components or server actions.

---

## Conventions

- **Package manager:** `pnpm`. Lockfile committed.
- **Node:** 20 LTS. `engines` field set.
- **Test runner:** Vitest for unit + integration, Playwright for E2E.
- **TDD discipline:** every `lib/` function lands with its test in the same task.
- **Commit cadence:** commit at the end of every task. Conventional Commits.
- **Lint/format:** ESLint + Prettier + `pnpm typecheck` on every commit (pre-commit hook installed in Task 1).
- **Secrets:** `.env.local` for dev, never committed. `.env.example` documents every var. Vercel env vars for prod.

---

## Task 1: Project scaffold + tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.js`, `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `.env.example`, `vitest.config.ts`, `playwright.config.ts`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `.husky/pre-commit`

- [ ] **Step 1: Bootstrap Next.js**

Run:
```bash
cd C:\claude-projects\smartpos-ai
pnpm create next-app@14 . --typescript --tailwind --app --src-dir=false --import-alias "@/*" --eslint
```

Expected: Next.js 14 scaffold created. `app/page.tsx` exists.

- [ ] **Step 2: Install runtime deps**

Run:
```bash
pnpm add @supabase/supabase-js @supabase/ssr @anthropic-ai/sdk openai zod @hookform/resolvers react-hook-form next-intl date-fns stripe @sentry/nextjs
pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @playwright/test prettier prettier-plugin-tailwindcss husky lint-staged @types/node
```

Expected: deps installed, `pnpm-lock.yaml` updated.

- [ ] **Step 3: Add shadcn/ui**

Run:
```bash
pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button input textarea card dialog dropdown-menu form label select sheet sonner table tabs toast badge separator avatar
```

Expected: `components/ui/*` populated; `lib/utils.ts` created; Tailwind config updated.

- [ ] **Step 4: Write `.env.example`**

```dotenv
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# AI
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# WhatsApp (Meta Cloud API)
META_APP_ID=
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
# Per-tenant phone numbers + access tokens are stored in DB, not env

# PrintNode
PRINTNODE_API_KEY=

# Billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
TELR_STORE_ID=
TELR_AUTH_KEY=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
SENTRY_DSN=
```

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    globals: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
})
```

Create `tests/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 6: Add scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "format": "prettier --write .",
    "prepare": "husky"
  }
}
```

- [ ] **Step 7: Install husky pre-commit hook**

Run:
```bash
pnpm exec husky init
```

Edit `.husky/pre-commit`:

```bash
pnpm exec lint-staged
pnpm typecheck
```

Add to `package.json`:

```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["prettier --write", "eslint --fix"],
    "*.{json,md,css}": ["prettier --write"]
  }
}
```

- [ ] **Step 8: Initial smoke test**

Run:
```bash
pnpm dev
```

Expected: dev server boots on `http://localhost:3000` and the default Next.js page renders. Kill with Ctrl+C.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 14 + tooling"
```

---

## Task 2: Supabase project + schema + RLS

**Files:**
- Create: `supabase/migrations/20260531000000_init.sql`, `supabase/migrations/20260531000100_rls.sql`, `lib/db/supabase.ts`, `lib/db/types.ts`, `tests/unit/db/rls.test.ts`

- [ ] **Step 1: Provision Supabase project**

In Supabase dashboard create project `smartpos-ai-dev` (Frankfurt or Bahrain region). Copy URL, anon key, service role key into `.env.local`.

Install Supabase CLI locally and link:
```bash
pnpm add -g supabase
supabase login
supabase link --project-ref <ref>
```

- [ ] **Step 2: Write the init migration**

`supabase/migrations/20260531000000_init.sql`:

```sql
create extension if not exists "pgcrypto";

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  default_locale text not null default 'en',
  rtl boolean not null default false,
  whatsapp_phone_number_id text,
  whatsapp_access_token text,
  printnode_printer_id integer,
  stripe_customer_id text,
  subscription_status text not null default 'trial',
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('owner','manager','staff')),
  full_name text,
  created_at timestamptz not null default now()
);
create index on users (tenant_id);

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  sort_order int not null default 0
);
create index on menu_categories (tenant_id);

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category_id uuid references menu_categories(id) on delete set null,
  name text not null,
  name_translations jsonb not null default '{}',
  description text,
  price_aed numeric(10,2) not null,
  active boolean not null default true,
  aliases text[] not null default '{}',  -- AI-discovered names like "chai", "karak", "tea"
  created_at timestamptz not null default now()
);
create index on menu_items (tenant_id);
create index on menu_items using gin (aliases);

create table menu_modifiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references menu_items(id) on delete cascade,
  name text not null,
  options jsonb not null,  -- [{name, price_delta_aed}]
  required boolean not null default false
);
create index on menu_modifiers (tenant_id);

create type order_channel as enum ('voice','whatsapp','manual');
create type order_status as enum ('new','accepted','preparing','ready','served','cancelled');

create table orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel order_channel not null,
  status order_status not null default 'new',
  customer_name text,
  customer_phone text,
  table_label text,
  subtotal_aed numeric(10,2) not null default 0,
  total_aed numeric(10,2) not null default 0,
  raw_input text,            -- transcript / WhatsApp message
  parse_confidence numeric(4,3),
  created_at timestamptz not null default now()
);
create index on orders (tenant_id, created_at desc);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id) on delete set null,
  name_snapshot text not null,
  qty int not null check (qty > 0),
  unit_price_aed numeric(10,2) not null,
  modifiers_snapshot jsonb not null default '[]',
  notes text
);
create index on order_items (order_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','dashboard_chat')),
  external_id text,  -- WhatsApp wa_id
  customer_name text,
  ai_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on conversations (tenant_id, created_at desc);
create unique index on conversations (tenant_id, channel, external_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  author text not null check (author in ('customer','ai','owner','system')),
  body text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on messages (conversation_id, created_at);

create table printers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  printnode_id integer not null,
  label text not null,
  active boolean not null default true
);

create table ai_usage (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,                 -- 'parse_order' | 'dashboard_query' | 'whatsapp_reply' | 'transcribe' | 'import_menu'
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10,5) not null default 0,
  created_at timestamptz not null default now()
);
create index on ai_usage (tenant_id, created_at desc);
```

- [ ] **Step 3: Write the RLS migration**

`supabase/migrations/20260531000100_rls.sql`:

```sql
-- Helper: tenant_id for the current auth user
create or replace function current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from users where id = auth.uid()
$$;

alter table tenants enable row level security;
alter table users enable row level security;
alter table menu_categories enable row level security;
alter table menu_items enable row level security;
alter table menu_modifiers enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table printers enable row level security;
alter table ai_usage enable row level security;

-- Tenants: only own tenant readable, no direct insert/update from clients
create policy tenants_self_read on tenants for select using (id = current_tenant_id());

-- Users: read everyone in own tenant
create policy users_same_tenant on users for select using (tenant_id = current_tenant_id());

-- Generic tenant-scoped policy template
create policy menu_categories_rw on menu_categories for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy menu_items_rw on menu_items for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy menu_modifiers_rw on menu_modifiers for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy orders_rw on orders for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy order_items_rw on order_items for all
  using (exists (select 1 from orders o where o.id = order_items.order_id and o.tenant_id = current_tenant_id()))
  with check (exists (select 1 from orders o where o.id = order_items.order_id and o.tenant_id = current_tenant_id()));

create policy conversations_rw on conversations for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy messages_rw on messages for all
  using (exists (select 1 from conversations c where c.id = messages.conversation_id and c.tenant_id = current_tenant_id()))
  with check (exists (select 1 from conversations c where c.id = messages.conversation_id and c.tenant_id = current_tenant_id()));

create policy printers_rw on printers for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy ai_usage_read on ai_usage for select using (tenant_id = current_tenant_id());
```

- [ ] **Step 4: Apply migrations**

Run:
```bash
supabase db push
```

Expected: migrations run successfully against the linked project.

- [ ] **Step 5: Generate TypeScript types**

Run:
```bash
supabase gen types typescript --linked > lib/db/types.ts
```

Expected: `lib/db/types.ts` contains a `Database` type with all the tables above.

- [ ] **Step 6: Write `lib/db/supabase.ts`**

```ts
import { createBrowserClient, createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from './types'

export function createBrowser() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

export async function createServer() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    },
  )
}

export function createServiceRole() {
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } },
  )
}
```

- [ ] **Step 7: Write the RLS sanity test**

`tests/unit/db/rls.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/db/types'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

describe('RLS', () => {
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    const admin = createClient<Database>(url, service)
    const { data: a } = await admin.from('tenants').insert({ name: 'A' }).select('id').single()
    const { data: b } = await admin.from('tenants').insert({ name: 'B' }).select('id').single()
    tenantA = a!.id
    tenantB = b!.id
    await admin.from('menu_categories').insert({ tenant_id: tenantA, name: 'Drinks' })
    await admin.from('menu_categories').insert({ tenant_id: tenantB, name: 'Drinks' })
  })

  it('anonymous client cannot read menu_categories', async () => {
    const anonClient = createClient<Database>(url, anon)
    const { data } = await anonClient.from('menu_categories').select('*')
    expect(data ?? []).toHaveLength(0)
  })
})
```

- [ ] **Step 8: Run the RLS test**

Run:
```bash
pnpm test tests/unit/db/rls.test.ts
```

Expected: PASS — anonymous client sees zero rows.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(db): initial schema + RLS + supabase clients"
```

---

## Task 3: Auth + tenant bootstrap

**Files:**
- Create: `app/(auth)/signup/page.tsx`, `app/(auth)/login/page.tsx`, `app/(auth)/actions.ts`, `app/(app)/layout.tsx`, `lib/auth/session.ts`, `middleware.ts`, `tests/unit/auth/session.test.ts`

- [ ] **Step 1: Write the session resolver test**

`tests/unit/auth/session.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { resolveSession } from '@/lib/auth/session'

vi.mock('@/lib/db/supabase', () => ({
  createServer: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { tenant_id: 't1', role: 'owner' }, error: null }) }) }),
    }),
  })),
}))

describe('resolveSession', () => {
  it('returns the user + tenant when authenticated', async () => {
    const s = await resolveSession()
    expect(s).toEqual({ userId: 'u1', tenantId: 't1', role: 'owner' })
  })
})
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm test tests/unit/auth/session.test.ts`
Expected: FAIL — `resolveSession` not defined.

- [ ] **Step 3: Implement `lib/auth/session.ts`**

```ts
import { createServer } from '@/lib/db/supabase'

export type Session = { userId: string; tenantId: string; role: 'owner'|'manager'|'staff' }

export async function resolveSession(): Promise<Session | null> {
  const sb = await createServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return null
  const { data } = await sb.from('users').select('tenant_id, role').eq('id', user.id).single()
  if (!data) return null
  return { userId: user.id, tenantId: data.tenant_id, role: data.role }
}

export async function requireSession(): Promise<Session> {
  const s = await resolveSession()
  if (!s) throw new Error('UNAUTHENTICATED')
  return s
}
```

- [ ] **Step 4: Confirm test passes**

Run: `pnpm test tests/unit/auth/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement signup action**

`app/(auth)/actions.ts`:

```ts
'use server'
import { createServer, createServiceRole } from '@/lib/db/supabase'
import { redirect } from 'next/navigation'
import { z } from 'zod'

const Signup = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2),
  restaurantName: z.string().min(2),
})

export async function signup(formData: FormData) {
  const parsed = Signup.parse({
    email: formData.get('email'),
    password: formData.get('password'),
    fullName: formData.get('fullName'),
    restaurantName: formData.get('restaurantName'),
  })
  const sb = await createServer()
  const { data: auth, error } = await sb.auth.signUp({
    email: parsed.email,
    password: parsed.password,
  })
  if (error || !auth.user) throw error ?? new Error('Signup failed')

  const admin = createServiceRole()
  const { data: tenant } = await admin.from('tenants').insert({
    name: parsed.restaurantName,
  }).select('id').single()
  await admin.from('users').insert({
    id: auth.user.id,
    tenant_id: tenant!.id,
    role: 'owner',
    full_name: parsed.fullName,
  })

  redirect('/onboarding')
}

export async function login(formData: FormData) {
  const sb = await createServer()
  const { error } = await sb.auth.signInWithPassword({
    email: String(formData.get('email')),
    password: String(formData.get('password')),
  })
  if (error) throw error
  redirect('/dashboard')
}

export async function logout() {
  const sb = await createServer()
  await sb.auth.signOut()
  redirect('/login')
}
```

- [ ] **Step 6: Implement signup/login pages**

`app/(auth)/signup/page.tsx`:

```tsx
import { signup } from '../actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">Start your free trial</h1>
      <p className="text-muted-foreground">14 days free. No card required.</p>
      <form action={signup} className="flex flex-col gap-4">
        <div><Label htmlFor="fullName">Your name</Label><Input id="fullName" name="fullName" required/></div>
        <div><Label htmlFor="restaurantName">Restaurant name</Label><Input id="restaurantName" name="restaurantName" required/></div>
        <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" required/></div>
        <div><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" minLength={8} required/></div>
        <Button type="submit" size="lg">Create account</Button>
      </form>
    </main>
  )
}
```

`app/(auth)/login/page.tsx`:

```tsx
import { login } from '../actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
      <form action={login} className="flex flex-col gap-4">
        <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" required/></div>
        <div><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" required/></div>
        <Button type="submit" size="lg">Sign in</Button>
      </form>
    </main>
  )
}
```

- [ ] **Step 7: Add middleware for the `(app)` group**

`middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (c) => c.forEach(({ name, value, options }) => res.cookies.set(name, value, options)),
      },
    },
  )
  const { data: { user } } = await supabase.auth.getUser()
  const isAppRoute = req.nextUrl.pathname.startsWith('/dashboard')
    || req.nextUrl.pathname.startsWith('/order')
    || req.nextUrl.pathname.startsWith('/kds')
    || req.nextUrl.pathname.startsWith('/onboarding')
  if (isAppRoute && !user) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return res
}

export const config = {
  matcher: ['/dashboard/:path*', '/order/:path*', '/kds/:path*', '/onboarding/:path*'],
}
```

- [ ] **Step 8: Manual smoke test**

Run: `pnpm dev` → visit `/signup` → create an account → confirm redirect to `/onboarding`. Visit `/dashboard` while logged out → confirm redirect to `/login`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(auth): signup, login, session resolver, route guard"
```

---

## Task 4: AI prompt module + parseOrder contract

**Files:**
- Create: `lib/ai/prompts.ts`, `lib/ai/parseOrder.ts`, `tests/fixtures/menus/sample-uae-cafe.json`, `tests/unit/ai/parseOrder.test.ts`

- [ ] **Step 1: Define the menu fixture**

`tests/fixtures/menus/sample-uae-cafe.json`:

```json
{
  "items": [
    { "id": "m1", "name": "Karak Tea", "aliases": ["karak", "chai", "chaai", "tea"], "price_aed": 5, "modifiers": [{"name":"sugar","options":["regular","less","no"]}] },
    { "id": "m2", "name": "Chicken Biryani", "aliases": ["biryani", "biriyani"], "price_aed": 25, "modifiers": [{"name":"spice","options":["mild","medium","spicy"]}] },
    { "id": "m3", "name": "Cheese Manakish", "aliases": ["cheese manaish", "manaeesh", "manakeesh"], "price_aed": 15 },
    { "id": "m4", "name": "Mineral Water 500ml", "aliases": ["water", "moya", "maa"], "price_aed": 2 }
  ]
}
```

- [ ] **Step 2: Write the parseOrder test (failing)**

`tests/unit/ai/parseOrder.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseOrder } from '@/lib/ai/parseOrder'
import menu from '@/tests/fixtures/menus/sample-uae-cafe.json'

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = {
        create: vi.fn(async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_order',
            input: {
              items: [
                { menu_item_id: 'm1', qty: 2, modifiers: [{ name: 'sugar', value: 'less' }] },
                { menu_item_id: 'm2', qty: 1, modifiers: [{ name: 'spice', value: 'medium' }] },
              ],
              confidence: 0.94,
              clarification_needed: null,
            },
          }],
          usage: { input_tokens: 800, output_tokens: 120 },
        })),
      }
    },
  }
})

beforeEach(() => vi.clearAllMocks())

describe('parseOrder', () => {
  it('parses a multilingual order against the tenant menu', async () => {
    const result = await parseOrder({
      text: 'two karak less sugar and one chicken biryani medium spicy',
      menu: menu.items,
      locale: 'en',
    })
    expect(result.items).toHaveLength(2)
    expect(result.items[0].menu_item_id).toBe('m1')
    expect(result.items[0].qty).toBe(2)
    expect(result.confidence).toBeGreaterThan(0.9)
    expect(result.clarification_needed).toBeNull()
  })
})
```

- [ ] **Step 3: Run test and confirm failure**

Run: `pnpm test tests/unit/ai/parseOrder.test.ts`
Expected: FAIL — `parseOrder` not found.

- [ ] **Step 4: Implement `lib/ai/prompts.ts`**

```ts
export const PARSE_ORDER_SYSTEM = `You are a restaurant point-of-sale order parser for a UAE café.
You receive: (1) a transcript of a staff member or customer speaking, possibly in English, Arabic, Hindi, Urdu, or Tagalog, mixed freely; (2) the restaurant's menu as JSON.
Your job: emit a structured order by calling the submit_order tool.
Rules:
- Only choose menu_item_id values that exist in the provided menu.
- Match items by name and aliases. Be generous about spelling variation and transliteration.
- If quantity is unspecified, default to 1.
- If a modifier is mentioned but not allowed for the item, ignore it.
- If a clearly ordered item does not exist in the menu, do NOT invent one — set clarification_needed to a short question asking the staff to confirm.
- Return a confidence score between 0 and 1 reflecting how sure you are.
- Never output natural-language commentary, only the tool call.`

export const DASHBOARD_QUERY_SYSTEM = `You are the SmartPOS owner's analytics assistant. You answer questions about THIS restaurant's data only.
You have a read-only SQL tool restricted to the owner's tenant by RLS. Always run a query before answering — never guess from prior context.
If the query returns no rows, say "no data" rather than fabricating.
Keep answers under 3 sentences. Format numbers with AED prefix and thousands separators. When comparing days, mention both numbers.`

export const WHATSAPP_REPLY_SYSTEM = `You are the polite, concise WhatsApp concierge for a UAE restaurant.
- Reply in the customer's language (Arabic / English / Hindi / Urdu / Tagalog).
- For order requests, call the submit_order tool with the menu provided.
- For reservation requests, call the create_reservation tool.
- For menu questions, answer in 1-2 sentences from the menu JSON.
- For complaints or anything sensitive, call the escalate_to_owner tool with a short summary and stop replying.
- Never promise prices or items not on the menu.`
```

- [ ] **Step 5: Implement `lib/ai/parseOrder.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { PARSE_ORDER_SYSTEM } from './prompts'

export type MenuItem = {
  id: string
  name: string
  aliases: string[]
  price_aed: number
  modifiers?: { name: string; options: string[] }[]
}

export type ParsedOrder = {
  items: { menu_item_id: string; qty: number; modifiers: { name: string; value: string }[]; note?: string }[]
  confidence: number
  clarification_needed: string | null
  usage: { input_tokens: number; output_tokens: number }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function parseOrder(args: {
  text: string
  menu: MenuItem[]
  locale: string
}): Promise<ParsedOrder> {
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: PARSE_ORDER_SYSTEM,
    tools: [{
      name: 'submit_order',
      description: 'Submit the parsed order',
      input_schema: {
        type: 'object',
        required: ['items', 'confidence', 'clarification_needed'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['menu_item_id', 'qty'],
              properties: {
                menu_item_id: { type: 'string' },
                qty: { type: 'integer', minimum: 1 },
                modifiers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'value'],
                    properties: { name: { type: 'string' }, value: { type: 'string' } },
                  },
                  default: [],
                },
                note: { type: 'string' },
              },
            },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          clarification_needed: { type: ['string', 'null'] },
        },
      },
    }],
    tool_choice: { type: 'tool', name: 'submit_order' },
    messages: [{
      role: 'user',
      content: `Locale: ${args.locale}\nMenu JSON:\n${JSON.stringify(args.menu)}\n\nTranscript:\n"""${args.text}"""`,
    }],
  })
  const block = resp.content.find(b => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') {
    throw new Error('Model did not call submit_order')
  }
  const input = block.input as { items: ParsedOrder['items']; confidence: number; clarification_needed: string | null }
  return {
    ...input,
    usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens },
  }
}
```

- [ ] **Step 6: Confirm test passes**

Run: `pnpm test tests/unit/ai/parseOrder.test.ts`
Expected: PASS.

- [ ] **Step 7: Add an "unknown item triggers clarification" test**

Append to `tests/unit/ai/parseOrder.test.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'

it('asks for clarification when an item is not on the menu', async () => {
  vi.mocked((Anthropic as any).prototype.messages.create).mockResolvedValueOnce({
    content: [{
      type: 'tool_use',
      name: 'submit_order',
      input: {
        items: [],
        confidence: 0.3,
        clarification_needed: 'Did you mean Cheese Manakish? We do not have "zaatar pizza" on the menu.',
      },
    }],
    usage: { input_tokens: 600, output_tokens: 60 },
  })
  const result = await parseOrder({ text: 'one zaatar pizza', menu: menu.items, locale: 'en' })
  expect(result.items).toHaveLength(0)
  expect(result.clarification_needed).toMatch(/manakish/i)
})
```

Run: `pnpm test tests/unit/ai/parseOrder.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ai): parseOrder contract with tool-call structured output"
```

---

## Task 5: Whisper transcription wrapper

**Files:**
- Create: `lib/ai/transcribe.ts`, `tests/unit/ai/transcribe.test.ts`

- [ ] **Step 1: Write failing test**

`tests/unit/ai/transcribe.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { transcribe } from '@/lib/ai/transcribe'

vi.mock('openai', () => ({
  default: class {
    audio = {
      transcriptions: {
        create: vi.fn(async () => ({ text: 'two karak less sugar', language: 'english' })),
      },
    }
  },
}))

describe('transcribe', () => {
  it('returns text and detected language', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })
    const result = await transcribe(blob, 'en')
    expect(result.text).toContain('karak')
    expect(result.language).toBe('en')
  })
})
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm test tests/unit/ai/transcribe.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/ai/transcribe.ts`**

```ts
import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const LANG_MAP: Record<string, string> = { en: 'en', ar: 'ar', hi: 'hi', ur: 'ur', tl: 'tl' }
const REVERSE: Record<string, string> = { english: 'en', arabic: 'ar', hindi: 'hi', urdu: 'ur', tagalog: 'tl' }

export async function transcribe(audio: Blob, hintLocale?: string) {
  const file = new File([audio], 'audio.webm', { type: audio.type || 'audio/webm' })
  const resp: any = await client.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: hintLocale ? LANG_MAP[hintLocale] : undefined,
    response_format: 'verbose_json',
  })
  return { text: resp.text as string, language: REVERSE[resp.language] ?? hintLocale ?? 'en' }
}
```

- [ ] **Step 4: Pass**

Run: `pnpm test tests/unit/ai/transcribe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ai): Whisper transcription wrapper"
```

---

## Task 6: parse-order API route

**Files:**
- Create: `app/api/ai/parse-order/route.ts`, `lib/db/queries.ts`, `tests/unit/api/parse-order.test.ts`

- [ ] **Step 1: Add tenant menu query**

`lib/db/queries.ts`:

```ts
import { createServer } from './supabase'
import type { MenuItem } from '@/lib/ai/parseOrder'

export async function getTenantMenu(tenantId: string): Promise<MenuItem[]> {
  const sb = await createServer()
  const { data } = await sb
    .from('menu_items')
    .select('id, name, aliases, price_aed, menu_modifiers(name, options)')
    .eq('tenant_id', tenantId)
    .eq('active', true)
  return (data ?? []).map(r => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases ?? [],
    price_aed: Number(r.price_aed),
    modifiers: (r.menu_modifiers ?? []).map((m: any) => ({
      name: m.name,
      options: (m.options as any[]).map(o => o.name ?? o),
    })),
  }))
}
```

- [ ] **Step 2: Write route**

`app/api/ai/parse-order/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { parseOrder } from '@/lib/ai/parseOrder'
import { transcribe } from '@/lib/ai/transcribe'
import { getTenantMenu } from '@/lib/db/queries'
import { createServer, createServiceRole } from '@/lib/db/supabase'

const Body = z.union([
  z.object({ kind: z.literal('text'), text: z.string(), locale: z.string().default('en'), tableLabel: z.string().optional() }),
  z.object({ kind: z.literal('audio'), audioBase64: z.string(), mime: z.string(), locale: z.string().default('en'), tableLabel: z.string().optional() }),
])

export async function POST(req: Request) {
  const session = await requireSession()
  const body = Body.parse(await req.json())
  let text: string
  let detectedLocale = body.locale
  if (body.kind === 'audio') {
    const bin = Buffer.from(body.audioBase64, 'base64')
    const blob = new Blob([bin], { type: body.mime })
    const t = await transcribe(blob, body.locale)
    text = t.text
    detectedLocale = t.language
  } else {
    text = body.text
  }

  const menu = await getTenantMenu(session.tenantId)
  const parsed = await parseOrder({ text, menu, locale: detectedLocale })

  const admin = createServiceRole()
  const subtotal = parsed.items.reduce((sum, it) => {
    const m = menu.find(x => x.id === it.menu_item_id)
    return sum + (m ? m.price_aed * it.qty : 0)
  }, 0)
  const { data: order } = await admin.from('orders').insert({
    tenant_id: session.tenantId,
    channel: 'voice',
    status: parsed.clarification_needed ? 'new' : 'accepted',
    table_label: body.tableLabel ?? null,
    raw_input: text,
    parse_confidence: parsed.confidence,
    subtotal_aed: subtotal,
    total_aed: subtotal,
  }).select('id').single()
  if (parsed.items.length && order) {
    await admin.from('order_items').insert(parsed.items.map(it => {
      const m = menu.find(x => x.id === it.menu_item_id)!
      return {
        order_id: order.id,
        menu_item_id: m.id,
        name_snapshot: m.name,
        qty: it.qty,
        unit_price_aed: m.price_aed,
        modifiers_snapshot: it.modifiers ?? [],
        notes: it.note ?? null,
      }
    }))
  }
  await admin.from('ai_usage').insert({
    tenant_id: session.tenantId,
    kind: 'parse_order',
    model: 'claude-sonnet-4-6',
    input_tokens: parsed.usage.input_tokens,
    output_tokens: parsed.usage.output_tokens,
    cost_usd: parsed.usage.input_tokens * 0.000003 + parsed.usage.output_tokens * 0.000015,
  })
  return NextResponse.json({ orderId: order?.id, parsed })
}
```

- [ ] **Step 3: Integration test (mocked)**

`tests/unit/api/parse-order.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: 'u', tenantId: 't', role: 'owner' }) }))
vi.mock('@/lib/ai/parseOrder', () => ({ parseOrder: async () => ({ items: [{ menu_item_id: 'm1', qty: 2, modifiers: [] }], confidence: 0.9, clarification_needed: null, usage: { input_tokens: 10, output_tokens: 5 } }) }))
vi.mock('@/lib/db/queries', () => ({ getTenantMenu: async () => [{ id: 'm1', name: 'Karak', aliases: [], price_aed: 5 }] }))
const inserts: any[] = []
vi.mock('@/lib/db/supabase', () => ({
  createServiceRole: () => ({
    from: (table: string) => ({
      insert: (row: any) => { inserts.push({ table, row }); return { select: () => ({ single: async () => ({ data: { id: 'o1' } }) }) } },
    }),
  }),
}))

import { POST } from '@/app/api/ai/parse-order/route'

describe('parse-order route', () => {
  it('creates an order from text input', async () => {
    const req = new Request('http://test/api/ai/parse-order', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'two karak', locale: 'en' }) })
    const res = await POST(req)
    const json = await res.json()
    expect(json.orderId).toBe('o1')
    expect(inserts.some(i => i.table === 'orders')).toBe(true)
    expect(inserts.some(i => i.table === 'order_items')).toBe(true)
  })
})
```

Run: `pnpm test tests/unit/api/parse-order.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(api): parse-order route persists orders + AI usage"
```

---

## Task 7: Voice Order Console UI

**Files:**
- Create: `app/(app)/order/page.tsx`, `components/order/VoicePad.tsx`, `components/order/OrderCart.tsx`, `components/order/LanguagePicker.tsx`

- [ ] **Step 1: Implement `VoicePad`**

`components/order/VoicePad.tsx`:

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Mic, Square } from 'lucide-react'

export function VoicePad({ locale, onResult }: { locale: string; onResult: (orderId: string, parsed: any) => void }) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    chunksRef.current = []
    rec.ondataavailable = e => e.data.size && chunksRef.current.push(e.data)
    rec.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      stream.getTracks().forEach(t => t.stop())
      await submit(blob)
    }
    recorderRef.current = rec
    rec.start()
    setRecording(true)
  }

  function stop() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  async function submit(blob: Blob) {
    setBusy(true)
    try {
      const audioBase64 = Buffer.from(await blob.arrayBuffer()).toString('base64')
      const res = await fetch('/api/ai/parse-order', {
        method: 'POST',
        body: JSON.stringify({ kind: 'audio', audioBase64, mime: blob.type, locale }),
      })
      const json = await res.json()
      onResult(json.orderId, json.parsed)
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <Button
        size="lg"
        className="h-32 w-32 rounded-full"
        onClick={recording ? stop : start}
        disabled={busy}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
      >
        {recording ? <Square className="h-12 w-12"/> : <Mic className="h-12 w-12"/>}
      </Button>
      <p className="text-sm text-muted-foreground">
        {busy ? 'Transcribing…' : recording ? 'Listening… tap to stop' : 'Tap and speak the order'}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Implement `LanguagePicker`**

`components/order/LanguagePicker.tsx`:

```tsx
'use client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ur', label: 'اردو' },
  { code: 'tl', label: 'Tagalog' },
]

export function LanguagePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-40"><SelectValue/></SelectTrigger>
      <SelectContent>
        {LANGS.map(l => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
```

- [ ] **Step 3: Implement `OrderCart`**

`components/order/OrderCart.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export function OrderCart({ parsed }: { parsed: any | null }) {
  if (!parsed) return <Card><CardContent className="p-6 text-muted-foreground">No order yet. Tap the mic.</CardContent></Card>
  if (parsed.clarification_needed) {
    return <Card><CardContent className="p-6"><p className="font-medium">Need clarification:</p><p>{parsed.clarification_needed}</p></CardContent></Card>
  }
  return (
    <Card>
      <CardHeader><CardTitle>Order parsed <Badge variant="secondary">{Math.round(parsed.confidence*100)}%</Badge></CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        {parsed.items.map((it: any, i: number) => (
          <div key={i} className="flex items-center justify-between">
            <span>{it.qty} × {it.name_snapshot ?? it.menu_item_id}</span>
            <span className="text-muted-foreground text-sm">
              {it.modifiers?.map((m: any) => `${m.name}: ${m.value}`).join(', ')}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Implement the page**

`app/(app)/order/page.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { VoicePad } from '@/components/order/VoicePad'
import { OrderCart } from '@/components/order/OrderCart'
import { LanguagePicker } from '@/components/order/LanguagePicker'

export default function OrderPage() {
  const [locale, setLocale] = useState('en')
  const [parsed, setParsed] = useState<any | null>(null)
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Voice Order</h1>
        <LanguagePicker value={locale} onChange={setLocale}/>
      </header>
      <VoicePad locale={locale} onResult={(_id, p) => setParsed(p)}/>
      <OrderCart parsed={parsed}/>
    </main>
  )
}
```

- [ ] **Step 5: Manual smoke**

Run `pnpm dev`, log in, visit `/order`, tap mic, say "two karak less sugar", verify parsed cart appears.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(order): Voice Order Console with mic + transcribe + parse"
```

---

## Task 8: Kitchen Display + realtime channel

**Files:**
- Create: `lib/realtime/orderChannel.ts`, `app/(app)/kds/page.tsx`, `components/kds/KdsBoard.tsx`, `components/kds/TicketCard.tsx`, `tests/unit/realtime/orderChannel.test.ts`

- [ ] **Step 1: Implement `orderChannel.ts`**

```ts
import { createBrowser } from '@/lib/db/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

export type OrderRow = {
  id: string; status: string; table_label: string | null; total_aed: number; created_at: string
  items: { name_snapshot: string; qty: number; modifiers_snapshot: any[] }[]
}

export function subscribeOrders(tenantId: string, onChange: () => void): RealtimeChannel {
  const sb = createBrowser()
  return sb.channel(`orders:${tenantId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `tenant_id=eq.${tenantId}` }, () => onChange())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => onChange())
    .subscribe()
}
```

- [ ] **Step 2: Implement TicketCard**

```tsx
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatDistanceToNow } from 'date-fns'
import type { OrderRow } from '@/lib/realtime/orderChannel'

export function TicketCard({ order, onAdvance }: { order: OrderRow; onAdvance: (next: string) => void }) {
  const next = { new: 'preparing', preparing: 'ready', ready: 'served' }[order.status] ?? null
  return (
    <Card className="border-2">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          {order.table_label && <Badge>{order.table_label}</Badge>}
          <span>#{order.id.slice(0,4)}</span>
        </CardTitle>
        <span className="text-sm text-muted-foreground">{formatDistanceToNow(new Date(order.created_at))} ago</span>
      </CardHeader>
      <CardContent className="space-y-1 text-lg">
        {order.items.map((it, i) => (
          <div key={i}>
            <span className="font-semibold">{it.qty}×</span> {it.name_snapshot}
            {it.modifiers_snapshot.length > 0 && (
              <div className="ml-6 text-sm text-muted-foreground">{it.modifiers_snapshot.map((m: any) => `${m.name}: ${m.value}`).join(', ')}</div>
            )}
          </div>
        ))}
      </CardContent>
      <CardFooter>
        {next && <Button onClick={() => onAdvance(next)}>Mark {next}</Button>}
      </CardFooter>
    </Card>
  )
}
```

- [ ] **Step 3: Implement KdsBoard**

```tsx
'use client'
import { useEffect, useState } from 'react'
import { createBrowser } from '@/lib/db/supabase'
import { subscribeOrders, type OrderRow } from '@/lib/realtime/orderChannel'
import { TicketCard } from './TicketCard'

export function KdsBoard({ tenantId }: { tenantId: string }) {
  const [orders, setOrders] = useState<OrderRow[]>([])

  async function load() {
    const sb = createBrowser()
    const { data } = await sb
      .from('orders')
      .select('id, status, table_label, total_aed, created_at, order_items(name_snapshot, qty, modifiers_snapshot)')
      .in('status', ['new','accepted','preparing','ready'])
      .order('created_at', { ascending: true })
    setOrders((data ?? []).map((o: any) => ({ ...o, items: o.order_items })))
  }

  useEffect(() => {
    load()
    const ch = subscribeOrders(tenantId, load)
    return () => { ch.unsubscribe() }
  }, [tenantId])

  async function advance(id: string, status: string) {
    const sb = createBrowser()
    await sb.from('orders').update({ status }).eq('id', id)
  }

  return (
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {orders.map(o => <TicketCard key={o.id} order={o} onAdvance={s => advance(o.id, s)}/>)}
      {orders.length === 0 && <p className="text-muted-foreground col-span-full text-center text-lg">No tickets — try sending a voice order.</p>}
    </div>
  )
}
```

- [ ] **Step 4: Implement page (server-resolves tenantId)**

`app/(app)/kds/page.tsx`:

```tsx
import { requireSession } from '@/lib/auth/session'
import { KdsBoard } from '@/components/kds/KdsBoard'

export default async function KdsPage() {
  const s = await requireSession()
  return <KdsBoard tenantId={s.tenantId}/>
}
```

- [ ] **Step 5: Smoke test KDS**

Run `pnpm dev`. In one tab open `/order`, in another `/kds`. Place a voice order → new ticket appears within ~1s without reload.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(kds): Kitchen Display with Supabase Realtime"
```

---

## Task 9: PrintNode printer bridge

**Files:**
- Create: `lib/printing/printnode.ts`, `lib/printing/escpos.ts`, `app/api/print/route.ts`, `tests/unit/printing/escpos.test.ts`

- [ ] **Step 1: Write ESC/POS formatter test**

`tests/unit/printing/escpos.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatTicket } from '@/lib/printing/escpos'

describe('escpos formatTicket', () => {
  it('contains header, items, and total', () => {
    const out = formatTicket({
      tenantName: 'Test Café',
      orderId: 'abc1234',
      tableLabel: 'T5',
      items: [{ name: 'Karak Tea', qty: 2, price_aed: 5, modifiers: [{name:'sugar',value:'less'}] }],
      total_aed: 10,
      createdAt: new Date('2026-05-31T10:00:00Z'),
    })
    expect(out).toContain('Test Café')
    expect(out).toContain('T5')
    expect(out).toContain('2 x Karak Tea')
    expect(out).toContain('AED 10.00')
  })
})
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm test tests/unit/printing/escpos.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement formatter**

`lib/printing/escpos.ts`:

```ts
const ESC = '\x1b', GS = '\x1d'
const ALIGN_CENTER = `${ESC}a1`, ALIGN_LEFT = `${ESC}a0`
const BOLD_ON = `${ESC}E1`, BOLD_OFF = `${ESC}E0`
const SIZE_DOUBLE = `${GS}!\x11`, SIZE_NORMAL = `${GS}!\x00`
const CUT = `${GS}V0`

export type TicketInput = {
  tenantName: string
  orderId: string
  tableLabel?: string | null
  items: { name: string; qty: number; price_aed: number; modifiers: { name: string; value: string }[] }[]
  total_aed: number
  createdAt: Date
}

export function formatTicket(t: TicketInput): string {
  const lines: string[] = []
  lines.push(ALIGN_CENTER + BOLD_ON + SIZE_DOUBLE + t.tenantName + SIZE_NORMAL + BOLD_OFF)
  lines.push(t.createdAt.toISOString().slice(0,16).replace('T',' '))
  if (t.tableLabel) lines.push(BOLD_ON + 'Table ' + t.tableLabel + BOLD_OFF)
  lines.push('Order #' + t.orderId.slice(0, 6))
  lines.push(ALIGN_LEFT + '-'.repeat(32))
  for (const it of t.items) {
    lines.push(BOLD_ON + `${it.qty} x ${it.name}` + BOLD_OFF + '  ' + `AED ${(it.qty * it.price_aed).toFixed(2)}`)
    for (const m of it.modifiers) lines.push('  - ' + m.name + ': ' + m.value)
  }
  lines.push('-'.repeat(32))
  lines.push(ALIGN_CENTER + BOLD_ON + `TOTAL AED ${t.total_aed.toFixed(2)}` + BOLD_OFF)
  lines.push('\n\n\n')
  lines.push(CUT)
  return lines.join('\n')
}
```

- [ ] **Step 4: Pass**

Run: `pnpm test tests/unit/printing/escpos.test.ts`
Expected: PASS.

- [ ] **Step 5: PrintNode client**

`lib/printing/printnode.ts`:

```ts
const BASE = 'https://api.printnode.com'

export async function sendPrint(printerId: number, raw: string, title = 'SmartPOS ticket') {
  const auth = Buffer.from(process.env.PRINTNODE_API_KEY + ':').toString('base64')
  const res = await fetch(`${BASE}/printjobs`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      printerId,
      title,
      contentType: 'raw_base64',
      content: Buffer.from(raw).toString('base64'),
      source: 'SmartPOS.ai',
    }),
  })
  if (!res.ok) throw new Error(`PrintNode ${res.status}: ${await res.text()}`)
  return await res.json()
}
```

- [ ] **Step 6: Route**

`app/api/print/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { createServiceRole } from '@/lib/db/supabase'
import { formatTicket } from '@/lib/printing/escpos'
import { sendPrint } from '@/lib/printing/printnode'

const Body = z.object({ orderId: z.string().uuid() })

export async function POST(req: Request) {
  const s = await requireSession()
  const { orderId } = Body.parse(await req.json())
  const admin = createServiceRole()
  const { data: tenant } = await admin.from('tenants').select('name, printnode_printer_id').eq('id', s.tenantId).single()
  if (!tenant?.printnode_printer_id) return NextResponse.json({ error: 'No printer configured' }, { status: 400 })
  const { data: order } = await admin.from('orders').select('id, table_label, total_aed, created_at, order_items(name_snapshot, qty, unit_price_aed, modifiers_snapshot)').eq('id', orderId).eq('tenant_id', s.tenantId).single()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const raw = formatTicket({
    tenantName: tenant.name,
    orderId: order.id,
    tableLabel: order.table_label,
    items: (order.order_items as any[]).map(i => ({ name: i.name_snapshot, qty: i.qty, price_aed: Number(i.unit_price_aed), modifiers: i.modifiers_snapshot as any[] })),
    total_aed: Number(order.total_aed),
    createdAt: new Date(order.created_at),
  })
  const job = await sendPrint(tenant.printnode_printer_id, raw)
  return NextResponse.json({ jobId: job })
}
```

- [ ] **Step 7: Wire auto-print into parse-order route**

Edit `app/api/ai/parse-order/route.ts` to call `sendPrint` right after order persistence when `parsed.items.length > 0 && tenant.printnode_printer_id` is set. Reuse `formatTicket` from `lib/printing/escpos.ts`. Wrap in try/catch — print failures must not block order creation; log to Sentry and continue.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(print): ESC/POS formatter + PrintNode dispatch + auto-print on parsed order"
```

---

## Task 10: WhatsApp webhook + concierge

**Files:**
- Create: `lib/whatsapp/client.ts`, `lib/whatsapp/handler.ts`, `app/api/whatsapp/webhook/route.ts`, `tests/unit/whatsapp/handler.test.ts`

- [ ] **Step 1: Handler test**

`tests/unit/whatsapp/handler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleInbound } from '@/lib/whatsapp/handler'

vi.mock('@/lib/whatsapp/client', () => ({ sendText: vi.fn(async () => ({})) }))
vi.mock('@/lib/ai/parseOrder', () => ({ parseOrder: vi.fn(async () => ({ items: [{ menu_item_id: 'm1', qty: 1, modifiers: [] }], confidence: 0.93, clarification_needed: null, usage: { input_tokens: 5, output_tokens: 5 } })) }))
vi.mock('@/lib/db/queries', () => ({ getTenantMenu: async () => [{ id: 'm1', name: 'Karak', aliases: [], price_aed: 5 }] }))
const inserts: any[] = []
vi.mock('@/lib/db/supabase', () => ({
  createServiceRole: () => ({
    from: (table: string) => ({
      insert: (row: any) => { inserts.push({ table, row }); return { select: () => ({ single: async () => ({ data: { id: 'x' } }) }) } },
      upsert: (row: any) => { inserts.push({ table, row, op: 'upsert' }); return { select: () => ({ single: async () => ({ data: { id: 'c1' } }) }) } },
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: 't1', name: 'Café', whatsapp_phone_number_id: 'p1', whatsapp_access_token: 'tok' } }) }) }),
    }),
  }),
}))

describe('handleInbound', () => {
  it('creates conversation, message, and order from a text message', async () => {
    await handleInbound({
      tenantId: 't1',
      from: '971501234567',
      text: 'one karak please',
      profileName: 'Ahmed',
    })
    expect(inserts.some(i => i.table === 'conversations')).toBe(true)
    expect(inserts.some(i => i.table === 'messages')).toBe(true)
    expect(inserts.some(i => i.table === 'orders')).toBe(true)
  })
})
```

Run: `pnpm test tests/unit/whatsapp/handler.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement client**

`lib/whatsapp/client.ts`:

```ts
export async function sendText(args: { phoneNumberId: string; accessToken: string; to: string; body: string }) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${args.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: args.to, type: 'text', text: { body: args.body } }),
  })
  if (!res.ok) throw new Error(`WA ${res.status}: ${await res.text()}`)
  return res.json()
}
```

- [ ] **Step 3: Implement handler**

`lib/whatsapp/handler.ts`:

```ts
import { createServiceRole } from '@/lib/db/supabase'
import { getTenantMenu } from '@/lib/db/queries'
import { parseOrder } from '@/lib/ai/parseOrder'
import { sendText } from './client'

export async function handleInbound(input: { tenantId: string; from: string; text: string; profileName?: string }) {
  const admin = createServiceRole()
  const { data: tenant } = await admin.from('tenants').select('id, name, whatsapp_phone_number_id, whatsapp_access_token').eq('id', input.tenantId).single()
  if (!tenant?.whatsapp_phone_number_id || !tenant.whatsapp_access_token) return

  const { data: conv } = await admin.from('conversations').upsert({
    tenant_id: input.tenantId,
    channel: 'whatsapp',
    external_id: input.from,
    customer_name: input.profileName ?? null,
  }, { onConflict: 'tenant_id,channel,external_id' }).select('id, ai_active').single()

  await admin.from('messages').insert({
    conversation_id: conv!.id,
    direction: 'inbound',
    author: 'customer',
    body: input.text,
  })

  if (!conv!.ai_active) return  // owner has taken over

  const menu = await getTenantMenu(input.tenantId)
  const parsed = await parseOrder({ text: input.text, menu, locale: 'auto' })

  let replyBody: string
  if (parsed.clarification_needed) {
    replyBody = parsed.clarification_needed
  } else if (parsed.items.length > 0) {
    const subtotal = parsed.items.reduce((s, it) => {
      const m = menu.find(x => x.id === it.menu_item_id)
      return s + (m ? m.price_aed * it.qty : 0)
    }, 0)
    const { data: order } = await admin.from('orders').insert({
      tenant_id: input.tenantId,
      channel: 'whatsapp',
      status: 'new',
      customer_name: input.profileName ?? null,
      customer_phone: input.from,
      raw_input: input.text,
      parse_confidence: parsed.confidence,
      subtotal_aed: subtotal,
      total_aed: subtotal,
    }).select('id').single()
    await admin.from('order_items').insert(parsed.items.map(it => {
      const m = menu.find(x => x.id === it.menu_item_id)!
      return { order_id: order!.id, menu_item_id: m.id, name_snapshot: m.name, qty: it.qty, unit_price_aed: m.price_aed, modifiers_snapshot: it.modifiers ?? [] }
    }))
    replyBody = `Order received: ${parsed.items.map(it => {
      const m = menu.find(x => x.id === it.menu_item_id)!
      return `${it.qty}× ${m.name}`
    }).join(', ')}. Total AED ${subtotal.toFixed(2)}. We'll confirm shortly.`
  } else {
    replyBody = 'Hi! Send the items you would like to order, or ask any menu question.'
  }

  await admin.from('messages').insert({
    conversation_id: conv!.id,
    direction: 'outbound',
    author: 'ai',
    body: replyBody,
  })

  await sendText({
    phoneNumberId: tenant.whatsapp_phone_number_id,
    accessToken: tenant.whatsapp_access_token,
    to: input.from,
    body: replyBody,
  })
}
```

- [ ] **Step 4: Confirm tests pass**

Run: `pnpm test tests/unit/whatsapp/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Webhook route**

`app/api/whatsapp/webhook/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createServiceRole } from '@/lib/db/supabase'
import { handleInbound } from '@/lib/whatsapp/handler'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge ?? '', { status: 200 })
  }
  return new Response('forbidden', { status: 403 })
}

export async function POST(req: Request) {
  const payload = await req.json()
  const entry = payload.entry?.[0]
  const change = entry?.changes?.[0]
  const value = change?.value
  const phoneNumberId = value?.metadata?.phone_number_id
  const msg = value?.messages?.[0]
  if (!msg || !phoneNumberId) return NextResponse.json({ ok: true })

  const admin = createServiceRole()
  const { data: tenant } = await admin.from('tenants').select('id').eq('whatsapp_phone_number_id', phoneNumberId).single()
  if (!tenant) return NextResponse.json({ ok: true })

  const text = msg.text?.body ?? msg.button?.text ?? ''
  if (!text) return NextResponse.json({ ok: true })

  await handleInbound({
    tenantId: tenant.id,
    from: msg.from,
    text,
    profileName: value.contacts?.[0]?.profile?.name,
  })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(whatsapp): inbound webhook + AI concierge replies"
```

---

## Task 11: AI Menu Import (PDF / photo → structured menu)

**Files:**
- Create: `lib/ai/importMenu.ts`, `app/api/ai/import-menu/route.ts`, `tests/unit/ai/importMenu.test.ts`

- [ ] **Step 1: Importer test**

`tests/unit/ai/importMenu.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { importMenuFromImage } from '@/lib/ai/importMenu'

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn(async () => ({
        content: [{
          type: 'tool_use',
          name: 'submit_menu',
          input: {
            categories: [
              { name: 'Drinks', items: [{ name: 'Karak Tea', price_aed: 5, aliases: ['karak','chai'] }] },
              { name: 'Mains', items: [{ name: 'Chicken Biryani', price_aed: 25, aliases: ['biryani'] }] },
            ],
          },
        }],
        usage: { input_tokens: 1500, output_tokens: 300 },
      })),
    }
  },
}))

describe('importMenuFromImage', () => {
  it('returns categories with items and prices', async () => {
    const out = await importMenuFromImage('data:image/png;base64,AAAA')
    expect(out.categories[0].items[0].name).toBe('Karak Tea')
    expect(out.categories[0].items[0].price_aed).toBe(5)
  })
})
```

Run: `pnpm test tests/unit/ai/importMenu.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement importer**

`lib/ai/importMenu.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type ImportedMenu = {
  categories: { name: string; items: { name: string; price_aed: number; aliases: string[]; description?: string }[] }[]
  usage: { input_tokens: number; output_tokens: number }
}

export async function importMenuFromImage(dataUrl: string): Promise<ImportedMenu> {
  const [meta, b64] = dataUrl.split(',')
  const mediaType = (meta.match(/data:([^;]+)/)?.[1] ?? 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: 'You extract menus from photos or PDFs of UAE restaurant menus. Prices are in AED. Generate at least one alias per item (a common short name). Skip section headers, addresses, opening hours. Never invent items.',
    tools: [{
      name: 'submit_menu',
      description: 'Submit the extracted menu',
      input_schema: {
        type: 'object',
        required: ['categories'],
        properties: {
          categories: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'items'],
              properties: {
                name: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'price_aed'],
                    properties: {
                      name: { type: 'string' },
                      price_aed: { type: 'number' },
                      aliases: { type: 'array', items: { type: 'string' }, default: [] },
                      description: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }],
    tool_choice: { type: 'tool', name: 'submit_menu' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: 'Extract the menu.' },
      ],
    }],
  })
  const block = resp.content.find(b => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error('Model did not return menu')
  const input = block.input as { categories: ImportedMenu['categories'] }
  return { categories: input.categories, usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens } }
}
```

Run: `pnpm test tests/unit/ai/importMenu.test.ts`
Expected: PASS.

- [ ] **Step 3: Route**

`app/api/ai/import-menu/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { importMenuFromImage } from '@/lib/ai/importMenu'
import { createServiceRole } from '@/lib/db/supabase'

const Body = z.object({ imageDataUrl: z.string() })

export async function POST(req: Request) {
  const s = await requireSession()
  const { imageDataUrl } = Body.parse(await req.json())
  const imported = await importMenuFromImage(imageDataUrl)

  const admin = createServiceRole()
  for (const [ci, cat] of imported.categories.entries()) {
    const { data: cat_row } = await admin.from('menu_categories').insert({ tenant_id: s.tenantId, name: cat.name, sort_order: ci }).select('id').single()
    if (!cat_row) continue
    if (cat.items.length === 0) continue
    await admin.from('menu_items').insert(cat.items.map(it => ({
      tenant_id: s.tenantId,
      category_id: cat_row.id,
      name: it.name,
      price_aed: it.price_aed,
      aliases: it.aliases ?? [],
      description: it.description ?? null,
    })))
  }
  await admin.from('ai_usage').insert({
    tenant_id: s.tenantId,
    kind: 'import_menu',
    model: 'claude-sonnet-4-6',
    input_tokens: imported.usage.input_tokens,
    output_tokens: imported.usage.output_tokens,
    cost_usd: imported.usage.input_tokens * 0.000003 + imported.usage.output_tokens * 0.000015,
  })
  return NextResponse.json({ categories: imported.categories.length })
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ai): menu import from image/PDF via Claude vision"
```

---

## Task 12: Onboarding wizard (4 steps)

**Files:**
- Create: `app/(app)/onboarding/page.tsx`, `components/onboarding/MenuImportStep.tsx`, `components/onboarding/WhatsAppLinkStep.tsx`, `components/onboarding/PrinterStep.tsx`, `components/onboarding/DoneStep.tsx`

- [ ] **Step 1: Wire the wizard**

`app/(app)/onboarding/page.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { MenuImportStep } from '@/components/onboarding/MenuImportStep'
import { WhatsAppLinkStep } from '@/components/onboarding/WhatsAppLinkStep'
import { PrinterStep } from '@/components/onboarding/PrinterStep'
import { DoneStep } from '@/components/onboarding/DoneStep'

const STEPS = ['Menu', 'WhatsApp', 'Printer', 'Done'] as const

export default function OnboardingPage() {
  const [step, setStep] = useState(0)
  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1))
  return (
    <main className="mx-auto max-w-2xl p-6">
      <ol className="mb-8 flex justify-between text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'font-semibold' : 'text-muted-foreground'}>{i+1}. {s}</li>
        ))}
      </ol>
      {step === 0 && <MenuImportStep onDone={next}/>}
      {step === 1 && <WhatsAppLinkStep onDone={next} onSkip={next}/>}
      {step === 2 && <PrinterStep onDone={next} onSkip={next}/>}
      {step === 3 && <DoneStep/>}
    </main>
  )
}
```

- [ ] **Step 2: MenuImportStep**

`components/onboarding/MenuImportStep.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function MenuImportStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      const reader = new FileReader()
      const dataUrl = await new Promise<string>((res, rej) => {
        reader.onload = () => res(reader.result as string)
        reader.onerror = () => rej(reader.error)
        reader.readAsDataURL(file)
      })
      const r = await fetch('/api/ai/import-menu', { method: 'POST', body: JSON.stringify({ imageDataUrl: dataUrl }) })
      if (!r.ok) throw new Error(await r.text())
      onDone()
    } finally { setBusy(false) }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Upload your menu</h2>
      <p className="text-muted-foreground">A photo or PDF works. The AI will read item names and prices.</p>
      <Input type="file" accept="image/*,application/pdf" onChange={upload} disabled={busy}/>
      {busy && <p>Reading your menu… this takes about 15 seconds.</p>}
      <Button variant="ghost" onClick={onDone}>I'll add items manually instead</Button>
    </section>
  )
}
```

- [ ] **Step 3: WhatsAppLinkStep**

`components/onboarding/WhatsAppLinkStep.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function WhatsAppLinkStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      await fetch('/api/tenant/whatsapp', { method: 'POST', body: JSON.stringify({ phoneNumberId, token }) })
      onDone()
    } finally { setBusy(false) }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Connect your WhatsApp</h2>
      <p className="text-muted-foreground">
        Follow the Meta Cloud API setup steps and paste your Phone Number ID + permanent access token below.
        We'll start replying to customers automatically. <a className="underline" href="/docs/whatsapp-setup" target="_blank">Setup guide</a>
      </p>
      <div><Label>Phone Number ID</Label><Input value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)}/></div>
      <div><Label>Permanent Access Token</Label><Input type="password" value={token} onChange={e => setToken(e.target.value)}/></div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || !phoneNumberId || !token}>Connect</Button>
        <Button variant="ghost" onClick={onSkip}>Skip for now</Button>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Add tenant settings route**

`app/api/tenant/whatsapp/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { createServiceRole } from '@/lib/db/supabase'

const Body = z.object({ phoneNumberId: z.string().min(3), token: z.string().min(10) })

export async function POST(req: Request) {
  const s = await requireSession()
  const { phoneNumberId, token } = Body.parse(await req.json())
  const admin = createServiceRole()
  await admin.from('tenants').update({
    whatsapp_phone_number_id: phoneNumberId,
    whatsapp_access_token: token,
  }).eq('id', s.tenantId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: PrinterStep**

`components/onboarding/PrinterStep.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function PrinterStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [printers, setPrinters] = useState<{ id: number; name: string }[]>([])
  const [picked, setPicked] = useState<string>('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { fetch('/api/tenant/printers').then(r => r.json()).then(d => setPrinters(d.printers ?? [])) }, [])
  async function save() {
    setBusy(true)
    try { await fetch('/api/tenant/printers', { method: 'POST', body: JSON.stringify({ printerId: Number(picked) }) }); onDone() }
    finally { setBusy(false) }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Pick your receipt printer</h2>
      <p className="text-muted-foreground">Install the PrintNode agent on the same computer as your printer, then refresh.</p>
      <Select value={picked} onValueChange={setPicked}>
        <SelectTrigger><SelectValue placeholder="Choose a printer"/></SelectTrigger>
        <SelectContent>{printers.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
      </Select>
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || !picked}>Use this printer</Button>
        <Button variant="ghost" onClick={onSkip}>Skip — I'll print later</Button>
      </div>
    </section>
  )
}
```

Add corresponding `app/api/tenant/printers/route.ts` that GETs from PrintNode and POSTs the chosen `printnode_printer_id` to `tenants`.

- [ ] **Step 6: DoneStep**

`components/onboarding/DoneStep.tsx`:

```tsx
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export function DoneStep() {
  return (
    <section className="space-y-4 text-center">
      <h2 className="text-3xl font-semibold">You're live.</h2>
      <p className="text-muted-foreground">Take a voice order to see your kitchen ticket print and your dashboard light up.</p>
      <div className="flex justify-center gap-2">
        <Button asChild><Link href="/order">Open Voice Order</Link></Button>
        <Button asChild variant="outline"><Link href="/dashboard">Open Dashboard</Link></Button>
      </div>
    </section>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(onboarding): 4-step wizard (menu import, WhatsApp, printer, done)"
```

---

## Task 13: Dashboard Q&A (SQL tool)

**Files:**
- Create: `lib/ai/dashboardQuery.ts`, `app/api/ai/dashboard-query/route.ts`, `tests/unit/ai/dashboardQuery.test.ts`, `supabase/migrations/20260531000300_dashboard_rpc.sql`

- [ ] **Step 1: Tenant-scoped SQL RPC**

`supabase/migrations/20260531000300_dashboard_rpc.sql`:

```sql
-- Whitelist of read-only views the AI can query
create or replace view v_orders_summary as
  select tenant_id, date_trunc('day', created_at) as day, count(*) as orders, sum(total_aed) as revenue
  from orders
  where status not in ('cancelled')
  group by 1, 2;

create or replace view v_top_items as
  select o.tenant_id, oi.name_snapshot as item, sum(oi.qty) as qty, sum(oi.qty * oi.unit_price_aed) as revenue,
         date_trunc('day', o.created_at) as day
  from orders o
  join order_items oi on oi.order_id = o.id
  where o.status not in ('cancelled')
  group by 1, 2, 5;

create or replace view v_recent_complaints as
  select c.tenant_id, m.body, m.created_at
  from messages m
  join conversations c on c.id = m.conversation_id
  where m.direction = 'inbound' and m.body ~* '\m(complaint|cold|late|wrong|refund|bad|terrible)\M'
  order by m.created_at desc;

alter view v_orders_summary set (security_invoker = on);
alter view v_top_items set (security_invoker = on);
alter view v_recent_complaints set (security_invoker = on);

create or replace function ai_query(sql text) returns jsonb
language plpgsql security invoker as $$
declare result jsonb;
begin
  if sql !~* '^\s*select\s' then raise exception 'Only SELECT statements allowed'; end if;
  if sql ~* '\b(insert|update|delete|drop|alter|create|grant|truncate)\b' then raise exception 'Mutations blocked'; end if;
  if sql !~* '\b(v_orders_summary|v_top_items|v_recent_complaints)\b' then raise exception 'Only views v_orders_summary / v_top_items / v_recent_complaints allowed'; end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s limit 200) t', sql) into result;
  return result;
end;
$$;
```

Apply: `supabase db push`.

- [ ] **Step 2: Test**

`tests/unit/ai/dashboardQuery.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { dashboardQuery } from '@/lib/ai/dashboardQuery'

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn()
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', name: 'run_query', input: { sql: "select sum(revenue) as r from v_orders_summary where day = current_date - interval '1 day'" } }],
          usage: { input_tokens: 100, output_tokens: 30 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Yesterday you made AED 1,240 across 47 orders.' }],
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
    }
  },
}))

vi.mock('@/lib/db/supabase', () => ({
  createServer: async () => ({
    rpc: async (fn: string, args: any) => ({ data: [{ r: 1240 }], error: null }),
  }),
}))

describe('dashboardQuery', () => {
  it('answers using the SQL tool', async () => {
    const out = await dashboardQuery('how did yesterday go?')
    expect(out.answer).toMatch(/1,240/)
  })
})
```

- [ ] **Step 3: Implement**

`lib/ai/dashboardQuery.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { DASHBOARD_QUERY_SYSTEM } from './prompts'
import { createServer } from '@/lib/db/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function dashboardQuery(question: string) {
  const sb = await createServer()
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }]
  let totalIn = 0, totalOut = 0
  for (let i = 0; i < 4; i++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: DASHBOARD_QUERY_SYSTEM + `\nAvailable read-only views: v_orders_summary(day, orders, revenue), v_top_items(item, qty, revenue, day), v_recent_complaints(body, created_at).`,
      tools: [{
        name: 'run_query',
        description: 'Execute a SELECT against the allowed views and return rows.',
        input_schema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } },
      }],
      messages,
    })
    totalIn += resp.usage.input_tokens; totalOut += resp.usage.output_tokens
    const toolBlock = resp.content.find(b => b.type === 'tool_use')
    const textBlock = resp.content.find(b => b.type === 'text') as { type: 'text', text: string } | undefined
    if (toolBlock && toolBlock.type === 'tool_use') {
      const { data, error } = await sb.rpc('ai_query', { sql: (toolBlock.input as any).sql })
      messages.push({ role: 'assistant', content: resp.content })
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: error ? `ERROR: ${error.message}` : JSON.stringify(data) }] })
      continue
    }
    if (textBlock) return { answer: textBlock.text, usage: { input_tokens: totalIn, output_tokens: totalOut } }
  }
  return { answer: "I couldn't answer that from your data.", usage: { input_tokens: totalIn, output_tokens: totalOut } }
}
```

Run: `pnpm test tests/unit/ai/dashboardQuery.test.ts`
Expected: PASS.

- [ ] **Step 4: Route**

`app/api/ai/dashboard-query/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth/session'
import { dashboardQuery } from '@/lib/ai/dashboardQuery'
import { createServiceRole } from '@/lib/db/supabase'

const Body = z.object({ question: z.string().min(1) })

export async function POST(req: Request) {
  const s = await requireSession()
  const { question } = Body.parse(await req.json())
  const result = await dashboardQuery(question)
  const admin = createServiceRole()
  await admin.from('ai_usage').insert({
    tenant_id: s.tenantId,
    kind: 'dashboard_query',
    model: 'claude-sonnet-4-6',
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cost_usd: result.usage.input_tokens * 0.000003 + result.usage.output_tokens * 0.000015,
  })
  return NextResponse.json({ answer: result.answer })
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ai): owner dashboard Q&A via constrained SQL tool"
```

---

## Task 14: Dashboard UI — summary cards + chat

**Files:**
- Create: `app/(app)/dashboard/page.tsx`, `components/dashboard/SummaryCards.tsx`, `components/dashboard/ChatPanel.tsx`, `app/(app)/dashboard/whatsapp/page.tsx`, `components/dashboard/WhatsAppInbox.tsx`

- [ ] **Step 1: SummaryCards (server component)**

`components/dashboard/SummaryCards.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createServer } from '@/lib/db/supabase'

export async function SummaryCards({ tenantId }: { tenantId: string }) {
  const sb = await createServer()
  const { data: today } = await sb.from('v_orders_summary').select('orders, revenue').eq('day', new Date().toISOString().slice(0,10)).maybeSingle()
  const { data: top } = await sb.from('v_top_items').select('item, qty').order('qty', { ascending: false }).limit(3)
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card><CardHeader><CardTitle>Today's orders</CardTitle></CardHeader><CardContent className="text-3xl font-semibold">{today?.orders ?? 0}</CardContent></Card>
      <Card><CardHeader><CardTitle>Today's revenue</CardTitle></CardHeader><CardContent className="text-3xl font-semibold">AED {Number(today?.revenue ?? 0).toFixed(2)}</CardContent></Card>
      <Card><CardHeader><CardTitle>Best sellers</CardTitle></CardHeader><CardContent>{(top ?? []).map(t => <div key={t.item}>{t.qty}× {t.item}</div>)}</CardContent></Card>
    </div>
  )
}
```

- [ ] **Step 2: ChatPanel**

`components/dashboard/ChatPanel.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ChatPanel() {
  const [messages, setMessages] = useState<{ role: 'user'|'ai'; text: string }[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  async function ask() {
    if (!q.trim()) return
    setMessages(m => [...m, { role: 'user', text: q }])
    setBusy(true); const question = q; setQ('')
    try {
      const r = await fetch('/api/ai/dashboard-query', { method: 'POST', body: JSON.stringify({ question }) })
      const json = await r.json()
      setMessages(m => [...m, { role: 'ai', text: json.answer }])
    } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-4 rounded-2xl border bg-gradient-to-br from-violet-50/50 to-cyan-50/50 p-6 dark:from-violet-950/30 dark:to-cyan-950/30">
      <h2 className="text-lg font-semibold">Ask anything about your restaurant</h2>
      <div className="flex flex-col gap-3 min-h-32 max-h-96 overflow-auto">
        {messages.length === 0 && (
          <div className="text-muted-foreground space-y-1 text-sm">
            <p>Try:</p>
            <p>• "How did yesterday compare to last Friday?"</p>
            <p>• "What sold the most this week?"</p>
            <p>• "Any complaints today?"</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'self-end rounded-2xl bg-violet-600 px-4 py-2 text-white' : 'self-start rounded-2xl bg-white px-4 py-2 shadow dark:bg-neutral-900'}>{m.text}</div>
        ))}
        {busy && <div className="text-muted-foreground self-start text-sm">Thinking…</div>}
      </div>
      <form onSubmit={e => { e.preventDefault(); ask() }} className="flex gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Type a question…" disabled={busy}/>
        <Button type="submit" disabled={busy || !q.trim()}>Ask</Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 3: Dashboard page**

`app/(app)/dashboard/page.tsx`:

```tsx
import { requireSession } from '@/lib/auth/session'
import { SummaryCards } from '@/components/dashboard/SummaryCards'
import { ChatPanel } from '@/components/dashboard/ChatPanel'

export default async function DashboardPage() {
  const s = await requireSession()
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <header><h1 className="text-3xl font-semibold tracking-tight">Hi 👋</h1></header>
      <SummaryCards tenantId={s.tenantId}/>
      <ChatPanel/>
    </main>
  )
}
```

- [ ] **Step 4: WhatsApp inbox**

`components/dashboard/WhatsAppInbox.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { createBrowser } from '@/lib/db/supabase'
import { Button } from '@/components/ui/button'

type Conv = { id: string; customer_name: string | null; external_id: string; ai_active: boolean; last: string }

export function WhatsAppInbox() {
  const [convs, setConvs] = useState<Conv[]>([])
  async function load() {
    const sb = createBrowser()
    const { data } = await sb
      .from('conversations')
      .select('id, customer_name, external_id, ai_active, messages(body, created_at)')
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(50)
    setConvs((data ?? []).map((c: any) => ({ id: c.id, customer_name: c.customer_name, external_id: c.external_id, ai_active: c.ai_active, last: c.messages.at(-1)?.body ?? '' })))
  }
  useEffect(() => { load() }, [])
  async function toggle(c: Conv) {
    const sb = createBrowser()
    await sb.from('conversations').update({ ai_active: !c.ai_active }).eq('id', c.id)
    load()
  }
  return (
    <div className="space-y-2">
      {convs.map(c => (
        <div key={c.id} className="flex items-center justify-between rounded-xl border p-3">
          <div>
            <div className="font-medium">{c.customer_name ?? c.external_id}</div>
            <div className="text-muted-foreground text-sm">{c.last}</div>
          </div>
          <Button variant={c.ai_active ? 'outline' : 'default'} onClick={() => toggle(c)}>{c.ai_active ? 'Take over' : 'Let AI handle'}</Button>
        </div>
      ))}
      {convs.length === 0 && <p className="text-muted-foreground text-center">No WhatsApp conversations yet.</p>}
    </div>
  )
}
```

`app/(app)/dashboard/whatsapp/page.tsx`:

```tsx
import { WhatsAppInbox } from '@/components/dashboard/WhatsAppInbox'

export default function WhatsAppPage() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">WhatsApp conversations</h1>
      <WhatsAppInbox/>
    </main>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(dashboard): summary cards + AI chat + WhatsApp inbox"
```

---

## Task 15: i18n + RTL boundary

**Files:**
- Create: `lib/i18n/config.ts`, `lib/i18n/messages/en.json`, `lib/i18n/messages/ar.json`, `components/shared/RtlBoundary.tsx`, update `app/layout.tsx`

- [ ] **Step 1: Configure next-intl**

`lib/i18n/config.ts`:

```ts
export const locales = ['en', 'ar'] as const
export type Locale = typeof locales[number]
export const defaultLocale: Locale = 'en'
export const rtlLocales = new Set<Locale>(['ar'])
```

- [ ] **Step 2: Add message catalogs**

`lib/i18n/messages/en.json`:

```json
{
  "order": { "title": "Voice Order", "tap_to_speak": "Tap and speak the order", "no_order": "No order yet. Tap the mic." },
  "dashboard": { "today_orders": "Today's orders", "today_revenue": "Today's revenue", "best_sellers": "Best sellers", "ask_anything": "Ask anything about your restaurant" }
}
```

`lib/i18n/messages/ar.json`:

```json
{
  "order": { "title": "طلب صوتي", "tap_to_speak": "اضغط وتحدث بالطلب", "no_order": "لا يوجد طلب بعد. اضغط على الميكروفون." },
  "dashboard": { "today_orders": "طلبات اليوم", "today_revenue": "إيرادات اليوم", "best_sellers": "الأكثر مبيعًا", "ask_anything": "اسأل أي شيء عن مطعمك" }
}
```

- [ ] **Step 3: RtlBoundary**

`components/shared/RtlBoundary.tsx`:

```tsx
'use client'
import { rtlLocales, type Locale } from '@/lib/i18n/config'

export function RtlBoundary({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <div dir={rtlLocales.has(locale) ? 'rtl' : 'ltr'}>{children}</div>
}
```

- [ ] **Step 4: Wire root layout**

Edit `app/layout.tsx`:

```tsx
import './globals.css'
import { Inter } from 'next/font/google'
import type { Metadata } from 'next'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })

export const metadata: Metadata = { title: 'SmartPOS.ai', description: 'AI POS for UAE restaurants' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>{children}</body>
    </html>
  )
}
```

Pages that need RTL (`/order` for Arabic locale) wrap with `<RtlBoundary locale={locale}>...</RtlBoundary>`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(i18n): EN + AR catalogs and RtlBoundary"
```

---

## Task 16: Billing (Stripe trial + subscription)

**Files:**
- Create: `lib/billing/stripe.ts`, `app/api/billing/checkout/route.ts`, `app/api/stripe/webhook/route.ts`, `app/(app)/dashboard/settings/billing/page.tsx`

- [ ] **Step 1: Stripe client**

`lib/billing/stripe.ts`:

```ts
import Stripe from 'stripe'
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })
export const PRICE_STARTER_AED_100 = process.env.STRIPE_PRICE_STARTER!
```

- [ ] **Step 2: Checkout session**

`app/api/billing/checkout/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth/session'
import { stripe, PRICE_STARTER_AED_100 } from '@/lib/billing/stripe'
import { createServiceRole } from '@/lib/db/supabase'

export async function POST() {
  const s = await requireSession()
  const admin = createServiceRole()
  const { data: t } = await admin.from('tenants').select('stripe_customer_id, name').eq('id', s.tenantId).single()
  let customerId = t?.stripe_customer_id
  if (!customerId) {
    const c = await stripe.customers.create({ name: t?.name ?? '', metadata: { tenant_id: s.tenantId } })
    customerId = c.id
    await admin.from('tenants').update({ stripe_customer_id: customerId }).eq('id', s.tenantId)
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: PRICE_STARTER_AED_100, quantity: 1 }],
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings/billing?ok=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings/billing`,
  })
  return NextResponse.json({ url: session.url })
}
```

- [ ] **Step 3: Webhook**

`app/api/stripe/webhook/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { stripe } from '@/lib/billing/stripe'
import { createServiceRole } from '@/lib/db/supabase'

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature')!
  const body = await req.text()
  const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  const admin = createServiceRole()
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object as any
    const customerId = sub.customer
    const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : 'past_due'
    await admin.from('tenants').update({ subscription_status: status }).eq('stripe_customer_id', customerId)
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as any
    await admin.from('tenants').update({ subscription_status: 'cancelled' }).eq('stripe_customer_id', sub.customer)
  }
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Billing page**

`app/(app)/dashboard/settings/billing/page.tsx`:

```tsx
'use client'
import { Button } from '@/components/ui/button'

export default function BillingPage() {
  async function go() {
    const r = await fetch('/api/billing/checkout', { method: 'POST' })
    const { url } = await r.json()
    location.href = url
  }
  return (
    <main className="mx-auto max-w-xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Subscription</h1>
      <p className="text-muted-foreground">Starter — 100 AED / month. 14-day free trial.</p>
      <Button onClick={go} size="lg">Subscribe — 100 AED / month</Button>
    </main>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(billing): Stripe checkout + webhook"
```

---

## Task 17: AI cost guardrail middleware

**Files:**
- Create: `lib/ai/budget.ts`, update each AI route to call `checkBudget()` before model calls

- [ ] **Step 1: Budget helper**

`lib/ai/budget.ts`:

```ts
import { createServiceRole } from '@/lib/db/supabase'

const MONTHLY_USD_CAP = 8  // ≈ 30 AED — keeps us at ~50% gross margin on 100 AED tier

export async function checkBudget(tenantId: string) {
  const admin = createServiceRole()
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0,0,0,0)
  const { data } = await admin.from('ai_usage').select('cost_usd').eq('tenant_id', tenantId).gte('created_at', since.toISOString())
  const spent = (data ?? []).reduce((s, r) => s + Number(r.cost_usd), 0)
  if (spent >= MONTHLY_USD_CAP) {
    const err = new Error('AI_BUDGET_EXCEEDED'); (err as any).status = 429; throw err
  }
}
```

- [ ] **Step 2: Insert `await checkBudget(session.tenantId)` at the top of each AI route handler** (`parse-order`, `dashboard-query`, `import-menu`, `whatsapp` handler).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(ai): per-tenant monthly AI budget cap"
```

---

## Task 18: Sentry + structured logging

**Files:**
- Create: `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `lib/logger.ts`

- [ ] **Step 1: Install + bootstrap Sentry**

Run:
```bash
pnpm dlx @sentry/wizard@latest -i nextjs
```

Accept defaults; replace DSN with placeholder, set via env. Commit the generated files.

- [ ] **Step 2: Logger helper**

`lib/logger.ts`:

```ts
import * as Sentry from '@sentry/nextjs'

export const log = {
  info: (msg: string, ctx?: any) => console.log('[info]', msg, ctx ?? ''),
  warn: (msg: string, ctx?: any) => { console.warn('[warn]', msg, ctx); Sentry.captureMessage(msg, { level: 'warning', extra: ctx }) },
  error: (e: unknown, ctx?: any) => { console.error('[err]', e, ctx); Sentry.captureException(e, { extra: ctx }) },
}
```

Replace bare `console.error` calls in API routes with `log.error`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(observability): Sentry + structured logger"
```

---

## Task 19: Playwright smoke E2E

**Files:**
- Create: `tests/e2e/onboarding.spec.ts`, `tests/e2e/order-flow.spec.ts`

- [ ] **Step 1: Configure Playwright**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  use: { baseURL: 'http://localhost:3000', headless: true },
  webServer: { command: 'pnpm dev', url: 'http://localhost:3000', reuseExistingServer: true },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
})
```

- [ ] **Step 2: Onboarding spec**

```ts
import { test, expect } from '@playwright/test'

test('signup redirects to onboarding then dashboard', async ({ page }) => {
  const email = `e2e+${Date.now()}@smartpos.test`
  await page.goto('/signup')
  await page.fill('input[name=fullName]', 'E2E')
  await page.fill('input[name=restaurantName]', 'E2E Café')
  await page.fill('input[name=email]', email)
  await page.fill('input[name=password]', 'password123')
  await page.click('button[type=submit]')
  await expect(page).toHaveURL(/\/onboarding/)
  await page.click('text=/I\\\'ll add items manually/')
  await page.click('text=Skip for now')
  await page.click('text=/Skip — I\\\'ll print later/')
  await expect(page.getByText("You're live")).toBeVisible()
})
```

- [ ] **Step 3: Order flow spec (uses text endpoint, not mic)**

```ts
import { test, expect } from '@playwright/test'

test('text-input parse produces a KDS ticket', async ({ page, request }) => {
  // assumes a seeded tenant + cookie session; CI seeds via API in setup
  const res = await request.post('/api/ai/parse-order', { data: { kind: 'text', text: 'two karak less sugar', locale: 'en' } })
  expect(res.ok()).toBeTruthy()
  await page.goto('/kds')
  await expect(page.getByText('Karak')).toBeVisible({ timeout: 5000 })
})
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(e2e): onboarding + order flow smoke tests"
```

---

## Task 20: UI polish pass

**Files:**
- Modify: `app/globals.css`, `tailwind.config.ts`, `components/dashboard/ChatPanel.tsx`, `app/(app)/layout.tsx`, `app/(marketing)/page.tsx`

- [ ] **Step 1: Theme tokens**

Append to `app/globals.css`:

```css
@layer base {
  :root {
    --brand: 262 83% 58%;     /* violet-600 */
    --brand-2: 192 91% 36%;   /* cyan-700 */
    --surface: 0 0% 100%;
    --surface-2: 250 100% 99%;
  }
  .dark {
    --surface: 240 10% 4%;
    --surface-2: 250 10% 7%;
  }
  body {
    background:
      radial-gradient(80% 60% at 50% -10%, hsl(var(--brand)/.10), transparent 60%),
      radial-gradient(60% 50% at 100% 0%, hsl(var(--brand-2)/.08), transparent 60%),
      hsl(var(--surface));
  }
}
```

- [ ] **Step 2: App shell layout**

`app/(app)/layout.tsx`:

```tsx
import Link from 'next/link'
import { requireSession } from '@/lib/auth/session'
import { logout } from '@/app/(auth)/actions'
import { Mic, MonitorSpeaker, MessageSquare, LayoutDashboard, Settings } from 'lucide-react'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession()
  return (
    <div className="grid min-h-screen grid-cols-[14rem_1fr]">
      <aside className="border-r bg-white/60 p-4 backdrop-blur dark:bg-neutral-950/60">
        <Link href="/dashboard" className="mb-8 block text-xl font-semibold tracking-tight">SmartPOS<span className="text-violet-600">.ai</span></Link>
        <nav className="flex flex-col gap-1 text-sm">
          <Link href="/dashboard" className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"><LayoutDashboard className="h-4 w-4"/>Dashboard</Link>
          <Link href="/order" className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"><Mic className="h-4 w-4"/>Voice Order</Link>
          <Link href="/kds" className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"><MonitorSpeaker className="h-4 w-4"/>Kitchen</Link>
          <Link href="/dashboard/whatsapp" className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"><MessageSquare className="h-4 w-4"/>WhatsApp</Link>
          <Link href="/dashboard/settings" className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"><Settings className="h-4 w-4"/>Settings</Link>
        </nav>
        <form action={logout} className="absolute bottom-4"><button className="text-muted-foreground text-xs">Sign out</button></form>
      </aside>
      <div>{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: Marketing page**

`app/(marketing)/page.tsx`:

```tsx
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-16 px-6 py-12">
      <header className="flex items-center justify-between">
        <span className="text-xl font-semibold tracking-tight">SmartPOS<span className="text-violet-600">.ai</span></span>
        <nav className="flex gap-4 text-sm">
          <Link href="/login">Sign in</Link>
          <Button asChild><Link href="/signup">Start free trial</Link></Button>
        </nav>
      </header>
      <section className="space-y-6 text-center">
        <h1 className="text-5xl font-semibold tracking-tight md:text-6xl">The AI POS for UAE restaurants.</h1>
        <p className="text-muted-foreground mx-auto max-w-2xl text-lg">Voice orders in five languages. WhatsApp concierge. An owner dashboard you can talk to. 100 AED / month.</p>
        <Button asChild size="lg" className="rounded-full"><Link href="/signup">Start 14-day free trial →</Link></Button>
      </section>
      <section className="grid gap-4 md:grid-cols-3">
        <Feature title="Voice orders" body="Tap, speak in any language, ticket prints in the kitchen."/>
        <Feature title="WhatsApp concierge" body="Customers chat your restaurant's WhatsApp; AI handles 80%."/>
        <Feature title="Ask your dashboard" body='"How did Friday go?" — natural-language answers from your data.'/>
      </section>
    </main>
  )
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border bg-white/60 p-6 backdrop-blur dark:bg-neutral-950/60">
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      <p className="text-muted-foreground text-sm">{body}</p>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ui): brand gradient, app shell, marketing landing"
```

---

## Task 21: Deployment to Vercel

**Files:**
- Create: `vercel.json` (optional), `.github/workflows/ci.yml`

- [ ] **Step 1: Vercel project**

```bash
pnpm dlx vercel link
pnpm dlx vercel env pull .env.local
```

Push all envs from `.env.example` into the Vercel dashboard (Production + Preview).

- [ ] **Step 2: CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 3: Deploy**

```bash
pnpm dlx vercel --prod
```

Verify production URL serves the landing page. Configure DNS for `smartpos.ai` later.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(deploy): Vercel + GitHub CI"
```

---

## Task 22: Pilot tenant seed + onboarding doc

**Files:**
- Create: `supabase/migrations/20260531000200_seed_demo.sql`, `docs/whatsapp-setup.md`, `docs/printer-setup.md`

- [ ] **Step 1: Demo tenant seed (optional)**

`supabase/migrations/20260531000200_seed_demo.sql`:

```sql
-- Only seeds if the demo tenant doesn't exist.
do $$
declare demo uuid;
begin
  if not exists (select 1 from tenants where name = 'Demo Café') then
    insert into tenants (name, default_locale) values ('Demo Café', 'en') returning id into demo;
    insert into menu_categories (tenant_id, name, sort_order) values
      (demo, 'Drinks', 0), (demo, 'Mains', 1);
    insert into menu_items (tenant_id, category_id, name, aliases, price_aed)
    select demo, c.id, x.name, x.aliases, x.price
    from menu_categories c
    join (values
      ('Drinks', 'Karak Tea', ARRAY['karak','chai','tea']::text[], 5),
      ('Drinks', 'Mineral Water', ARRAY['water','moya']::text[], 2),
      ('Mains', 'Chicken Biryani', ARRAY['biryani']::text[], 25),
      ('Mains', 'Cheese Manakish', ARRAY['manakish','cheese manaeesh']::text[], 15)
    ) x(category, name, aliases, price) on c.name = x.category and c.tenant_id = demo;
  end if;
end$$;
```

- [ ] **Step 2: Onboarding docs**

Write `docs/whatsapp-setup.md` with screenshots of the Meta Cloud API console:
- Create a Meta Business app
- Add WhatsApp product
- Get phone-number ID + permanent access token
- Subscribe webhook to `https://<domain>/api/whatsapp/webhook` with the verify token

Write `docs/printer-setup.md`:
- Install PrintNode agent (Windows / macOS)
- Connect 80mm thermal printer
- Confirm printer name appears in dashboard onboarding step

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: WhatsApp + printer setup guides; demo tenant seed"
```

---

## Verification checklist (run before declaring Phase 1 done)

- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` — all unit tests green
- [ ] `pnpm test:e2e` — both Playwright specs green against a deployed preview
- [ ] Signup → onboarding → dashboard manual walkthrough on Vercel preview
- [ ] One real voice order in English placed via `/order` lands on `/kds` within 2 s and prints a ticket
- [ ] One real voice order in Arabic placed via `/order` produces a correctly-parsed cart (record 5-sample accuracy log)
- [ ] One WhatsApp message to the demo number is answered by the AI and creates an order
- [ ] One dashboard chat question is answered with a number that matches a hand-run SQL query against the views
- [ ] Stripe test checkout creates a subscription and webhook flips `subscription_status` to `active`
- [ ] Sentry receives a synthetic exception
- [ ] Mobile (≤390 px) layouts on `/order` and `/dashboard` don't horizontally scroll

When all of the above pass: the Phase 1 product is ready for the first paying-customer pilot.

---

## Out of scope (Phase 2+)

The following are explicitly **not** built in this plan and have their own future specs:
- Full POS substrate replacing the restaurant's existing POS (menu manager UI beyond import, table maps, modifiers UI, multi-user, shifts)
- VAT-compliant tax invoicing (UAE FTA rules)
- Aggregator sync (Talabat / Deliveroo / Careem via Deliverect)
- Payment terminal integration (Network International / Magnati / Geidea)
- Hardware bundle SKU (Sunmi tablet + printer + cash drawer)
- Demand forecasting & auto-prep
- AI menu engineering (margin flags, description rewrites)
- Camera + AI dine-in analytics
- Multi-outlet hierarchy & franchise reporting
- Native iOS / Android apps
