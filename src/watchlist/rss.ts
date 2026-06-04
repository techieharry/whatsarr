// Dependency-free RSS parsing for the watchlist poller. Plex Watchlist and
// Letterboxd list feeds both publish plain RSS 2.0 (<item> elements); rather
// than pull in an XML library we extract the handful of fields we need with
// regexes. Parsing is intentionally DEFENSIVE: feed schemas drift, so external
// IDs are scavenged from several known shapes and the sync layer always has a
// title+year search fallback when no ID is present. These functions are pure (no
// network) so they unit-test against fixture XML. Scope is RSS 2.0 only — Atom
// (<entry>) is not supported, because neither source emits it.

export type WatchlistItem = {
  guid: string;                 // stable per-item id (feed <guid>, else <link>, else title|year)
  title: string;                // cleaned title (year suffix stripped)
  year: number | null;
  type: 'movie' | 'tv';
  tmdbId: number | null;
  imdbId: string | null;
};

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// First inner text of <name ...>…</name> (namespace prefixes and attributes
// allowed), CDATA-stripped and entity-decoded. null if the tag is absent.
function firstTag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  return decodeEntities(stripCdata(m[1]!)).trim();
}

// Split a feed into its <item> (RSS 2.0) blocks.
function extractItemBlocks(xml: string): string[] {
  return xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
}

// Scavenge a TMDb id from a known STRUCTURED shape anywhere in the item block.
// Deliberately no loose free-text fallback (e.g. "tmdb: 92%") — a fabricated id
// would skip the safer title+year search path and silently request the wrong
// title. When none of these match, the sync layer falls back to search.
function extractTmdbId(block: string): number | null {
  const patterns = [
    /themoviedb\.org\/(?:movie|tv)\/(\d+)/i,
    /<tmdb:(?:movieId|tvId|id)>\s*(\d+)/i,
    /tmdb:\/\/(\d+)/i,
    /<tmdbId>\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function extractImdbId(block: string): string | null {
  const patterns = [
    /imdb\.com\/title\/(tt\d+)/i,
    /imdb:\/\/(tt\d+)/i,
    /<imdbId>\s*(tt\d+)/i,
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m) return m[1]!;
  }
  return null;
}

function pickGuid(block: string, title: string, year: number | null): string {
  const g = firstTag(block, 'guid') ?? firstTag(block, 'link') ?? firstTag(block, 'id');
  if (g) return g;
  return `${title.toLowerCase()}|${year ?? ''}`;
}

// Plex Watchlist RSS: movies AND shows. Item type comes from <category>, the
// plex:// guid path, or a <type> tag; defaults to movie. The title may carry a
// "(YYYY)" suffix.
export function parsePlexWatchlist(xml: string): WatchlistItem[] {
  const out: WatchlistItem[] = [];
  for (const block of extractItemBlocks(xml)) {
    const rawTitle = firstTag(block, 'title');
    if (!rawTitle) continue;
    const category = (firstTag(block, 'category') ?? '').toLowerCase();
    const typeTag = (firstTag(block, 'type') ?? '').toLowerCase();
    const tmdbId = extractTmdbId(block);
    // Authoritative per-item signals take precedence; only fall back to a
    // scavenged themoviedb.org/tv/ URL when neither movie nor TV is explicit,
    // so a stray tv link in a description can't flip an explicit movie.
    const explicitMovie = /\bmovie\b|\bfilm\b/.test(category) || /\bmovie\b|\bfilm\b/.test(typeTag) || /plex:\/\/movie|\/movie\//i.test(block);
    const explicitTv = /show|series|\btv\b|episode|season/.test(category) || /show|series/.test(typeTag) || /plex:\/\/show/i.test(block);
    let type: 'movie' | 'tv' = 'movie';
    if (explicitTv && !explicitMovie) type = 'tv';
    else if (!explicitTv && !explicitMovie && /themoviedb\.org\/tv\//i.test(block)) type = 'tv';
    const yearM = rawTitle.match(/\((\d{4})\)\s*$/);
    const yearTag = firstTag(block, 'year');
    const year = yearM ? Number.parseInt(yearM[1]!, 10) : yearTag ? Number.parseInt(yearTag, 10) : null;
    const title = rawTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    out.push({
      guid: pickGuid(block, title, year),
      title,
      year: Number.isFinite(year as number) ? (year as number) : null,
      type,
      tmdbId,
      imdbId: extractImdbId(block),
    });
  }
  return out;
}

// Letterboxd RSS (watchlist or any list): movies only. Title is "Film Name,
// YYYY"; the feed also carries letterboxd:filmTitle / letterboxd:filmYear and a
// <tmdb:movieId>.
export function parseLetterboxd(xml: string): WatchlistItem[] {
  const out: WatchlistItem[] = [];
  for (const block of extractItemBlocks(xml)) {
    const filmTitle = firstTag(block, 'letterboxd:filmTitle');
    const rawTitle = firstTag(block, 'title');
    const baseTitle = filmTitle ?? rawTitle;
    if (!baseTitle) continue;
    const filmYear = firstTag(block, 'letterboxd:filmYear');
    const yearFromTitle = (rawTitle ?? '').match(/,\s*(\d{4})\s*$/);
    const year = filmYear
      ? Number.parseInt(filmYear, 10)
      : yearFromTitle
      ? Number.parseInt(yearFromTitle[1]!, 10)
      : null;
    // When we fell back to the RSS <title> ("Name, YYYY"), strip the year suffix.
    const title = (filmTitle ?? baseTitle.replace(/,\s*\d{4}\s*$/, '')).trim();
    out.push({
      guid: pickGuid(block, title, year),
      title,
      year: Number.isFinite(year as number) ? (year as number) : null,
      type: 'movie',
      tmdbId: extractTmdbId(block),
      imdbId: extractImdbId(block),
    });
  }
  return out;
}

// Dispatch by source type.
export function parseFeed(type: 'plex' | 'letterboxd', xml: string): WatchlistItem[] {
  return type === 'letterboxd' ? parseLetterboxd(xml) : parsePlexWatchlist(xml);
}
