# Architecture

## Components

1. **WhatsApp transport** — receives inbound messages, sends replies (Baileys).
2. **Command parser** — pure function that turns a `!`-prefixed string into a structured `ParsedCommand`.
3. **State machine** — per-sender conversation state (`confirm`, `movie_or_tv`, `pick`, `season`) with TTL.
4. **Seerr client** — talks to Seerr / Overseerr / Jellyseerr over HTTP (search, createRequest, status, TV details, etc).
5. **Routing table** — maps `(media type, category)` → `(root folder, quality profile)` overrides passed per-request.
6. **Store** — SQLite (WAL) for conversation state, quotas, dedup, audit, pending notifications, feedback.
7. **Webhook** — receives `MEDIA_AVAILABLE` callbacks from Seerr and DMs the original requester.
8. **Diagnostics** — `runValidation` / `runDiagnosis` that power the auto-routines for `!feedback` / `!issue`.
9. **Sender** — shared `sendWithRetry` used by both reply path and webhook delivery; transient send failures enqueue to `pending_notification` and drain on reconnect.

## WhatsApp transport options

| Option | Cost | Ban risk | Setup | Notes |
|--------|------|----------|-------|-------|
| [Baileys](https://github.com/WhiskeySockets/Baileys) (what we use) | Free | **High** — WA actively bans automation numbers | Low (QR scan) | Uses the WhatsApp Web protocol. Fine for a private household bot; risky for anything public. |
| [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) | Free | High | Low | Puppeteer-based. Heavier than Baileys, same ban risk. |
| Meta Cloud API (official) | Free tier, then per-conversation pricing | None | High (business verification, approved templates) | The "correct" path but overkill for a home server. |

**Recommendation:** start with Baileys on a dedicated WhatsApp number you don't care about losing. Never use your primary number.

## Backend

The bot is a thin WhatsApp → Seerr API adapter. Approval queue, per-user quotas, Plex-library-aware duplicate detection, and webhooks for "content ready" are all built into Seerr. Direct-to-Sonarr/Radarr would force whatsarr to reimplement all of that.

The bot ships clean `serverId` + `languageProfileId` + `rootFolder` + `profileId` on every `createRequest`, so Seerr can route to the configured default Sonarr/Radarr instance without falling back to "no server picked" → Failed.

## Data flow (happy path, TV)

```
1. User sends:       !tv breaking bad
2. Parser:           { kind: 'request', mediaTypeHint: 'tv', category: null, title: 'breaking bad' }
3. Router:           { rootFolder: '<TV western>', profileId: 7 }
4. Seerr:            GET /api/v1/search?query=breaking+bad  → 3 results
5. Bot replies:      "@<user> pick: 1. ... 2. ... 3. ..."
6. User sends:       1
7. Bot:              fetches getTvDetails(tmdbId) for season count
8. Bot replies:      "Found: Breaking Bad (2008). It has 5 seasons. Which seasons? Reply all / latest / 1 / 1-5 / 1,3 / NO"
9. User sends:       1
10. Bot calls:       POST /api/v1/request  (with seasons=[1], serverId, languageProfileId)
11. Bot replies:     "*Breaking Bad (2008)* (season 1) queued by @<user>"
12. Webhook (later): Seerr → bot → DM to original requester
```

## State

Per-sender state lives in SQLite with a configurable TTL (`CONFIRM_TTL_MINUTES`, default 10). State `awaiting` values:

| Value | Set by | Cleared by |
|---|---|---|
| `movie_or_tv` | `!req <title>` | reply `MOVIE` / `TV` |
| `pick` | multi-result search | reply `1`–`N` or `1,3` or `NO` |
| `season` | TV match found | reply `all` / `latest` / `1` / `1-N` / `1,3,5` / `NO` |
| `confirm` | single-result movie OR TV after season pick | reply `YES` / `NO` |

A new `!command` always cancels the current state.

## Access control

Authorization is **group-based**, not number-based:

- The bot is added to a fixed set of allowed WhatsApp groups (`ALLOWED_GROUPS` in `.env`).
- Each group is identified by its **JID** (`120363...@g.us`), not its display name — names can be changed by any admin, JIDs are immutable.
- Any message in an allowed group from any member is accepted. Messages from other groups or unknown DMs are silently dropped (no reply, to avoid confirming the bot exists to random numbers).
- Optional overlay: an `ADMIN_NUMBERS` list for receiving `!feedback` / `!issue` reports via DM. Regular requests do **not** need this — group membership is enough.

### In-group behaviour

- **Prefix required in groups:** `!movie <title>`, `!tv <title>`, `!req <title>`, etc. Bot ignores non-prefixed messages.
- **DMs skip the prefix** — anything sent to the bot privately by an admin (or a sender with an active state) is treated as a request.
- **Reply routing — replies stay in the originating channel:** group commands → group replies (with `@`-mention of the requester); DM commands → DM replies.

## Webhook reliability

`MEDIA_AVAILABLE` webhooks can fire while the WA socket is mid-reconnect. To avoid silent message loss:

1. Webhook tries `sendWithRetry` (3 attempts, exponential backoff).
2. On transient failure (`Connection Closed`, `connection was lost`, `attrs` error, 428), the notification is enqueued to the `pending_notification` table.
3. On the next `connection.update === 'open'` event (and every 60s as a safety net), `drainPending()` re-attempts the queue.
4. After `MAX_PENDING_ATTEMPTS` (default 8), the row is reaped to keep the queue bounded.

This is the **headline reliability fix** in the project — see [`src/sender.ts`](src/sender.ts), [`src/index.ts`](src/index.ts) `sendViaCurrentSock` + `drainPending`, and [`src/webhook.ts`](src/webhook.ts).

## Abuse / rate limits

- Per-sender quota (default 5 requests / 24 h) tracked in SQLite, independent of Seerr's own quotas.
- Duplicate detection: identical title + type from the same sender within `DEDUP_WINDOW_HOURS` collapses to a single request.
- If the bot's WhatsApp number starts receiving "unusual activity" warnings, halt automation and investigate before resuming.
