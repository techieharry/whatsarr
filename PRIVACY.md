# Privacy posture

## Accepted tradeoff

WhatsApp is the user-facing transport. That's a deliberate **usability** decision — the target users already live on WhatsApp — made with full knowledge of the privacy cost.

**What Meta will see regardless of what whatsarr does:**

- The bot's phone number and every number that messages it
- Full membership of every WhatsApp group the bot is added to
- Message metadata (sender, recipient, timestamp, size) for every command and reply
- Timing patterns that may let Meta identify the bot's number as automated

Message *content* remains E2E encrypted between the bot and each user; Meta cannot read it.

## What whatsarr stores locally

| Data | Why | Lifetime |
|---|---|---|
| Conversation state (e.g. "user X is mid-pick, waiting for `1,3`") | To resume multi-step interactions | Auto-expires after `CONFIRM_TTL_MINUTES` (default 10) |
| Per-day quota count | To enforce `REQUESTS_PER_DAY` | One row per (sender, day) |
| Recent-duplicate dedup | To collapse repeat requests within `DEDUP_WINDOW_HOURS` | Single row per (sender, type, normalized title) |
| Audit row | Diagnose problems / answer "did my request go through?" | Indefinite (manual cleanup) |
| Pending notification | Survive WA socket bounce during webhook delivery | Drained on reconnect; reaped after N failed attempts |
| Feedback / Issue rows | Surface what users ask for | Indefinite |

**Not stored:** raw message content beyond what's needed to parse a command. There is no transcript archive.

## Mitigations on the WhatsApp side

- **Dedicated bot number.** Never use a personal WhatsApp number. If it gets flagged or banned, no real account is lost.
- **Command prefix in groups.** The bot only processes `!`-prefixed messages, so it doesn't read or store unrelated group chatter.
- **Baileys session file is a credential.** Keep `auth_info_baileys/` off any shared/synced folder. Leaking it = cloning the bot.
- **Quotas and rate limits.** Reduce the chance of the bot's number being flagged as spam-like automation.
- **Silent drop on unknown senders.** The bot does not confirm its own existence to random numbers — DMs from unknown senders get no reply.

## Mitigations on the Plex / Arr side (separate hardening — not whatsarr's scope)

- **Disable Plex Remote Access** and the `plex.tv announce` setting if not needed.
- **Route Sonarr / Radarr / qBittorrent through a VPN container** (e.g. `gluetun`) so indexer / tracker URLs don't see your home IP.
- **Seerr → TMDB metadata lookups** are unavoidable; the title you searched is visible to TMDB. No practical mitigation short of replacing Seerr.

## Honest disclosure for users

Anyone in a bot-served WhatsApp group should be told, in plain terms:

> Your messages to this bot are end-to-end encrypted in transit. Meta (WhatsApp) still sees that you messaged the bot, when, and from which number. If you don't want Meta to have that metadata, don't use the bot.

The bot operator runs the WhatsApp side; users own their choice to participate.
