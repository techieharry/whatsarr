import type { Category } from '../parser/commands.ts';

export type MediaType = 'movie' | 'tv';

export type Route = {
  rootFolder: string;
  profileId: number;
  profileName: string;
};

const PLEX = 'Z:\\Shared Files\\PLEX';

export const MOVIE_ROUTES: Partial<Record<Category, Route>> = {
  western:     { rootFolder: `${PLEX}\\Movies\\Requested Western Movies`,           profileId: 7,  profileName: 'HD Bluray+WEB' },
  bollywood:   { rootFolder: `${PLEX}\\Movies\\Requested Bollywood Movies`,         profileId: 7,  profileName: 'HD Bluray+WEB' },
  pakistani:   { rootFolder: `${PLEX}\\Movies\\Requested Pakistani Movies`,         profileId: 7,  profileName: 'HD Bluray+WEB' },
  foreign:     { rootFolder: `${PLEX}\\Movies\\Requested Foreign Movies`,           profileId: 7,  profileName: 'HD Bluray+WEB' },
  documentary: { rootFolder: `${PLEX}\\Movies\\Requested Documentary Movies`,       profileId: 7,  profileName: 'HD Bluray+WEB' },
  anime:       { rootFolder: `${PLEX}\\Movies\\Requested Animated Movies\\Eastern`, profileId: 11, profileName: 'REMUX-1080p - Anime' },
  animated:    { rootFolder: `${PLEX}\\Movies\\Requested Animated Movies\\Western`, profileId: 7,  profileName: 'HD Bluray+WEB' },
};

export const TV_ROUTES: Partial<Record<Category, Route>> = {
  western:     { rootFolder: `${PLEX}\\TV Shows\\Requested Western Shows`,           profileId: 7, profileName: 'WEB-DL (1080p)' },
  documentary: { rootFolder: `${PLEX}\\TV Shows\\Requested Documentary Shows`,       profileId: 7, profileName: 'WEB-DL (1080p)' },
  bollywood:   { rootFolder: `${PLEX}\\TV Shows\\Requested Bollywood Shows`,         profileId: 7, profileName: 'WEB-DL (1080p)' },
  asian:       { rootFolder: `${PLEX}\\TV Shows\\Requested Asian Shows`,             profileId: 7, profileName: 'WEB-DL (1080p)' },
  anime:       { rootFolder: `${PLEX}\\TV Shows\\Requested Animated Shows\\Eastern`, profileId: 9, profileName: 'Remux-1080p - Anime' },
  animated:    { rootFolder: `${PLEX}\\TV Shows\\Requested Animated Shows\\Western`, profileId: 7, profileName: 'WEB-DL (1080p)' },
};

// Defense in depth: any rootFolder matching this regex MUST never be used,
// even if a future config change accidentally adds it. Override this for
// your setup with patterns matching personal/curated library folder names
// the bot should never write to. Example below; edit to match your layout.
export const FORBIDDEN_PATH = /(My Personal Collection|Curated|Archive)/;

export type ResolveResult =
  | { ok: true; mediaType: MediaType; category: Category; route: Route }
  | { ok: false; reason: string };

export function resolveRoute(mediaType: MediaType, category: Category | null): ResolveResult {
  const cat = category ?? 'western';
  const table = mediaType === 'movie' ? MOVIE_ROUTES : TV_ROUTES;
  const route = table[cat];
  if (!route) {
    return { ok: false, reason: `category "${cat}" not valid for ${mediaType}` };
  }
  if (FORBIDDEN_PATH.test(route.rootFolder)) {
    throw new Error(
      `routing refused: ${mediaType}/${cat} maps to forbidden path "${route.rootFolder}"`,
    );
  }
  return { ok: true, mediaType, category: cat, route };
}
