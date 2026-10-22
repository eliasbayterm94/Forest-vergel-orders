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
| `/forest/historial`  | forest, admin | Historial de pedidos: estado, cobertura y despacho en tabla |
| `/forest/costeo`     | forest, admin | Costo por kg seco, cierre mensual vs. mandato, factor real |
| `/forest/external`   | forest, admin | Rechazos / parciales → PO externo |
| `/forest/references` | forest, admin | Referencias y variedades |
| `/finca/dashboard`   | finca, admin  | Tablero El Vergel |
| `/finca/inbox`       | finca, admin  | Pedidos entrantes + capacidad |
| `/finca/recepciones` | finca, admin  | Materia prima que entra: proveedor, pesaje, precio, flotes, calidad |
| `/admin/config` → Proveedores | admin | Quién entrega, y la franquicia de flotes pactada con cada uno |
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

Random JWT signing secret (one-time), for the session cookie signature:

```bash
node scripts/generate-secret.js                        # → JWT_SECRET
```

Users and passwords live in the `users` table (migration `0048`), not in
env vars. After running the migrations, create the first admin from the
Supabase SQL Editor:

```sql
INSERT INTO users (username, full_name, password_hash, role)
VALUES ('elias', 'Elias Bayter',
        crypt('your-admin-password', gen_salt('bf', 12)), 'admin');
```

Every other user is created from `/admin/config` once you can log in.

> Until that first user exists, login falls back to the legacy per-role
> env vars (`FOREST/FINCA/ADMIN_PASSWORD_HASH`), using the role name as the
> username. That keeps the site reachable regardless of whether the
> migration or the deploy lands first. The fallback switches itself off as
> soon as one active user exists.

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
| `FOREST_PASSWORD_HASH` | legacy | bcrypt hash, rounds=12. Bootstrap only — see §3. Ignored once a user exists. |
| `FINCA_PASSWORD_HASH` | legacy | idem |
| `ADMIN_PASSWORD_HASH` | legacy | idem |
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

### Users and passwords

Day to day, from `/admin/config` → **Usuarios y accesos**: create a user,
reset someone's password, change their role, deactivate them. Changes take
effect on the next login — no redeploy.

**Locked out of every admin account?** The break-glass is the Supabase SQL
Editor:

```sql
UPDATE users
   SET password_hash = crypt('new-password', gen_salt('bf', 12))
 WHERE username = 'elias';
```

`pgcrypto`'s bcrypt output (`$2a$12$…`) is what `bcryptjs` verifies against
in `_lib/auth.js`, so the two are interchangeable.

Changing a password does **not** end sessions already open — the cookie
lasts 7 days. To force everyone out immediately, rotate `JWT_SECRET` in
Netlify and redeploy; that invalidates every signed cookie at once.

`users-update` refuses any change that would leave zero active admins, so
the UI can't lock you out of `/admin/config`.

### Change an order's quantity (add / remove kg)

Editing `kg_green_required` directly is only possible while the order is
`Pending`. Once the farm has accepted it, the quantity is a commitment between
two parties, so it moves through an amendment:

1. **Forest** opens the order's menu → **Ajustar kg**, enters `+200` or `-150`
   and (optionally) a reason. Nothing moves yet: the request is parked in
   `demand_orders.kg_green_pending_delta`.
2. **El Vergel** sees a banner on the order detail (and a `⇅` pill on the card,
   the queue and the history table) and accepts or rejects it.
3. On accept, `kg_green_required` and `kg_green_accepted` move **together** in a
   single update, so `chk_status_consistency` never breaks and the order's status
   is untouched. Production's target changes immediately.
4. On reject, the request is cleared and nothing changes.

Guard rails, all in `_lib/orderKgChange.js`:

- A reduction below the kg already dispatched is refused — that coffee has shipped.
- A reduction to zero or less is refused; cancelling an order is a different action.
- The amendment is re-validated at accept time, not just when requested: if kg
  shipped in between, the stale request is discarded with an explanation.
- `demand-orders-update` refuses a kg change on a non-`Pending` order
  (`KG_CHANGE_NEEDS_REQUEST`) so the old back door stays shut.

### Lot costing

Day to day there are three touch points:

| Who | Where | How often |
|---|---|---|
| Ops (admin) | `/admin/config` → **Tarifas de costeo** | Once a quarter |
| Farm | `/finca/recepciones` | As coffee arrives |
| Farm | Create batch → *¿De dónde sale la materia?* | One extra field |
| Ops (admin) | `/forest/costeo` → monthly close | Once a month |

The farm never types money: it records kg and the invoice price, and the cost is derived.

**The formula** (`_lib/lotCosting.js`, pure and tested):

