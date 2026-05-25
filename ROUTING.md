# Category routing

whatsarr resolves each `(media type, category)` to a Sonarr/Radarr `(root folder, quality profile)` and sends that as a per-request override to Seerr. Seerr has one Sonarr and one Radarr entry (with sensible defaults); category routing happens at the whatsarr layer so you don't have to multiply Seerr instances.

## Syntax

- `!movie <title>` or `!req <title>` → movies, default category (Western)
- `!movie <category> <title>` → movies, explicit category
- `!tv <title>` or `!show <title>` → TV, default category (Western)
- `!tv <category> <title>` → TV, explicit category

Categories are matched case-insensitively. Unknown category → falls back to default + (for `!req`) a clarification prompt.

## Default movie routes (Radarr)

| Category keyword(s) | Root folder | Profile ID | Profile name |
|---|---|---|---|
| (default / `western`) | `<your_movie_root>/Western` | `7` | HD Bluray+WEB |
| `bollywood`, `bolly`, `hindi` | `<your_movie_root>/Bollywood` | `7` | HD Bluray+WEB |
| `pakistani`, `pak`, `urdu` | `<your_movie_root>/Pakistani` | `7` | HD Bluray+WEB |
| `foreign`, `intl` | `<your_movie_root>/Foreign` | `7` | HD Bluray+WEB |
| `documentary`, `doc`, `docu` | `<your_movie_root>/Documentary` | `7` | HD Bluray+WEB |
| `anime` | `<your_movie_root>/Anime` | `11` | REMUX-1080p - Anime |
| `animated`, `cartoon` | `<your_movie_root>/Animated` | `7` | HD Bluray+WEB |

## Default TV routes (Sonarr)

| Category keyword(s) | Root folder | Profile ID | Profile name |
|---|---|---|---|
| (default / `western`) | `<your_tv_root>/Western` | `7` | WEB-DL (1080p) |
| `documentary`, `doc`, `docu` | `<your_tv_root>/Documentary` | `7` | WEB-DL (1080p) |
| `bollywood`, `bolly`, `hindi` | `<your_tv_root>/Bollywood` | `7` | WEB-DL (1080p) |
| `asian`, `kdrama`, `cdrama`, `jdrama` | `<your_tv_root>/Asian` | `7` | WEB-DL (1080p) |
| `anime` | `<your_tv_root>/Anime` | `9` | Remux-1080p - Anime |
| `animated`, `cartoon` | `<your_tv_root>/Animated` | `7` | WEB-DL (1080p) |

## Customizing

Edit [`src/routing/table.ts`](src/routing/table.ts). The structure:

```ts
export const MOVIE_ROUTES: Partial<Record<Category, Route>> = {
  western: { rootFolder: 'X:/Plex/Movies/Western', profileId: 7, profileName: 'HD Bluray+WEB' },
  // ...
};

export const TV_ROUTES: Partial<Record<Category, Route>> = {
  western: { rootFolder: 'X:/Plex/TV/Western', profileId: 7, profileName: 'WEB-DL (1080p)' },
  // ...
};
```

Profile IDs come from your Sonarr/Radarr instance: `GET /api/v3/qualityprofile` returns the list. Root folders: `GET /api/v3/rootfolder`. These must exist on the Sonarr/Radarr side before they'll work.

## Defense-in-depth: forbidden paths

The routing table has a `FORBIDDEN_PATH` regex that **rejects any resolved route landing in a personal/curated library** even if a future config change accidentally adds it. Add your "never touch" directory patterns to that regex:

```ts
export const FORBIDDEN_PATH = /(MyName's|Curated|Archive)/;
```

`resolveRoute()` throws if a resolved route's `rootFolder` matches.

## How the override is passed to Seerr

```json
{
  "mediaType": "movie",
  "mediaId": <tmdb_id>,
  "rootFolder": "X:/Plex/Movies/Bollywood",
  "profileId": 7,
  "serverId": 0,
  "languageProfileId": 1,
  "userId": <seerr_user_id>
}
```

For TV, add `"seasons": "all"` or an array of season numbers (e.g. `[1, 3]`).

## Examples

| WhatsApp message | Resolves to |
|---|---|
| `!movie dune part two` | Western movies / HD Bluray+WEB |
| `!movie bollywood laapataa ladies` | Bollywood movies / HD Bluray+WEB |
| `!tv the bear` | Western shows / WEB-DL 1080p |
| `!tv anime frieren` | Anime shows / Remux-1080p Anime |
| `!tv asian squid game` | Asian shows / WEB-DL 1080p |
| `!req chimp empire` | bot asks "movie or TV?" |
