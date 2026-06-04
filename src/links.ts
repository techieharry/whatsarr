// Detect shared film links in free-form chat so the bot can offer a one-tap
// queue WITHOUT nagging: index.ts reacts 🎬 to a detected link (a quiet signal,
// never a reply), and a user opts in per-title by quote-replying the link with
// `q` (handler.ts). Pure + dependency-free; the slug de-kebabs to a title that
// the normal Seerr search resolves at confirm-time, so nothing is stored.
//
// v1 supports Letterboxd film/review links (letterboxd.com/<user>/film/<slug>/).
// TMDb/IMDb could be added later, but Letterboxd is the live use case and is the
// only one whose URL yields a usable title without an extra API.

export type FilmLink = { source: 'letterboxd'; title: string; mediaType: 'movie' };

// /<user>/film/<slug>/  and  /film/<slug>/  and review form /<user>/film/<slug>/<id>/
// The leading negative-lookbehind anchors the host so look-alikes like
// evilletterboxd.com don't match (a real subdomain like www.letterboxd.com still
// does, since the preceding char is a dot).
const LETTERBOXD_FILM = /(?<![a-z0-9])letterboxd\.com\/(?:[^\/\s]+\/)?film\/([a-z0-9][a-z0-9-]*)/gi;

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseFilmLinks(text: string): FilmLink[] {
  if (!text) return [];
  const out: FilmLink[] = [];
  const seen = new Set<string>();
  // matchAll uses a fresh iterator per call — no shared lastIndex state to reset.
  for (const m of text.matchAll(LETTERBOXD_FILM)) {
    const slug = m[1]!.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    const title = slugToTitle(slug);
    // Letterboxd disambiguates duplicate titles by appending the year (dune-2021);
    // we de-kebab the whole slug and let the Seerr search + the confirm/picker
    // sort it out rather than risk stripping a real title number (blade-runner-2049).
    if (title) out.push({ source: 'letterboxd', title, mediaType: 'movie' });
  }
  return out;
}

export function hasFilmLink(text: string): boolean {
  return parseFilmLinks(text).length > 0;
}
