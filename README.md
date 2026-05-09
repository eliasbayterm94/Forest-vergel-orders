# Forest Production Bridge

Internal coordination system between Forest's commercial team and the El Vergel
estate. Forest enters demand for specialty coffee references; El Vergel accepts
(full or partial), produces lots, and delivers. Both sides see live status with
minimal email noise.

## Stack

- **Frontend**: vanilla JS PWA, ES modules, Tailwind via CDN. No build step.
- **Backend**: Netlify Functions (Node 20, classic CommonJS).
- **Database**: Supabase Postgres. RLS deny-all to anon — server uses service_role.
- **Auth**: shared password per role (forest / finca / admin), bcrypt-hashed in
  env vars, HMAC-signed HttpOnly cookie session.
- **Email**: Gmail API via OAuth refresh token, audit log, dry-run gate.
- **Schedule**: Netlify Scheduled Function for the Sunday-night digest.

## Routes

| URL | Roles | Purpose |
|---|---|---|
| `/login`             | any   | Login |
| `/forest/dashboard`  | forest, admin | Tablero Forest |
| `/forest/demand`     | forest, admin | Nuevo pedido (con regla de 15 días) |
| `/forest/external`   | forest, admin | Rechazos / parciales → PO externo |
| `/forest/references` | forest, admin | Referencias y variedades |
| `/finca/dashboard`   | finca, admin  | Tablero El Vergel |
| `/finca/inbox`       | finca, admin  | Pedidos entrantes + capacidad |
| `/finca/lots`        | finca, admin  | Lotes y asignaciones |

## Project layout

```
supabase/migrations/    SQL migrations (apply in numeric order)
supabase/seed.sql       Variety seed data
netlify/functions/      API handlers (one .js per route under /api/*)
netlify/functions/_lib/ Shared utilities (auth, supabase client, capacity, …)
public/                 Static PWA (index.html + js/)
public/js/views/        One file per view (Spanish UI labels)
tests/                  node:test — pure-utility tests (45 passing)
scripts/                Setup helpers (password hashing, JWT secret)
netlify.toml            Build, redirects, security headers
.env.example            Env-var contract
```

## Local development

```bash
npm install     # all runtime + tooling deps live in the root package.json
npm test        # 45 unit tests
```

For full local stack with Functions, install Netlify CLI and run `netlify dev`.

## Deployment

### 1. Supabase

1. Create a new Supabase project (separate from other Forest projects — blast-radius isolation).
2. SQL Editor → run, in order:
   - `supabase/migrations/0001_master_data.sql`
   - `supabase/migrations/0002_demand_orders.sql`
   - `supabase/migrations/0003_production_lots.sql`
   - `supabase/migrations/0004_email_log.sql`
   - `supabase/migrations/0005_rls.sql`
   - `supabase/migrations/0006_dried_yield.sql`
   - `supabase/seed.sql`
3. Project Settings → API:
   - Copy **Project URL** → `SUPABASE_URL`
   - Copy **service_role** secret → `SUPABASE_SERVICE_ROLE_KEY` (NEVER expose to the browser)

### 2. Gmail OAuth

