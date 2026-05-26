# Dashboard — Architecture & Plan

An operator-only web UI for whatsarr, served from the bot process itself. Single pane for everything that today lives across `service.out.log`, the SQLite audit table, the Seerr UI, and WhatsApp.

This doc is the design contract for the dashboard. Implementation hasn't started.

## 0. Scope decision (re-stated)

- **Operator dashboard, not end-user dashboard.** The wedge against [WAMR](https://github.com/techieanant/wamr) / [Whatseerr](https://github.com/SuFxGIT/whatseerr) is that household members never need a web account — they just message. A user-facing UI would undercut that. The operator (you) needs the opposite: one pane for everything that's currently scattered.
- **Not a Seerr clone.** Don't rebuild discovery/library — Seerr already does that. The dashboard surfaces whatsarr-specific data: per-WA-number audit, retry-loop state, pending-notification drain, !feedback/!issue inbox, Baileys/Syncthing health, in-flight conversation state.
- **Same process, not a separate service.** The existing `node:http` webhook server already has the right shape (DI-friendly, `store` + closure over `currentSock`). Extend it; don't fork another process to babysit.

## 1. Where it fits in the current process

```
┌────────────────────────────── whatsarr (single Node process) ──────────────────────────────┐
│                                                                                            │
│  ┌─ Baileys socket ──────────────┐    ┌─ node:http server (port 5056) ──────────────────┐  │
│  │  messages.upsert →            │    │  POST /webhook        (Seerr → bot, MEDIA_AVAIL) │  │
│  │    extractText →              │    │  GET  /health         (existing liveness)        │  │
│  │      processMessage →         │    │  GET  /api/*          (NEW — JSON for dashboard) │  │
│  │        resolveSenderPnJid →   │    │  POST /api/*          (NEW — write actions)      │  │
│  │          handleMessage →      │    │  GET  /dashboard/*    (NEW — static HTML+JS+CSS) │  │
│  │            sendReply          │    │  *                    404                        │  │
│  └────────┬──────────────────────┘    └──────────────────┬──────────────────────────────┘  │
│           │ shares: currentSock, store, seerr, syncthing │                                 │
│           └────────────────────────────────┬─────────────┘                                 │
│                                            ▼                                               │
│                            data/whatsarr.sqlite (WAL, better-sqlite3)                      │
│                                                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why same server:** `src/webhook.ts` is plain `node:http` (no Express), wired with DI (`store`, `send` closure). Adding routes is ~50 lines of router extraction. One graceful-shutdown path, one bind address, one TLS story (none, for now). Separate ports would double the surface for no benefit.

**Why same process:** the dashboard needs `currentSock` (to trigger DMs from web actions like "send test message") and the same `seerr` client (avoid duplicate axios pools / retry state). A sidecar would need IPC; not worth it.

## 2. Data model — what we already have

Nothing new in SQLite for MVP. Every screen below is backed by data that exists today:

| Screen / widget | Source | Method / table |
|---|---|---|
| Overview header (uptime, validation) | `diagnostics.ts` | `runDiagnosis()` |
| 24h request counters | `store` | `countAuditSince`, `countAuditByStatusSince` |
| Pending-notification queue | `store` | `listPending`, `countPending` |
| Request timeline | `store` | `audit` table (full scan with filters) |
| Failed-request retry state | `store` | `audit` rows where `status='failed'`, plus `retry_attempts` + `last_retry_at` |
| Feedback / issue inbox | `store` | `feedback` table |
| Per-user request history | `store` | `getUserRequests(senderNumber, limit)` |
| Per-user quota today | `store` | `getQuota(senderNumber)` |
| Seerr pending approvals | `seerr` | `listPendingRequests(limit)` |
| Seerr request media-status enrichment | `seerr` | `getMediaInfo(mediaType, tmdbId)` |
| Syncthing folder cards | `syncthing` | `getCompletion`, `getFolderStatus`, `ping`, `isConfigured` |
| In-flight conversations (pickers/season) | `store` | `conversation_state` table |
| Baileys connection status | `index.ts` | `currentSock !== null` + last `connection.update` cached |
| Retry-loop config | `index.ts` constants | `RETRY_BACKOFF_MS`, `RETRY_MAX_ATTEMPTS`, `RETRY_INTERVAL_MS` |

**One new store method needed for MVP:**
- `listAudit(filters: { status?, senderNumber?, groupJid?, since?, until?, limit?, offset? }) → AuditRow[]` — generic filtered fetch. The existing `countAudit*` methods already prove the index is sufficient; this is just the row-returning sibling.

**One new SQL table for v1 (Tasks / Commands page):**
```sql
CREATE TABLE commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                       -- 'reconnect_wa' | 'vacuum_db' | 'send_test_dm' | 'drain_pending'
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | running | succeeded | failed
  started_at INTEGER, finished_at INTEGER,
  args_json TEXT,                           -- inputs (e.g. {to, text} for send_test_dm)
  result TEXT, error TEXT
);
```
Modeled on Sonarr's `IManageCommandQueue` but stripped to ~30 LOC. Gives the Tasks page a real backing store, makes operator-triggered ops auditable, and provides a clean place to drop future jobs (DB vacuum, snapshot Baileys session, etc.).

Everything else is composition over existing methods.

## 3. HTTP surface

All new routes mount on the existing server (`0.0.0.0:5056`). Bearer-token auth on `/api/*` and `/dashboard/*`; `/webhook` and `/health` unchanged.

### Read endpoints (MVP)

```
GET  /api/heartbeat                 → { connected, uptimeSec, pendingCount, retryCount }  (1s tier)
GET  /api/overview                  → runDiagnosis() + Baileys connection snapshot
GET  /api/audit?status=&user=&group=&since=&limit=&offset=
                                    → audit rows + total count
GET  /api/pending                   → listPending(50) + countPending()
GET  /api/feedback?kind=feedback|issue
                                    → feedback table rows (DESC ts, limit 100)
GET  /api/conversations             → active conversation_state rows (unexpired)
GET  /api/seerr/pending             → listPendingRequests(20)
GET  /api/seerr/media/:type/:tmdbId → getMediaInfo() — for the "enrich row" lookup
GET  /api/syncthing                 → { ping, folders: [{id, completion, folderStatus}] }
GET  /api/user/:number              → { quota, requests: getUserRequests(num, 50) }
GET  /api/tasks                     → recent commands rows (v1)  — shape borrowed from
                                       Overseerr's /api/v1/settings/jobs
```

### Write endpoints (MVP+1, behind a feature flag)

Borrowing Overseerr's subscriber/side-effect pattern: every write endpoint flips state in one line, then a single `onAuditChanged(auditId, kind)` function fans out (Seerr push, WA notification, audit update). Keeps route handlers trivial and centralises "what happens after the operator clicks Approve."

```
POST /api/seerr/request/:id/approve  → seerr.approveRequest + onAuditChanged(_, 'approved')
POST /api/seerr/request/:id/deny     → seerr.declineRequest + onAuditChanged(_, 'denied')
POST /api/seerr/request/:id/retry    → seerr.retryRequest    + onAuditChanged(_, 'retried')
POST /api/pending/:id/retry          → drain single row immediately
POST /api/pending/:id/delete         → store.deletePending
POST /api/commands                   → { name, args } enqueues into commands table; runner
                                        ticks the row through 'running' → 'succeeded'/'failed'.
                                        Covers shutdown, vacuum_db, reconnect_wa, send_test_dm.
```

All writes are idempotent or self-evidently destructive; no DELETE verb to keep router trivial. The `commands` resource swallows what would otherwise be a sprawl of one-off POST routes — same pattern as Sonarr's `POST /api/v3/command`, stripped down.

### Static

```
GET  /dashboard/                    → index.html (server-rendered shell)
GET  /dashboard/app.js              → tiny client (HTMX-ish polling, ~200 lines)
GET  /dashboard/app.css             → minimal CSS, dark mode by default
```

Embed the three files as string literals in a `src/dashboard/assets.ts` module to avoid file-IO at request time and to keep `npm start` self-contained (no pathing issues with NSSM cwd). They're small enough.

## 4. Auth posture

| Surface | Today | Dashboard plan |
|---|---|---|
| `POST /webhook` | empty `SEERR_WEBHOOK_SECRET`; header equality check only if set | Unchanged for MVP. Hardening (rate limit + IP allowlist) tracked separately in HANDOFF. |
| `GET /health` | open | open |
| `GET /api/*`, `POST /api/*`, `GET /dashboard/*` | — | `Authorization: Bearer <DASHBOARD_TOKEN>` required. Static `/dashboard/` accepts `?token=…` in URL to bootstrap the browser, then sets a session cookie scoped `HttpOnly; SameSite=Lax; Secure=false` (no TLS yet) for subsequent `/api/*` calls. **Bypass for loopback:** requests from `127.0.0.1`/`::1` skip the auth check, mirroring Sonarr's `AuthenticationRequiredType.DisabledForLocalAddresses` — lets the operator hit the dashboard from the bot host without the token in the URL. |

**Why bearer + cookie bootstrap:** simplest auth that's actually safe behind Tailscale. No login form, no password hashing, no session table. Bookmark `http://127.0.0.1:5056/dashboard/?token=…` once on the operator's laptop; cookie carries it after.

**Future-proofing without cost:** model the auth check as `req.user.hasPermission(MANAGE)` even though there's only one user (Overseerr's bitmask pattern). The `user` object today is a constant `{ isAdmin: true }`; if a "read-only viewer" role ever shows up, it slots in without rewriting routes.

**New env var:** `DASHBOARD_TOKEN` (optional). If empty, dashboard endpoints respond `503 disabled` — keeps the dashboard opt-in.

**Future hardening (not MVP):** Tailscale identity header passthrough so the cookie isn't even needed; full HTTPS via a reverse proxy; multi-user RBAC if more than one operator ever needs access.

## 5. Frontend stack

- **No build step.** Plain HTML + a single `app.js` + a single `app.css`. Vanilla JS, no React/Preact/Svelte. Tautulli ships this way today (`data/interfaces/default/` is hand-written HTML/JS/CSS served as-is by CherryPy) — there's Plex-ecosystem precedent for going this light at any scale.
- **Three polling tiers** (modeled on Tautulli's two-tier cadence):
  - **1s** — heartbeat. Single endpoint `/api/heartbeat` returns ~50 bytes: `{ connected, uptimeSec, pendingCount, retryCount }`. Drives the connection dot, uptime ticker, and the "queue is moving" pulse. Cheap.
  - **5s** — active panels (Overview, Requests, Pending, Conversations).
  - **30s** — static-ish panels (Feedback, Syncthing folder cards).
- **No SSE / no WebSocket.** Sonarr uses SignalR; Maintainerr uses `reconnecting-eventsource`. At hundreds of requests/month, polling at three tiers covers everything and ships in a fraction of the code.
- **Bootstrap JSON injected into `index.html`** (borrowed from Sonarr's `InitializeJsonController` pattern). The first GET returns:
  ```html
  <script>window.__WHATSARR__ = { apiBase: '/api', token: '<short-lived-from-cookie>', features: { writeActions: true } };</script>
  ```
  Saves an XHR per page load and gives a clean place to ship feature flags.
- **One page, multiple panels.** Tabs are anchor-routed (`#overview`, `#requests`, etc.); no history-API stack to reason about.
- **Dark by default.** System color-scheme preference respected; one CSS file, custom properties for theme tokens.

Reasonable target sizes: `index.html` ~180 lines (incl. bootstrap script), `app.js` ~300 lines, `app.css` ~140 lines. All embedded as TS string literals.

## 6. Pages / panels

```
┌────── #overview ───────────────────────────────────────────────────────────────┐
│ Uptime  •  Baileys: connected  •  Seerr: OK  •  DB: OK  •  Webhook: 0.0.0.0:5056│
│ Pending notifs: 0 drained / 0 stuck  •  24h: 12 total / 8 queued / 4 failed     │
│ Validation checks (table) — each runValidation() row, colored pass/fail        │
│ Recent error tail (15 lines, scrollable, monospace)                            │
└────────────────────────────────────────────────────────────────────────────────┘

┌────── #requests ───────────────────────────────────────────────────────────────┐
│ Filter: [status ▼] [user ▼] [group ▼] [last 24h ▼]                             │
│ ┌───────────────────────────────────────────────────────────────────────────┐  │
│ │ ts        │ user             │ command         │ route   │ status │ acts  │  │
│ │ 12:01:34  │ +1 514…2597 (you)│ !movie dune     │ movies/4│ failed │ retry │  │
│ │ 11:58:02  │ +1 416…1234      │ !tv breaking..  │ tv/west │ queued │ deny  │  │
│ │ …                                                                           │  │
│ └───────────────────────────────────────────────────────────────────────────┘  │
│ Click row → drawer with audit detail + Seerr media-info enrichment + retry log │
└────────────────────────────────────────────────────────────────────────────────┘

┌────── #pending ────────────────────────────────────────────────────────────────┐
│ Pending WhatsApp notifications (rows where attempts < 8):                       │
│ id │ target          │ text                          │ attempts │ last_error │ ⤴│
│ One-click "retry now" per row; "purge dead" button reaps rows >= MAX_ATTEMPTS  │
└────────────────────────────────────────────────────────────────────────────────┘

┌────── #seerr ──────────────────────────────────────────────────────────────────┐
│ Seerr pending approvals (status=2 from listPendingRequests):                    │
│ Poster │ title │ requester (matched to WA number if known) │ approve │ deny │ │
└────────────────────────────────────────────────────────────────────────────────┘

┌────── #conversations ──────────────────────────────────────────────────────────┐
│ In-flight WA conversations (unexpired conversation_state rows):                 │
│ jid │ awaiting (confirm|movie_or_tv|pick|season) │ payload preview │ expires  │
│ Useful for: "who's mid-picker right now? did someone hit the bot at 03:00?"    │
└────────────────────────────────────────────────────────────────────────────────┘

┌────── #syncthing ──────────────────────────────────────────────────────────────┐
│ Per-folder cards: name, state, ████████░░ 88% (12.3 GB / 4203 items pending)   │
│ Ping indicator; "configured?" indicator                                         │
└────────────────────────────────────────────────────────────────────────────────┘

┌────── #feedback ───────────────────────────────────────────────────────────────┐
│ Tabs: [feedback] [issue]                                                        │
│ ts │ user │ body │ auto-report (validation or diagnosis) │                     │
└────────────────────────────────────────────────────────────────────────────────┘

┌────── #admin ──────────────────────────────────────────────────────────────────┐
│ Bot info: bot WA number, allowed groups (read-only for MVP), admin numbers      │
│ Actions: [Send test DM] [Shutdown service] [Reload .env? — deferred]            │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 7. MVP cut line

**v0 — read-only (target: 1 day):**
- Refactor `webhook.ts` to extract a router; mount static + read endpoints; bearer auth.
- Pages: `#overview`, `#requests`, `#pending`, `#syncthing`, `#feedback`.
- New env var `DASHBOARD_TOKEN`; dashboard 503s if empty.
- One new store method: `listAudit(filters)`.
- Tests: router auth (rejects no/wrong token), JSON shape per endpoint, MVP store query.
- No write actions, no `#conversations` panel, no `#admin` panel, no `#seerr` enrichment beyond the existing media-info call.

**v1 — write actions + polish (+1 day):**
- Approve / deny / retry on `#requests` rows.
- Drain / purge on `#pending`.
- `#seerr` pending-approvals panel.
- Shutdown button on `#admin`.
- Audit drawer (per-row detail + Seerr enrichment).

**v2 — operator depth (+1 day):**
- `#conversations` panel.
- Per-user view (link from any `#requests` row).
- Test-DM tool.
- CSV export on `#requests`.

**Deferred / explicitly out of scope:**
- HTTPS / TLS (Tailscale carries it).
- Group / admin allowlist editor (writing back to `.env` mid-process is awkward; punt to a future config-store table).
- Realtime push (SSE/WebSocket).
- Multi-operator RBAC.
- Mobile-optimized layout (responsive enough by default; native-mobile UX is a separate project).

## 8. Code changes — concrete diff sketch

```
src/
  webhook.ts          → refactor: extract `router(req, res, deps)`; existing routes become
                         one branch. Inject seerr + syncthing alongside store + send.
  dashboard/
    routes.ts         → NEW. /api/* handlers. Pure functions over deps.
    auth.ts           → NEW. Bearer validation + cookie bootstrap + loopback bypass.
                         hasPermission() shape future-proof for read-only viewers.
    subscriber.ts     → NEW. onAuditChanged(auditId, kind) fan-out for write actions.
    commands.ts       → NEW. enqueue + runner for the commands table (Sonarr pattern).
    assets.ts         → NEW. index.html, app.js, app.css as TS string literals.
                         index.html includes bootstrap <script> with apiBase + feature flags.
  state/store.ts      → add `listAudit(filters)` + commands CRUD.
  config.ts           → add optional DASHBOARD_TOKEN.
  index.ts            → pass seerr + syncthing into startWebhook(); pass `getConnectionStatus`
                         closure so /api/overview + /api/heartbeat can read currentSock != null.
test/
  dashboard.test.ts   → NEW. Auth gate (incl. loopback bypass), JSON shape per endpoint,
                         listAudit filter coverage, commands lifecycle, subscriber fan-out.
```

Estimated diff: ~900 net new lines, ~150 lines moved (router extraction). No existing test should break — the webhook handler logic is preserved; the change is structural.

## 9. Open questions before code starts

1. **Auth model:** bearer token in URL bootstrap → cookie. Acceptable? Or do you want a small login form (username/password) from the start? My take: token-bootstrap is sufficient behind Tailscale.
2. **Bind address:** keep `0.0.0.0:5056` (current webhook bind) and gate auth, OR bind dashboard to `127.0.0.1` (tailnet-only) and leave the webhook on `0.0.0.0`? My take: keep `0.0.0.0`, simpler and the auth gate is the real boundary.
3. **MVP scope:** does v0 (read-only, 5 panels) match what you'd actually use, or is one of the v1 write actions (approve/deny especially) load-bearing enough to bring forward?
4. **Service restart trigger:** should `POST /api/shutdown` exist in v1, or is the existing `!shutdown` admin command good enough that we don't need a web button?
5. **WA-number → display-name mapping:** today the UI would show raw numbers. Worth wiring a small "contacts" lookup (manual JSON file, or Baileys's `sock.user`-style contact store) so the dashboard reads "Haris" instead of `+15551234567`? Nice-to-have; not blocking.

Answer those and I'll write a focused implementation plan with file-by-file diffs.

---

## 10. Studied references — what we borrowed, what we skipped

Three parallel research passes through the *arr ecosystem informed the design above. Summary of what changed vs. naive first-draft.

### Sonarr / Radarr (canonical *arr, ~100× whatsarr's LOC)

- **Stack:** .NET 6+ backend, React 18 + Webpack 5 + Redux frontend (mid-migration to React Query), SignalR for live updates, OpenAPI-generated REST under `/api/v3`. ~150–250 endpoints across 34 resource folders.
- **Borrowed:**
  - **IA spine** — `Activity / Wanted / System / Settings` matches what an operator dashboard needs at any scale. Whatsarr's panels (`#requests`, `#pending`, `#overview`, `#admin`) are a direct shrink-wrap.
  - **Bootstrap JSON injection** (`InitializeJsonController.cs` pattern) — single round trip ships API key + feature flags. Trivial in `node:http`; pulled into §5 above.
  - **Commands resource** — `POST /api/v3/command` + status tracking + cancellation. Stripped to a `commands` SQL table + `POST /api/commands` for whatsarr; replaces what would have been three ad-hoc `POST /api/shutdown`-style routes.
  - **`AuthenticationRequiredType.DisabledForLocalAddresses`** — loopback bypass clause pulled into §4.
- **Skipped:**
  - **SignalR** — overkill at hundreds of requests/month. 1s/5s/30s polling tiers are sufficient.
  - **Redux + thunks + batched-actions** — Sonarr is itself migrating away from this.
  - **First-run auth wizard** with the Forms/Basic/External matrix — single-operator deploy doesn't need it.
  - **OpenAPI generation** — hand-maintained route list is fine at ~15 endpoints.
- **Citations:** `frontend/src/App/AppRoutes.tsx`, `src/Sonarr.Http/Frontend/InitializeJsonController.cs`, `src/Sonarr.Api.V3/Commands/CommandController.cs`, `src/NzbDrone.Core/Authentication/AuthenticationType.cs`, `src/NzbDrone.SignalR/MessageHub.cs`.

### Overseerr / Jellyseerr (closest domain — Seerr is a fork)

- **Stack:** Express 4 + TypeORM + Next.js 12 + React 18 + SWR. Express-session cookie auth with bcrypt + csurf. Plex OAuth for first-run claim.
- **Borrowed:**
  - **Subscriber pattern for write-action side-effects.** Overseerr's route handler at `server/routes/request.ts` sets `request.status = APPROVED` and `save()` — nothing else. A TypeORM subscriber at `server/subscriber/MediaRequestSubscriber.ts` fans out to Radarr/Sonarr push, parent-media status update, and notifications. Whatsarr collapses this to a single `onAuditChanged(auditId, kind)` function called from each write endpoint; pulled into §3 (Write endpoints).
  - **Bitmask permission middleware** — `isAuthenticated(Permission.MANAGE_REQUESTS)` even though whatsarr has only one bit (isAdmin). Modeling auth as `req.user.hasPermission()` lets a future read-only viewer slot in without touching routes; pulled into §4.
  - **Jobs endpoint JSON shape** — `{id, name, interval, nextExecutionTime, running}` from `/api/v1/settings/jobs` translates verbatim to whatsarr's `/api/tasks`.
- **Skipped:**
  - **TypeORM + Next.js** — ~50× whatsarr's LOC budget for the same operator surface.
  - **express-session + csurf + Plex claim flow** — overkill for a single operator behind Tailscale.
  - **SWR's focus-only revalidation** — the agent's critique is sharp: "for an operator dashboard you actually want the opposite." Whatsarr uses explicit polling intervals.
- **Citations:** `server/routes/request.ts` (one-line state flip), `server/subscriber/MediaRequestSubscriber.ts` (fan-out), `server/middleware/auth.ts` (`isAuthenticated()`), `src/pages/settings/{jobs,logs,services,about}.tsx`.

### Tautulli / Maintainerr (lighter-weight Plex-ecosystem references)

- **Tautulli:** Python + CherryPy + Mako templates + jQuery + Bootstrap. **No frontend build pipeline** — `data/interfaces/default/` contains hand-written HTML/JS/CSS served as-is. Two polling tiers (1s alive, configurable activity).
- **Maintainerr:** NestJS + TypeORM + Vite + React 19 + Tailwind + TanStack Query + Headless UI + Monaco + react-konva. Server-sent events via `reconnecting-eventsource`.
- **Borrowed (Tautulli):**
  - **No build step is precedented.** Tautulli ships hand-written assets to ~thousands of installs. Whatsarr's plan to embed HTML/JS/CSS as TS string literals goes one step further but stays in the same spirit; §5 explicitly cites this.
  - **Two-tier polling cadence** generalised to three (1s heartbeat + 5s active + 30s static). 1s heartbeat endpoint is the new addition vs. the original draft.
  - **Admin dropdown anatomy** — `Logs / Restart / Update check / FAQ`. Whatsarr's `#admin` panel mirrors the action set (sans FAQ/update for now).
- **Borrowed (Maintainerr):** Nothing material. It's the cautionary tale — its frontend stack (Vite + React + Tailwind + TanStack + Headless UI) is more code than whatsarr's entire bot before a single line of UI ships. Modern doesn't mean appropriate at this scale.
- **Skipped (Tautulli):**
  - **JWT + CSRF + multi-user with admin/guest groups** — single-operator assumption is fine.
  - **Mako server-rendered templates with jQuery** — vintage; vanilla `fetch()` + a tiny render loop is cleaner today.
- **Skipped (Maintainerr):** Almost everything — NestJS, TypeORM, Vite, Tailwind, TanStack, SSE. Beautiful stack for a 50K-LOC project; profoundly wrong-sized for 1500.
- **Citations:** Tautulli `data/interfaces/default/` (no `package.json` anywhere in the repo), `webserve.py`, `notifiers.py`. Maintainerr `apps/api` + `apps/ui` (Yarn monorepo + Turbo).

### Final take after studying

The first-draft architecture (same process, same `node:http` server, no build step, bearer-token auth, polling) is **directionally correct and validated by Plex-ecosystem precedent**. The studies surface four concrete refinements, all of which *reduce* code surface or improve clarity rather than adding heft:

1. **Subscriber/side-effect pattern** for write endpoints. Without it, side-effects sprawl across route handlers; with it, the same logic exists in one place and is testable in isolation. ~50 LOC saved.
2. **Commands table + `POST /api/commands`** instead of a sprawl of one-off action routes. Backs the Tasks page for free and gives operator actions an audit trail.
3. **1s heartbeat endpoint** as the third polling tier. ~30 bytes per request, separate from the 5s panel data. Drives the "is the bot alive?" pulse independently of slower data refreshes.
4. **Loopback auth bypass + `hasPermission()`-shaped middleware.** Two-line nuance now; "added a read-only viewer role" is a 10-line change later instead of a 200-line one.

None of these push the design toward heavier dependencies. The dashboard remains a single Node process serving plain HTML + vanilla JS + a few hundred lines of `node:http` routing, backed by the existing SQLite store. The arr ecosystem doesn't have a same-scale reference for whatsarr; Tautulli is the closest *philosophical* match (no-build, polled, hand-written assets) and modern arr patterns (Sonarr's bootstrap JSON + commands resource; Overseerr's subscribers + bitmask perms) map down cleanly without inflating the budget.
