# AGENTS.md

## Cursor Cloud specific instructions

SmartPOS.ai is a single Next.js 14 (App Router) application (package `smartpos-ai`). One
codebase serves the marketing site (`/`), auth (`/login`, `/signup`), and the auth-gated
PWAs: Voice Order Console (`/order`), Kitchen Display (`/kds`), Owner Dashboard
(`/dashboard`), and Onboarding (`/onboarding`), plus API routes under `/api/*`.

Standard scripts live in `package.json` (`dev`, `build`, `start`, `typecheck`, `test`,
`test:e2e`, `format`); CI is `.github/workflows/ci.yml` (`typecheck` -> `lint` -> `test`).
Use `pnpm` (Node 20+, pnpm 9+).

### Running the app

- `pnpm dev` serves everything on http://localhost:3000.
- Requires `.env.local` (copy from `.env.example`). The app boots without real keys, but
  the auth-gated PWAs redirect to `/login` until Supabase is configured (see below).

### Local Supabase (required for auth + any data-backed flow)

- Docker is NOT preinstalled/running in this image and is NOT part of the update script.
  Install Docker (see Cursor docker-in-docker guidance: `fuse-overlayfs` storage driver +
  `iptables-legacy`), start `dockerd`, then `sudo chmod 666 /var/run/docker.sock` so the
  `ubuntu` user can reach it.
- `supabase/config.toml` is committed, so just run `pnpm exec supabase start` (it applies
  `supabase/migrations/*` automatically; local email confirmations are disabled so signup
  auto-logs-in). Get credentials with `pnpm exec supabase status -o env` and put
  `API_URL` -> `NEXT_PUBLIC_SUPABASE_URL`, `ANON_KEY` -> `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SERVICE_ROLE_KEY` -> `SUPABASE_SERVICE_ROLE_KEY` into `.env.local`, then restart `pnpm dev`.
- Anthropic/OpenAI/WhatsApp/PrintNode/Stripe keys are optional; only their specific
  feature flows need them.

### Lint gotcha

- `pnpm lint` (`next lint`) does NOT recognize the flat config `eslint.config.mjs` under
  Next 14 and drops into an interactive "How would you like to configure ESLint?" prompt.
  Run ESLint directly instead: `ESLINT_USE_FLAT_CONFIG=true npx eslint app components lib`
  (scope to source dirs; otherwise it also scans generated `.next`).
- ESLint must stay on v8 — `eslint-config-next@14.2.35` bundles a react-hooks plugin that
  crashes on ESLint 9 (`context.getScope is not a function`).
- Source currently has pre-existing lint errors (mostly `@typescript-eslint/no-explicit-any`);
  these are not environment problems.
