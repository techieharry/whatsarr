# whatsarr

> A WhatsApp bot that turns group messages into [Seerr](https://github.com/Seerr-Team/seerr) / [Overseerr](https://github.com/sct/overseerr) / [Jellyseerr](https://github.com/Fallenbagel/jellyseerr) requests. Bridges the gap between "my family asks me for movies in WhatsApp" and "I have a Sonarr/Radarr/Plex stack."

Type `!movie dune part two` or `!tv breaking bad` in an allowlisted group, get a picker, pick seasons, and get a DM when the media's on Plex.

## Features

- **Per-group allowlist.** The bot ignores every group it's not explicitly allowed in. JID-based, so group renames don't break auth.
- **Multi-result picker.** When a search returns multiple matches, reply `1` to pick one or `1,3` to queue several at once.
- **TV season picker.** For TV requests, the bot fetches season count from Seerr and prompts: `all`, `latest`, `1`, `1-3`, or `1,3,5`. No more accidentally queueing 300 episodes.
- **Availability-aware.** If a match is already on Plex, the bot tells you instead of double-queueing.
- **DM-on-availability.** When Seerr finishes downloading, the bot DMs the original requester `"Dune: Part Two is now ready on Plex."` Survives bot restarts via a persistent pending-notification queue with retry + drain on reconnect.
- **`!feedback` / `!issue`.** Users can submit feedback or report bugs from any chat; the bot runs a live validation/diagnosis routine and DMs you the results.
- **`!sync`.** Optional [Syncthing](https://syncthing.net) integration — show how far along a remote Plex box is in pulling the latest content.
- **Per-user quota + recent-duplicate detection.** Configurable per-day request limit and dedup window.
- **Audit trail.** Every request is recorded in SQLite with sender, group, route, Seerr id, and status.

## Why this exists

WhatsApp is where most people already are. Discord and Telegram have mature Seerr/Overseerr bots (Doplarr, Requestrr, several Telegram bots); WhatsApp has almost nothing — only [WAMR](https://github.com/techieanant/wamr) and [Whatseerr](https://github.com/SuFxGIT/whatseerr) ship comparable functionality, both very young. whatsarr's distinguishing bets are the group-allowlist + season-picker UX and the connection-stability work documented in the **Risks** section below.

## Quickstart

### Prerequisites

- Node.js 20+
- A running [Seerr](https://github.com/Seerr-Team/seerr) (or Overseerr / Jellyseerr) instance with Sonarr and Radarr already configured
- A **dedicated WhatsApp account** for the bot. Use a burner / dual-account phone. See **Risks** below — do not use your primary number.
- A phone that can scan QR codes (for the one-time pair)

### Install

```bash
git clone https://github.com/techieharry/whatsarr.git
cd whatsarr
npm install
cp .env.example .env
# Edit .env with your Seerr URL + API key + admin number
```

### Pair the bot's WhatsApp account

```bash
npm run discover
```

This launches the QR pair flow. It also writes `qr.html` next to the script — open it in any browser, scan with the bot's WhatsApp account (Linked Devices → Link a device), and once paired it'll dump every group the bot is a member of along with each JID. Copy the JIDs of the groups you want the bot active in into `ALLOWED_GROUPS` in `.env`.

### Run

```bash
npm start
```

The bot connects to WhatsApp + opens the webhook listener (default `127.0.0.1:5056`). In an allowlisted group, type `!help` to see the command list.

### Wire up Seerr → bot webhook

Seerr → Settings → Notifications → Webhook → enable, point at `http://<your-bot-host>:5056/webhook`, set notification type to `MEDIA_AVAILABLE`. If you're running Seerr in Docker on the same host, the URL is `http://host.docker.internal:5056/webhook` and the bot needs `WEBHOOK_BIND=0.0.0.0` in `.env`.

> ⚠️ Seerr v3.2.0 has a quirk where the webhook `jsonPayload` must be base64 of a *double*-stringified JSON template; the UI hides this. If your "Test" notification works but real `MEDIA_AVAILABLE` events don't reach the bot, configure the webhook via the API instead.

## Risks

whatsarr uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web protocol library. Be aware:

- **WhatsApp may ban the bot's account.** Reports range from a few weeks to never. The Cloud API (the official path) is business-gated and not realistic for hobby use. **Use a burner number you don't care about losing.**
- **WhatsApp protocol drift.** Baileys plays catch-up with each WA Web update. Pin the version you tested with; before upgrading, read the Baileys changelog.
- **The bot disconnect loop.** If you see `AwaitingInitialSync, buffering events` followed by `Timeout in AwaitingInitialSync, forcing state to Online` every few minutes and `Connection was lost (code 408)`, the fix that worked for us was: upgrade Baileys to `7.0.0-rc13` (or later) AND add `syncFullHistory: false` + `markOnlineOnConnect: true` to the `makeWASocket()` call. See [`src/index.ts`](src/index.ts).

## Configuration

All config lives in environment variables — see [`.env.example`](.env.example) for the full list with comments. The notable knobs:

| Var | Purpose | Default |
|---|---|---|
| `SEERR_URL` | Base URL of your Seerr instance | _required_ |
| `SEERR_API_KEY` | From Seerr → Settings → General | _required_ |
| `ALLOWED_GROUPS` | Comma-separated group JIDs (`120363xxx@g.us`) | _required_ |
| `ADMIN_NUMBERS` | Comma-separated bare numbers; get DM reports for `!feedback`/`!issue` | empty |
| `REQUESTS_PER_DAY` | Per-user daily quota | `5` |
| `DEDUP_WINDOW_HOURS` | Block re-requesting the same title | `1` |
| `CONFIRM_TTL_MINUTES` | How long a pending picker / confirm state lives | `10` |
| `WEBHOOK_BIND` | `127.0.0.1` (loopback) or `0.0.0.0` (all interfaces — for Docker→host) | `127.0.0.1` |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md). Short version: stateless command parser → state-machine handler (auth → state → parse → quota/dedup → search → picker → season picker → confirm → Seerr `createRequest` → audit) → webhook delivers `MEDIA_AVAILABLE` to original requester via a retry+pending queue.

## Routing

See [ROUTING.md](ROUTING.md). Each `(media type, category)` pair maps to a `(root folder, quality profile)` your Seerr backend will use. The default table is in [`src/routing/table.ts`](src/routing/table.ts) — edit it to match your library layout.

## Privacy

See [PRIVACY.md](PRIVACY.md). The bot stores only what it needs: command text, sender JID, route resolution, Seerr request id, and a small conversation-state row that expires after a few minutes. No transcript archive. No message content beyond commands.

## Develop

```bash
npm test         # 100+ tests across parser, routing, handler, features
npx tsc --noEmit # type-check
npm run demo -- "!movie dune part two"   # try the parser+route resolver in isolation
```

## Contributing

Issues + PRs welcome. For non-trivial changes, please open an issue first to discuss. Tests are required for new features; type errors are required to be zero.

## License

[MIT](LICENSE) © 2026 Haris Yusuf

## Related projects

- [WAMR](https://github.com/techieanant/wamr) — WhatsApp → Sonarr/Radarr/Overseerr, natural-language style
- [Whatseerr](https://github.com/SuFxGIT/whatseerr) — WhatsApp → Seerr via WAHA
- [Doplarr](https://github.com/kiranshila/Doplarr) — Discord → Sonarr/Radarr/Overseerr (Clojure)
- [Requestrr](https://github.com/thomst08/requestrr) — Discord → Sonarr/Radarr/Overseerr/Ombi (C#)
- [Overseerr-Telegram-Bot](https://github.com/LetsGoDude/Overseerr-Telegram-Bot) — Telegram → Overseerr