```
cost per kg of NET input = purchase price | T2 (own) | 0 (by-product)
                         + T1  (flat, any entry stage)
total cost      = Σ kg × (entry cost + T1)        ← frozen at dry exit
cost per kg dry = total cost ÷ kg dried out
```

**Cost pools.** Material nobody can trace lot-by-lot (regional cherry) joins a pool under a
`pool_key` and is drawn at a perpetual weighted average. Consume the pool fully and the total
charged equals the total paid exactly. A reception keyed in late only moves the average forward —
it never re-costs a draw that already happened. A draw against an empty pool is NOT blocked: it is
charged at the last known average and the pool shows the shortfall, because blocking a batch over
an un-keyed invoice is how people stop using the system.

**The weighing chain.** "Net" means two different things, so the reception records all of it:

```
kg_scale_gross                      5092.00   what the scale read
− sacks_count × tare_per_sack_kg  −   32.90   94 sacks × 0.35
= kg_gross                          5059.10   actual coffee  <-- the payment rides on this
− byproduct (floaters)            −  495.79
= cost-bearing net                  4563.31   what carries the cost
```

`kg_gross` is the weight of coffee, and `amount_paid_cop = kg_gross × price × (1 − discount)`.
The screen computes it from the scale reading and the sack count, and the database rejects a chain
that does not add up, because digitising the scale reading as the coffee weight spreads the cost
over the sacks and understates cost per kg with nothing failing. The tare rate is stored per
reception, so changing the standard sack weight later never rewrites a past delivery. Receptions
entered without the weighing detail still work — `kg_gross` is then typed directly.

**Floaters.** Recorded per reception as weighed or estimated — floaters sent straight to the
re-pulper can only be estimated, and reports keep the two apart. The break-even discount equals the
floater rate exactly: discount the same percentage that floated and cost per net kg is unchanged.
Floaters are typed in kg or as a percentage — the lab reports "9.8%", the scale reports kg — and
kg is what gets stored, because kg is the quantity the by-product lot inherits.

`/finca/recepciones` shows that comparison per delivery, in pesos as well as points, which turns
"% floaters" into a negotiating number.

**The floater franchise** (`suppliers.floater_franchise_pct`, set in `/admin/config` → Proveedores)
is the negotiated term where only floaters above a threshold get discounted. The reception then
suggests `discount = max(0, floater_rate − franchise)` instead of someone subtracting in their head
at the scale, and names what the franchise costs:

```
shortfall = floater_rate − discount = min(floater_rate, franchise)
cost      = kg_gross × price × shortfall
```

Whenever floaters exceed the franchise that is exactly the franchise's own percentage of the
delivery's gross value — 986,517 COP on a 5,059 kg delivery at 3,900 with a 5% franchise. It is not
an accident of a bad lot. The franchise is a negotiation aid only: **it never enters a cost.** What
a reception costs is still, and only, what was paid over the net kg.

**Before the first lot can be costed**, a tariff version must exist in `/admin/config`. Until then
batches close normally and the response says `no_tariff`.

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
- **Production works against `kg_green_accepted`, never `kg_green_required`.** The required figure is what Forest
  asked for; the accepted figure is the farm's commitment, and it is what `orderCompletion` and the queue measure
  against. Changing one without the other silently desynchronises the two sides — which is why quantity changes
  go through the amendment flow below instead of a plain edit.
- **RLS deny-all to anon.** Only the service_role key (server) reads or writes.
- **All emails go through `email_log`** before Gmail API is called — full audit even in dry-run.
- **A lot's cost freezes at its dry exit and never moves.** `lot_cost_snapshots` is immutable by
  trigger (only the void columns may change, DELETE is refused) and copies the tariff rates in, so
  neither a tariff revision nor a later dried-weight correction can reach it. A corrected weight
  lands in the monthly mandate difference instead.
- **T1 is charged FLAT on net kg entering, whatever the entry stage.** A kg entering already dry
  yields ~5.7x more finished coffee than a kg of cherry, so a flat charge self-dilutes per kg of
  finished product — and, decisively, it makes the monthly close independent of the entry-stage mix:
  only total volume moves it. The budget denominator must be stated the same way.
- **NET, never gross.** Separated by-product (floaters) carries zero cost; the usable coffee absorbs
  the whole amount paid. Its processing is already inside T1 because the budget denominator excludes it.
- **Blends inherit cost, they are never re-costed.** Applying T1 again would double-count the month.
- **Costing never breaks the operation.** Closing a batch, undoing a stage or splitting a lot
  succeeds whether or not tariffs exist, the material source was recorded, or the migrations are
  applied; the response says why it was not costed.

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
