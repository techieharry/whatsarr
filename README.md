# whatsarr

A WhatsApp request bot for Plex media. Household members and friends request movies and TV shows by sending a WhatsApp message — no Discord, no Seerr account, no app to install. Inspired by [Requestrr](https://github.com/darkalfx/requestrr) (Discord), but built for WhatsApp as the chat layer and [Seerr](https://github.com/seerr/seerr) (the Overseerr successor) as the backend.

## Status

**Production.** Runs as an always-on service against a live Plex/Seerr/Sonarr/Radarr stack: parser + routing, multi-result and season pickers, per-user attribution, multi-subscriber "now ready" notifications, watchlist auto-sync (Plex + Letterboxd), a failed-request retry loop, and an embedded operator dashboard. Deterministic, offline parser — no LLM in the request path. `tsc --noEmit` clean; the suite is 363 tests (`npm test`).

## How it works

```
WhatsApp user ──▶ whatsarr ──▶ Seerr ──▶ Sonarr / Radarr ──▶ Plex
   (group/DM)        │   (per-request root folder + quality profile override)
                     └──▶ confirm in-channel  ◀── webhook "now ready" DM ◀──┘
```

A user sends `!movie dune part two` in an allow-listed group. whatsarr searches Seerr, replies with a confirmation (or a numbered picker when there are several matches), routes the request to the right root folder and quality profile for its category, and creates the Seerr request. When Seerr reports the download is available, every subscriber who asked for that title gets a "now ready on Plex" message.

## What makes it different

The WhatsApp→Seerr niche has two other purpose-built bots ([WAMR](https://github.com/techieanant/wamr), [whatseerr](https://github.com/SuFxGIT/whatseerr)). whatsarr's defensible edges:

- **Access control by group JID.** Requests are gated on an immutable allow-list of WhatsApp **group** JIDs before any processing; unknown senders are silently dropped (the bot never confirms its own existence). Group renames can't break it — it keys on JIDs, never display names.
- **Per-category routing.** Per-request `rootFolder` + `profileId` overrides across categories (western, bollywood, pakistani, foreign, documentary, asian/kdrama, anime, animated), with a forbidden-path guard that rejects any request resolving into a curated/off-limits library. Seerr stays single-instance — routing is the override mechanism, not multiple backends.
- **Per-user identity (`!map`).** An admin maps a WhatsApp number to a Seerr user, so requests are attributed to the real requester in Seerr's UI instead of one shared service account.
- **Watchlist auto-sync.** A poller turns Plex Watchlist and Letterboxd list additions into requests through the same routing/audit/dedup/notify path — including a Plex-Pass-free path that reads the owner's own + friends' watchlists via Plex's free Discover/Community APIs. Members self-register feeds over chat with `!watchlist add`.
- **Always-on, self-hosted packaging.** Runs as a service on the same box as the Arr stack, with an inbound webhook + event model — it wakes on "media ready" and fans the notification out to everyone who subscribed.

DM-on-availability and per-user attribution exist in the other bots too — they're table-stakes now, not moats. The "picker" is **numbered text-reply** (`1`, or `1,3` for several), not WhatsApp interactive buttons.

## Commands

In an allow-listed group (or a DM from an allow-listed member), prefixed with `!`:

```
!movie <title>             request a movie
!movie <category> <title>  movie with a category (routing override)
!tv <title>                request a TV show (bot then asks which seasons)
!tv <category> <title>     TV with a category
!req <title>               bot asks movie or TV
!queue                     your recent requests
!prioritize [title]        push a request to the front (force a search now)
!status                    Seerr health
!watchlist                 manage your Plex / Letterboxd auto-sync feeds
!sync                      Plex ↔ remote-server sync status (Syncthing)
!feedback <message>        send feedback (auto-validates the bot)
!issue <description>       report a bug (auto-runs a diagnosis)
!help                      command list
```

- **Picker** — when there are multiple matches, reply `1` for one or `1,3` for several.
- **Seasons (TV)** — reply `all`, `latest`, `1`, `1-3`, or `1,3,5`.

Admin-only (over DM):

```
!pending                   list pending Seerr requests
!approve <id> / !deny <id> approve or decline a pending request
!map [<number> <userId>]   list / set WhatsApp → Seerr user mappings
!unmap <number>            revert a number to the default Seerr user
!announce <message>        broadcast a message to every allow-listed group
!shutdown                  graceful exit (the service auto-restarts)
```

## Operator dashboard

An embedded, no-build dashboard is served from the bot process itself at `/dashboard/` (bearer-token auth; set `DASHBOARD_TOKEN`). Panels cover overview/heartbeat, requests with an audit drawer (approve/deny/retry), pending notifications, the Seerr approval queue, active conversations, Syncthing status, and feedback — plus admin command buttons. See [DASHBOARD.md](DASHBOARD.md).

## Quickstart

### Prerequisites

- Node.js 20+
- A running [Seerr](https://github.com/seerr/seerr) (or Overseerr / Jellyseerr) instance with Sonarr and Radarr already configured
- A **dedicated WhatsApp account** for the bot. Use a burner / dual-account phone — see **Risks** below; do not use your primary number.
- A phone that can scan QR codes (for the one-time pair)

### Install

```bash
git clone https://github.com/techieharry/whatsarr.git
cd whatsarr
npm install
cp .env.example .env
# Edit .env with your Seerr URL + API key + admin number
cp routing.config.example.json routing.config.json
# Edit routing.config.json — map each category to a root folder + Sonarr/Radarr
# quality-profile id for your library (see ROUTING.md)
```

### Pair the bot's WhatsApp account

```bash
npm run discover
```

This launches the QR pair flow and writes `qr.html` next to the script — open it in any browser, scan with the bot's WhatsApp account (Linked Devices → Link a device), and once paired it dumps every group the bot is a member of along with each JID. Copy the JIDs of the groups you want the bot active in into `ALLOWED_GROUPS` in `.env`.

### Run

```bash
npm start
```

The bot connects to WhatsApp and opens the webhook listener (default `127.0.0.1:5056`). In an allow-listed group, type `!help` to see the command list.

### Run with Docker (alternative)

```bash
cp .env.example .env                                 # fill in
cp routing.config.example.json routing.config.json   # edit for your library
docker compose run --rm whatsarr npm run discover    # one-time QR pair (interactive)
docker compose up -d --build                         # run detached
```

`docker-compose.yml` keeps the SQLite DB + WhatsApp session in volumes and maps `host.docker.internal` to your host so the container can reach Seerr/Sonarr/Radarr running there. See [SETUP.md](SETUP.md) for systemd, pm2, and Windows (NSSM) service options.

### Wire up the Seerr → bot webhook

Seerr → Settings → Notifications → Webhook → enable, point at `http://<your-bot-host>:5056/webhook`, set the notification type to `MEDIA_AVAILABLE`. If Seerr runs in Docker on the same host, use `http://host.docker.internal:5056/webhook` and set `WEBHOOK_BIND=0.0.0.0` in `.env`.

> ⚠️ Seerr v3.2.0 has a quirk where the webhook `jsonPayload` must be base64 of a *double*-stringified JSON template; the UI hides this. If your "Test" notification works but real `MEDIA_AVAILABLE` events don't reach the bot, configure the webhook via the API instead.

## Stack & decisions

- **Backend:** [Seerr](https://github.com/seerr/seerr) (Overseerr successor) over its REST API, single instance.
- **WhatsApp transport:** [Baileys](https://github.com/WhiskeySockets/Baileys) (Node.js, in-process, a dedicated secondary number).
- **Runtime:** Node.js 20+, TypeScript (strict, ESM, run via `tsx`).
- **Storage:** SQLite (`better-sqlite3`, WAL).
- **Access control:** membership-based — a WhatsApp **group** JID allow-list; in-group commands require the `!` prefix.
- **Hosting:** same box as Plex/Sonarr/Radarr.

## Risks

whatsarr uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web protocol library. Be aware:

- **WhatsApp may ban the bot's account.** Reports range from a few weeks to never. The Cloud API (the official path) is business-gated and not realistic for hobby use. **Use a burner number you don't care about losing.** Ban risk is platform-level, not library-level — every unofficial transport (Baileys, whatsapp-web.js, WAHA) carries it.
- **WhatsApp protocol drift.** Baileys plays catch-up with each WA Web update. Pin the version you tested with; before upgrading, read the Baileys changelog.
- **The disconnect loop.** If you see `AwaitingInitialSync, buffering events` → `Timeout in AwaitingInitialSync, forcing state to Online` every few minutes and `Connection was lost (code 408)`, the fix that worked for us was: upgrade Baileys to `7.0.0-rc13` (or later) AND add `syncFullHistory: false` + `markOnlineOnConnect: true` to the `makeWASocket()` call. See [`src/index.ts`](src/index.ts).

See [PRIVACY.md](PRIVACY.md) for the metadata tradeoffs and honest user disclosure.

## Docs

- [SETUP.md](SETUP.md) — full install, configuration, and deployment (Docker / systemd / pm2 / Windows)
- [ARCHITECTURE.md](ARCHITECTURE.md) — components, data flow, transport options
- [ROUTING.md](ROUTING.md) — `routing.config.json`: category → root folder / quality profile map, and the forbidden-path guard
- [DASHBOARD.md](DASHBOARD.md) — the operator dashboard
- [PRIVACY.md](PRIVACY.md) — accepted tradeoffs (WhatsApp = Meta metadata), mitigations, honest user disclosure
- [SECURITY.md](SECURITY.md) — reporting security issues

## Develop

```bash
npm install
cp .env.example .env                                 # Seerr URL/key, group JIDs, admin number(s)
cp routing.config.example.json routing.config.json   # your library root folders + profile ids
npm run discover       # one-shot QR pairing + dump group JIDs
npm start              # run the bot
npm test               # node:test suite
npm run demo -- "!movie dune part two"   # print parse + resolved route, no network
```

## Contributing

Issues + PRs welcome. For non-trivial changes, please open an issue first to discuss. Tests are required for new features; type errors are required to be zero.

## License

[MIT](LICENSE) © 2026 Haris Yusuf

## Related projects

- [WAMR](https://github.com/techieanant/wamr) — WhatsApp → Sonarr/Radarr/Overseerr, natural-language style
- [whatseerr](https://github.com/SuFxGIT/whatseerr) — WhatsApp → Seerr via WAHA
- [Doplarr](https://github.com/kiranshila/Doplarr) — Discord → Sonarr/Radarr/Overseerr (Clojure)
- [Requestrr](https://github.com/thomst08/requestrr) — Discord → Sonarr/Radarr/Overseerr/Ombi (C#)
- [Overseerr-Telegram-Bot](https://github.com/LetsGoDude/Overseerr-Telegram-Bot) — Telegram → Overseerr
