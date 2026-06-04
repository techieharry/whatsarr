// Plex-Pass-FREE watchlist reader. Plex gates only the rss.plex.tv feed mint
// behind Plex Pass; the underlying Discover REST + Community GraphQL APIs (the
// same ones the official apps use) are free for any Plex account. So with ONE
// owner/admin Plex token we can read the owner's OWN watchlist and, crucially,
// the watchlists of the owner's Plex FRIENDS — the friend never hands over a
// credential (they only need to be a confirmed Plex friend with their watchlist
// visible to friends).
//
// Mechanics verified against jamcalli/Pulsarr, nylonee/watchlistarr, and Seerr
// issue #1378:
//   friends:   POST community.plex.tv/api  GetAllFriends { allFriendsV2 }
//   watchlist: POST community.plex.tv/api  GetWatchlistHub(userV2(id).watchlist)
//   self:      GET  discover.provider.plex.tv/library/sections/watchlist/all
//   enrich:    GET  discover.provider.plex.tv/library/metadata/<id> -> Guid[]
// List calls return NO external ids (guids:[]), so each item needs an N+1 enrich
// to reach a tmdbId — the caller mitigates this by enriching only UNSEEN items.
//
// The token is account-level: kept in env only, sent solely as the X-Plex-Token
// HEADER (never a query string, never logged).

import { log } from '../log.ts';

const log_ = log.child({ mod: 'plex' });

const FETCH_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const INTER_PAGE_DELAY_MS = 3_000;   // Plex asks callers to space watchlist pages out
const MAX_RETRIES = 3;
const ENRICH_EMPTY_RETRIES = 3;      // Plex sometimes returns a metadata stub before guids populate

export type PlexNode = { id: string; title: string; type: 'movie' | 'tv' };
export type PlexEnriched = { tmdbId: number | null; imdbId: string | null; year: number | null };
export type PlexFriend = { id: string; username: string };

export type PlexClient = {
  listFriends(): Promise<PlexFriend[]>;
  friendWatchlist(userId: string): Promise<PlexNode[]>;
  selfWatchlist(): Promise<PlexNode[]>;
  enrich(nodeId: string): Promise<PlexEnriched>;
};

export type PlexConfig = {
  token: string;
  clientId: string;
  discoverHost: string;
  communityHost: string;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function mapType(t: string | undefined): 'movie' | 'tv' {
  return String(t).toLowerCase() === 'show' || String(t).toLowerCase() === 'tv' ? 'tv' : 'movie';
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms.
function retryAfterMs(h: string | null): number {
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

export function makePlexClient(cfg: PlexConfig): PlexClient {
  let cooldownUntil = 0;   // shared across calls — back off the owner's real token politely

  async function plexFetch(url: string, init: RequestInit): Promise<Response> {
    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            'X-Plex-Token': cfg.token,
            'X-Plex-Client-Identifier': cfg.clientId,
            'User-Agent': 'whatsarr-watchlist',
            Accept: 'application/json',
            ...(init.headers ?? {}),
          },
        });
        if (res.status === 429) {
          const backoff = retryAfterMs(res.headers.get('retry-after')) || Math.min(30_000, 2_000 * 2 ** (attempt - 1));
          cooldownUntil = Date.now() + backoff;
          if (attempt < MAX_RETRIES) { continue; }
          throw new Error('plex 429 rate limited');
        }
        if (!res.ok) throw new Error(`plex HTTP ${res.status}`);
        return res;
      } catch (e: any) {
        lastErr = e;
        if (attempt === MAX_RETRIES) throw e;
        await sleep(Math.min(10_000, 1_000 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function graphql(query: string, variables?: Record<string, unknown>): Promise<any> {
    const res = await plexFetch(`${cfg.communityHost}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
    const j = await res.json();
    if (j.errors) throw new Error(`plex graphql: ${JSON.stringify(j.errors).slice(0, 200)}`);
    return j.data;
  }

  async function listFriends(): Promise<PlexFriend[]> {
    const data = await graphql('query GetAllFriends { allFriendsV2 { user { id username } } }');
    const out: PlexFriend[] = [];
    for (const f of data?.allFriendsV2 ?? []) {
      const u = f?.user;
      if (u?.id) out.push({ id: String(u.id), username: String(u.username ?? '') });
    }
    return out;
  }

  async function friendWatchlist(userId: string): Promise<PlexNode[]> {
    const query =
      'query GetWatchlistHub ($user: UserInput!, $first: PaginationInt!, $after: String) {' +
      ' userV2(user: $user) { ... on User { watchlist(first: $first, after: $after) {' +
      ' nodes { id title type } pageInfo { hasNextPage endCursor } } } } }';
    const out: PlexNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < 50; page++) {   // hard page cap, safety
      const data = await graphql(query, { user: { id: userId }, first: PAGE_SIZE, after });
      const wl = data?.userV2?.watchlist;
      for (const n of wl?.nodes ?? []) {
        if (n?.id) out.push({ id: String(n.id), title: String(n.title ?? ''), type: mapType(n.type) });
      }
      if (!wl?.pageInfo?.hasNextPage) break;
      after = wl.pageInfo.endCursor;
      await sleep(INTER_PAGE_DELAY_MS);
    }
    return out;
  }

  async function selfWatchlist(): Promise<PlexNode[]> {
    const out: PlexNode[] = [];
    for (let start = 0; start < 50 * PAGE_SIZE; start += PAGE_SIZE) {
      const url = `${cfg.discoverHost}/library/sections/watchlist/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}`;
      const res = await plexFetch(url, { method: 'GET' });
      const j = await res.json();
      const mc = j?.MediaContainer;
      const items = mc?.Metadata ?? [];
      for (const m of items) {
        const ratingKey = String(m.ratingKey ?? (m.key ?? '').replace('/library/metadata/', '').replace('/children', ''));
        if (ratingKey) out.push({ id: ratingKey, title: String(m.title ?? ''), type: mapType(m.type) });
      }
      const total = Number(mc?.totalSize ?? items.length);
      if (start + items.length >= total || items.length === 0) break;
      await sleep(INTER_PAGE_DELAY_MS);
    }
    return out;
  }

  async function enrich(nodeId: string): Promise<PlexEnriched> {
    for (let attempt = 1; attempt <= ENRICH_EMPTY_RETRIES; attempt++) {
      const res = await plexFetch(`${cfg.discoverHost}/library/metadata/${encodeURIComponent(nodeId)}`, { method: 'GET' });
      const j = await res.json();
      const m = j?.MediaContainer?.Metadata?.[0];
      const guids: string[] = (m?.Guid ?? []).map((g: any) => String(g?.id ?? ''));
      const tmdb = guids.find(g => g.startsWith('tmdb://'));
      const imdb = guids.find(g => g.startsWith('imdb://'));
      const tmdbId = tmdb ? Number.parseInt(tmdb.slice('tmdb://'.length), 10) : null;
      const year = m?.year != null ? Number(m.year) : null;
      // Plex occasionally returns a stub with no guids; retry a couple times.
      if (guids.length === 0 && attempt < ENRICH_EMPTY_RETRIES) {
        await sleep(Math.min(5_000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      return {
        tmdbId: Number.isFinite(tmdbId as number) && (tmdbId as number) > 0 ? (tmdbId as number) : null,
        imdbId: imdb ? imdb.slice('imdb://'.length) : null,
        year: Number.isFinite(year as number) ? (year as number) : null,
      };
    }
    return { tmdbId: null, imdbId: null, year: null };
  }

  return { listFriends, friendWatchlist, selfWatchlist, enrich };
}
