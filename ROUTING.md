# Category routing

whatsarr resolves each `(media type, category)` to a Sonarr/Radarr `(root folder, quality profile)` and sends that as a per-request override to Seerr. Seerr has one Sonarr and one Radarr entry (with sensible defaults); category routing happens at the whatsarr layer so you don't have to multiply Seerr instances.

Routes live in **`routing.config.json`** at the repo root — your per-deployment file, which is **gitignored**. Copy the committed template and edit it for your library:

```bash
cp routing.config.example.json routing.config.json
```

The loader ([`src/routing/config.ts`](src/routing/config.ts)) reads `routing.config.json` at startup, validates it, and fails fast with a clear message on a bad entry. If `routing.config.json` is missing it falls back to `routing.config.example.json` (placeholder paths) with a loud warning, so a fresh clone, the test suite, and `npm run demo` still boot — but you must create your own before serving real requests.

## Syntax

- `!movie <title>` or `!req <title>` → movies, default category (`western`)
- `!movie <category> <title>` → movies, explicit category
- `!tv <title>` or `!show <title>` → TV, default category (`western`)
- `!tv <category> <title>` → TV, explicit category

Categories are matched case-insensitively. Unknown category → falls back to default + (for `!req`) a clarification prompt. `western` is the default, so it **must** be present under both `movies` and `tv`.

## Config format

```jsonc
{
  "movies": {
    "western":     { "rootFolder": "/data/media/movies/Western",   "profileId": 1, "profileName": "HD-1080p" },
    "anime":       { "rootFolder": "/data/media/movies/Anime",      "profileId": 2, "profileName": "Anime-1080p" }
    // ... bollywood, pakistani, foreign, documentary, animated
  },
  "tv": {
    "western":     { "rootFolder": "/data/media/tv/Western",        "profileId": 1, "profileName": "HD-1080p" },
    "anime":       { "rootFolder": "/data/media/tv/Anime",          "profileId": 2, "profileName": "Anime-1080p" }
    // ... documentary, bollywood, asian, animated
  },
  "forbiddenPath": "Curated|Private"
}
```

Supported category keys (from the parser): `western`, `bollywood`, `pakistani`, `foreign`, `documentary`, `asian`, `anime`, `animated`. You only need the ones you use, but `western` (the default) is required. A category present under `movies` but not `tv` (or vice-versa) simply isn't routable for that media type — the request is rejected with a clear reason.

### Finding your values

- **`profileId`** — the numeric quality-profile id from your Sonarr/Radarr: `GET /api/v3/qualityprofile` returns the list (or read it off Settings → Profiles). `profileName` is cosmetic (logged for clarity); `profileId` is what's sent.
- **`rootFolder`** — a root folder that already exists on the Sonarr/Radarr side: `GET /api/v3/rootfolder`. Use the path format your *arr expects (POSIX `/data/...` on Linux/Docker, `Z:\\...` on Windows — note JSON requires `\\` for a backslash).

## Defense-in-depth: forbidden paths

`forbiddenPath` is an optional regular expression. Any resolved `rootFolder` matching it is **refused** — `resolveRoute()` throws — even if a config edit accidentally points a category at a curated/off-limits library. Leave it out (or empty) to disable the guard.

```json
"forbiddenPath": "Curated|Archive|Private"
```

## How the override is passed to Seerr

```json
{
  "mediaType": "movie",
  "mediaId": 12345,
  "rootFolder": "/data/media/movies/Bollywood",
  "profileId": 1,
  "serverId": 0,
  "languageProfileId": 1,
  "userId": 1
}
```

For TV, add `"seasons": "all"` or an array of season numbers (e.g. `[1, 3]`).

## Examples

| WhatsApp message | Resolves to (with the example config) |
|---|---|
| `!movie dune part two` | movies / `western` route |
| `!movie bollywood laapataa ladies` | movies / `bollywood` route |
| `!tv the bear` | tv / `western` route |
| `!tv anime frieren` | tv / `anime` route |
| `!tv asian squid game` | tv / `asian` route |
| `!req chimp empire` | bot asks "movie or TV?" |
