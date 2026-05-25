# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security findings.

Instead, use GitHub's private vulnerability reporting:

1. Go to https://github.com/techieharry/whatsarr/security
2. Click **Report a vulnerability**
3. Include: what you found, how to reproduce, and what an attacker could do.

I'll acknowledge within 7 days and aim to issue a fix or workaround within 30 days for confirmed issues.

## Threat model

whatsarr handles three classes of sensitive material; each has documented mitigations:

| Material | Risk | Mitigation |
|---|---|---|
| **WhatsApp session credentials** (`auth_info_baileys/`) | Full takeover of the bot's WA account if exfiltrated | Stored in a directory excluded from git; backup separately; do not place on a synced cloud drive |
| **Seerr API key** (`.env`) | Anyone can create / modify / delete requests on your behalf | `.env` is excluded from git; rotate when exposed |
| **Webhook endpoint** | Anyone who can reach it can send a fake "ready" notification → bot DMs your users with bogus availability messages | Bind to a private interface (Tailscale / loopback) when possible; set `SEERR_WEBHOOK_SECRET` for HMAC-style header check; rate-limiting is on the roadmap |

## What's in scope

- Anything in `src/`
- Any documented endpoint or command in the `README` / `ARCHITECTURE`

## What's out of scope

- Bugs in upstream dependencies (`@whiskeysockets/baileys`, `better-sqlite3`, `pino`, etc.) — report those directly to the upstream project
- Issues caused by an attacker who already has root on the machine running the bot
- Bans / rate-limits imposed by WhatsApp on the bot's account (see the **Risks** section in the README — this is inherent to unofficial WA libraries)
