# Setup

End-to-end install, configuration, and deployment for whatsarr. For the 60-second version see the [README](README.md#quickstart); this is the complete reference.

## Prerequisites

- **Node.js 20+** (the app runs TypeScript directly via `tsx` — no build step).
- A working **Seerr / Overseerr / Jellyseerr** instance with **Sonarr** and **Radarr** already connected and able to grab. whatsarr is a chat front-end for it; it does not replace your *arr stack.
- **Plex** (the library Sonarr/Radarr import into) — whatsarr never talks to Plex directly except via the optional Plex-Watchlist sync.
- A **dedicated WhatsApp account** for the bot. Use a burner / dual-account number — see [Risks in the README](README.md#risks); do **not** use your primary number.
- A phone that can scan a QR code for the one-time pairing.

> whatsarr is cross-platform (it's plain Node). It's typically hosted on the **same box** as the Arr stack so it can reach them over loopback, but anything reachable over the network works.

## 1. Get the code + dependencies

```bash
git clone https://github.com/techieharry/whatsarr.git
cd whatsarr
npm install
```

## 2. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env`. The essentials:

| Variable | What it is |
|---|---|
| `SEERR_URL` | Your Seerr base URL, e.g. `http://localhost:5055` |
| `SEERR_API_KEY` | Seerr → Settings → General → API Key |
| `ALLOWED_GROUPS` | Comma-separated WhatsApp **group JIDs** the bot answers in (filled after pairing, step 4) |
| `ADMIN_NUMBERS` | Your number(s) for admin DMs (`!approve`, `!map`, `!shutdown`, …) |
| `DASHBOARD_TOKEN` | A long random string to enable the operator dashboard (optional) |

`.env.example` documents every other option (request caps, anti-spam, webhook, Syncthing, watchlist auto-sync, the Plex-Pass-free path). Everything except the four above has a sane default.

## 3. Configure routing (`routing.config.json`)

```bash
cp routing.config.example.json routing.config.json
```

This maps each category to a Sonarr/Radarr **root folder** + **quality-profile id** for *your* library. Full reference: **[ROUTING.md](ROUTING.md)**. In short — for each category you use, set `rootFolder` (a path that exists on your *arr) and `profileId` (from `GET /api/v3/qualityprofile`). `western` is the default and is required. `routing.config.json` is gitignored; the bot will warn loudly and fall back to the example placeholders if you skip this.

## 4. Pair the bot's WhatsApp account

```bash
npm run discover
```

Scan the QR (WhatsApp → Linked Devices → Link a device) with the **bot's** account. Once paired it lists every group the bot is in, with each JID — copy the ones you want into `ALLOWED_GROUPS` in `.env`. The session persists in `auth_info_baileys/` so you only pair once.

## 5. Run

Pick one.

### a) Directly (foreground / dev)

```bash
npm start
```

### b) Docker (recommended for servers)

```bash
docker compose run --rm whatsarr npm run discover   # one-time pair (interactive)
docker compose up -d --build                         # run detached
docker compose logs -f                               # tail
```

`docker-compose.yml` persists `data/` (SQLite) and `auth_info_baileys/` (session) as volumes, bind-mounts your `.env` + `routing.config.json`, and maps `host.docker.internal` to the host so the container reaches Seerr/Sonarr/Radarr running there (set `SEERR_URL=http://host.docker.internal:5055` in that case, and `WEBHOOK_BIND=0.0.0.0`).

### c) systemd (Linux, bare-metal)

`/etc/systemd/system/whatsarr.service`:

```ini
[Unit]
Description=whatsarr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/whatsarr
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=whatsarr
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now whatsarr
journalctl -u whatsarr -f
```

### d) pm2 (cross-platform)

```bash
npm install -g pm2
pm2 start npm --name whatsarr -- start
pm2 save && pm2 startup
```

### e) Windows service (NSSM)

Install [NSSM](https://nssm.cc/), then point it at `npm start` in the repo dir (or use `node` + the tsx entry). Set it to restart on exit. whatsarr's `!shutdown` / dashboard shutdown does a clean `process.exit(0)` and relies on the service manager to bring it back.

> Whichever you choose: `!shutdown` and the dashboard shutdown button exit the process cleanly and expect your service manager (systemd `Restart=always`, Docker `restart: unless-stopped`, NSSM, pm2) to restart it.

## 6. Wire the Seerr → whatsarr webhook

So members get a "now ready on Plex" DM when a download completes:

Seerr → Settings → Notifications → **Webhook** → enable → URL `http://<bot-host>:5056/webhook`, notification type `MEDIA_AVAILABLE`. If Seerr is in Docker on the same host, use `http://host.docker.internal:5056/webhook` and set `WEBHOOK_BIND=0.0.0.0` in `.env`. Optionally set `SEERR_WEBHOOK_SECRET` in both places.

> ⚠️ Seerr v3.2.0 has a quirk where the webhook `jsonPayload` must be base64 of a *double*-stringified template; the UI hides it. If "Test" works but real `MEDIA_AVAILABLE` events don't arrive, configure the webhook via the API. See [ARCHITECTURE.md](ARCHITECTURE.md).

## 7. Verify

```bash
npm run demo -- "!movie dune part two"   # prints the parse + resolved route, no network
npm test                                 # the full suite
```

Then, in an allow-listed group, send `!help`. Admin: DM the bot `!status` to confirm it reaches Seerr. The operator dashboard (if `DASHBOARD_TOKEN` is set) is at `http://<bot-host>:5056/dashboard/?token=<token>`.

## Troubleshooting

- **Bot doesn't answer in a group** — the group's JID must be in `ALLOWED_GROUPS`, and in-group messages must start with the command prefix (`!`). Unknown senders are silently dropped by design.
- **Disconnect loop** (`AwaitingInitialSync` / code 408) — see [Risks in the README](README.md#risks).
- **Everything routes to a non-existent folder** — you're on the example routing config; create `routing.config.json` (step 3).
- **Reaching Seerr from Docker** — use `host.docker.internal` (already mapped in the compose file) and `WEBHOOK_BIND=0.0.0.0`.