Reuse the existing Forest OAuth refresh token (Forest Bills / CTRM). Copy from that project:
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`

Set a sender identity:
- `GMAIL_FROM_ADDRESS` — e.g. `Forest Production Bridge <noreply@your-domain>`

### 3. Generate auth secrets

Password hashes (run for each role, then paste into Netlify env vars):

```bash
node scripts/hash-password.js "your-forest-password"   # → FOREST_PASSWORD_HASH
node scripts/hash-password.js "your-finca-password"    # → FINCA_PASSWORD_HASH
node scripts/hash-password.js "your-admin-password"    # → ADMIN_PASSWORD_HASH
```

Random JWT signing secret (one-time):

```bash
node scripts/generate-secret.js                        # → JWT_SECRET
```

### 4. Netlify

1. Connect the GitHub repo to a new Netlify site.
2. `netlify.toml` already declares the build settings (no build command, publish `public/`, functions `netlify/functions/`).
3. Site settings → Environment variables → set every value from the [Env vars](#env-vars) table.
4. Trigger deploy. The build log should show:
   - `Installed dependencies` for `netlify/functions/package.json`
   - `Scheduled function "weekly-digest" registered with cron 0 2 * * 1`
5. Visit the site, log in, smoke-test (see [First-time verification](#first-time-verification)).

## Env vars

All set in the Netlify dashboard.

| Name | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service_role key. Server only. |
| `JWT_SECRET` | yes | ≥32 chars random. `node scripts/generate-secret.js` |
| `FOREST_PASSWORD_HASH` | yes | bcrypt hash, rounds=12 |
| `FINCA_PASSWORD_HASH` | yes | bcrypt hash, rounds=12 |
| `ADMIN_PASSWORD_HASH` | yes | bcrypt hash, rounds=12 |
| `GMAIL_CLIENT_ID` | yes | Reuse from Forest Bills |
| `GMAIL_CLIENT_SECRET` | yes |  |
| `GMAIL_REFRESH_TOKEN` | yes |  |
| `GMAIL_FROM_ADDRESS` | optional | Defaults to `me`. Prefer explicit `Display Name <email>`. |
| `EMAIL_DRY_RUN` | yes | `true` (default) writes to `email_log` only; `false` actually sends. |
| `EMAIL_RECIPIENTS_DEMAND_CREATOR` | yes | comma-separated, ~2 emails |
| `EMAIL_RECIPIENTS_FARM` | yes | comma-separated, ~2 emails |
| `EMAIL_RECIPIENTS_ADMIN` | yes | comma-separated, ~2 emails |
| `NODE_ENV` | optional | `production` by default. Set `development` only for `netlify dev`. |

## First-time verification

1. **Login.** Visit the site. Log in as `admin`. The session cookie is set HttpOnly + SameSite=Lax + Secure (in prod) for 7 days.
2. **Create a demand.** As `forest`, create a test order with delivery date >15 days out. It should land in the dashboard as `Pendiente`. (If you choose <15 days, you'll see the override modal — confirm it.)
3. **Inbox + capacity preview.** As `finca`, open `/finca/inbox`. Tick the test order's checkbox; the capacity panel on the right (or below on mobile) should show `latest_drying_start_date`, totals, and a per-week bar chart.
4. **Accept it.** Click Aceptar → Total. Order flips to `Aceptado`. A row appears in `email_log` with `event_type='demand_accepted'`, `status='dry_run'`.
5. **Production.** Create a lot for the same reference and process; assign kg to the order; advance through Drying → Resting → Ready → Delivered. At Ready/Delivered, enter `kg_dried_output` — `kg_green_actual` auto-fills via the process divisor (Natural ÷3.40, Honey ÷1.50, Lavado ÷1.34).
6. **Auto-completion.** When the lot hits Delivered and total delivered allocations ≥ `kg_green_accepted`, the order flips to `Completado` and a `demand_completed` row appears in `email_log`.
7. **Digest.** As `admin`, click "Resumen ahora" in the top bar. A `weekly_digest` row appears in `email_log` with the rendered subject.
8. **Flip dry-run.** Set `EMAIL_DRY_RUN=false` in Netlify env vars (no redeploy needed — vars reload on next function invocation). Run "Resumen ahora" again. The email arrives at all 6 recipients.

## Operations

### Rotate a password

```bash
node scripts/hash-password.js "new-password"
```

Paste the new hash into the relevant `*_PASSWORD_HASH` env var. Existing
sessions remain valid until cookie expiry (7 days). To force-invalidate all
sessions, also rotate `JWT_SECRET` — that breaks every signed cookie immediately.

### Add / remove notification recipients

Edit `EMAIL_RECIPIENTS_DEMAND_CREATOR / FARM / ADMIN`. No redeploy needed.

### Adjust drying-day lead times or yield divisors

```sql
UPDATE process_lead_times SET drying_days = 10            WHERE process_type = 'Honey';
UPDATE process_lead_times SET dried_to_green_divisor = 1.45 WHERE process_type = 'Honey';
```

These are cached per function cold start. To force-refresh, redeploy.

### Audit emails

```sql
SELECT sent_at, event_type, status, subject, to_address, error_message
FROM email_log
ORDER BY sent_at DESC
LIMIT 100;
```

Status values: `sent` | `dry_run` | `failed`.

### Pause emails temporarily

Set `EMAIL_DRY_RUN=true`. The system keeps running and the audit trail keeps growing — only the actual Gmail send is suppressed.

## Troubleshooting

**Login returns 401.** Verify the password matches the bcrypt hash. Common pitfall: a trailing newline on the env var when copy-pasting the hash.

**Functions return "Supabase env vars missing".** `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is unset or misspelled.

**Scheduled digest didn't run on Sunday night.** Check the Netlify deploy log for `Scheduled function "weekly-digest" registered`. If absent, confirm `@netlify/functions` is in `netlify/functions/package.json` and `weekly-digest.js` wraps the handler with `schedule('0 2 * * 1', ...)`.

**Capacity numbers look stale after a config change.** Functions cache `process_lead_times` per cold start. Redeploy to clear.

**`FIFTEEN_DAY_RULE` 409 on demand creation.** Expected — confirm the modal in the demand form to override.

**Lot status won't advance.** The DB enforces strict transitions (InFermentation → Drying → Resting → Ready → Delivered). Skipping a step returns 409.

## Architecture invariants

- **Demand-side cherry conversion (× 7.65)** is a flat constant in `cherryConversion.js`. Used only for forecasting fresh-cherry needs.
- **Delivery-side yield (per process)** lives in `process_lead_times.dried_to_green_divisor` and `processYields.js`: Natural ÷3.40, Honey ÷1.50, Lavado ÷1.34.
- **Drying days** live in the same `process_lead_times` config table — no hardcoding.
- **All operational dates** computed in `America/Bogota` (no DST, stable year-round).
- **ISO 8601 weeks** (Monday-first).
- **Status state machines** enforced at the DB layer via triggers; mirrored in handler code for clean error messages.
- **`lot_order_assignments` trigger** blocks reference / process mismatches and over-allocation per order.
- **RLS deny-all to anon.** Only the service_role key (server) reads or writes.
- **All emails go through `email_log`** before Gmail API is called — full audit even in dry-run.

## Out of MVP scope (flagged for future)

- HubSpot CRM sync
- QuickBooks invoicing
- WhatsApp / Twilio alerts
- PWA install banner + offline cache
- Per-reference cherry-conversion factor (currently global × 7.65)
- Multi-finca support
- Lot-side over-allocation DB trigger (currently UI-only)
- Per-year reset on `order_code` sequence (currently global)
- Rename `process_lead_times` → `process_config` (it now holds yields too)
