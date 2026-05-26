import { config } from '../config.ts';
import { log } from '../log.ts';

const log_ = log.child({ mod: 'seerr' });

export type SearchResult = {
  id: number;
  mediaType: 'movie' | 'tv' | 'person' | 'collection';
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  posterPath?: string | null;
  // mediaInfo is present when Seerr already knows about the item (in its DB
  // because someone requested it before, or because Plex has it). Absent
  // means it's never been requested.
  mediaInfo?: { status?: number; status4k?: number };
};

export type CreateRequestArgs = {
  mediaType: 'movie' | 'tv';
  mediaId: number;
  rootFolder: string;
  profileId: number;
  userId?: number;
  seasons?: 'all' | number[];
};

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

// Treat as transient: connection refused/reset, DNS, timeout, or 5xx.
// Tailnet hiccups (Seerr's Docker container momentarily unreachable) are
// what we mostly see in prod, and those resolve in <1s.
function isTransientSeerrError(e: any, status?: number): boolean {
  if (status !== undefined) return status >= 500;
  const msg = String(e?.message ?? e ?? '');
  const cause = String(e?.cause?.code ?? e?.code ?? '');
  return (
    msg === 'fetch failed' ||
    cause === 'ECONNREFUSED' ||
    cause === 'ECONNRESET' ||
    cause === 'ETIMEDOUT' ||
    cause === 'ENOTFOUND' ||
    cause === 'EAI_AGAIN' ||
    cause === 'UND_ERR_SOCKET' ||
    e?.name === 'AbortError' ||
    e?.name === 'TimeoutError'
  );
}

async function call(path: string, init?: RequestInit): Promise<any> {
  const url = `${config.seerr.url}${path}`;
  let lastErr: any;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'X-Api-Key': config.seerr.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        const body = await res.text();
        if (isTransientSeerrError(null, res.status) && attempt < RETRY_ATTEMPTS) {
          const delay = RETRY_BASE_DELAY_MS * attempt;
          log_.warn({ path, status: res.status, attempt, nextDelayMs: delay }, 'seerr 5xx; retrying');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        log_.error({ path, status: res.status, body }, 'seerr error');
        throw new Error(`Seerr ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 200)}`);
      }
      if (res.status === 204) return null;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) return res.json();
      return res.text();
    } catch (e: any) {
      lastErr = e;
      if (!isTransientSeerrError(e) || attempt === RETRY_ATTEMPTS) throw e;
      const delay = RETRY_BASE_DELAY_MS * attempt;
      log_.warn({ path, err: e?.message, attempt, nextDelayMs: delay }, 'seerr transient error; retrying');
      await new Promise(r => setTimeout(r, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function status(): Promise<{ version: string; commitTag: string; updateAvailable: boolean }> {
  return call('/api/v1/status');
}

export async function search(query: string): Promise<SearchResult[]> {
  const j = await call(`/api/v1/search?query=${encodeURIComponent(query)}&page=1`);
  return (j.results ?? []).filter(
    (r: any) => r.mediaType === 'movie' || r.mediaType === 'tv',
  );
}

export type DownloadProgress = {
  size: number;
  sizeLeft: number;
  estimatedCompletionTime: string | null;
};

export type MediaInfo = {
  status: number;
  downloadStatus: DownloadProgress[];
};

// Status enum (Seerr / Overseerr):
// 1 UNKNOWN, 2 PENDING, 3 PROCESSING (downloading), 4 PARTIALLY_AVAILABLE,
// 5 AVAILABLE, 6 BLACKLISTED, 7 DELETED
export async function getMediaInfo(mediaType: 'movie' | 'tv', tmdbId: number): Promise<MediaInfo | null> {
  try {
    const j = await call(`/api/v1/${mediaType}/${tmdbId}`);
    if (!j?.mediaInfo) return null;
    return {
      status: j.mediaInfo.status,
      downloadStatus: j.mediaInfo.downloadStatus ?? [],
    };
  } catch (e: any) {
    log_.warn({ tmdbId, err: e?.message }, 'getMediaInfo failed');
    return null;
  }
}

export type TvDetails = {
  numberOfSeasons: number;
  seasons: { seasonNumber: number; episodeCount: number; name?: string }[];
};

// Seerr returns the full TMDb TV record with all seasons; we filter out
// season 0 (Specials), which most users don't mean by "all".
export async function getTvDetails(tmdbId: number): Promise<TvDetails | null> {
  try {
    const j = await call(`/api/v1/tv/${tmdbId}`);
    if (!j) return null;
    const seasons = (j.seasons ?? [])
      .filter((s: any) => Number(s.seasonNumber) > 0)
      .map((s: any) => ({
        seasonNumber: Number(s.seasonNumber),
        episodeCount: Number(s.episodeCount ?? 0),
        name: s.name,
      }));
    const numberOfSeasons = Number(j.numberOfSeasons ?? seasons.length);
    return { numberOfSeasons, seasons };
  } catch (e: any) {
    log_.warn({ tmdbId, err: e?.message }, 'getTvDetails failed');
    return null;
  }
}

export type PendingRequest = {
  id: number;
  status: number;          // 1 pending, 2 approved, 3 declined
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;           // best-effort, "Unknown" if Seerr returns no media metadata
  requestedBy: string;     // display name or username
  createdAt: string;       // ISO timestamp
};

// Seerr's request status enum on the request object (NOT the mediaInfo enum):
// 1 PENDING_APPROVAL, 2 APPROVED, 3 DECLINED. We only list status=1.
export async function listPendingRequests(limit = 20): Promise<PendingRequest[]> {
  const j = await call(`/api/v1/request?take=${limit}&filter=pending&sort=added`);
  const out: PendingRequest[] = [];
  for (const r of j?.results ?? []) {
    const m = r.media ?? {};
    const tmdbId = Number(m.tmdbId ?? 0);
    out.push({
      id: Number(r.id),
      status: Number(r.status ?? 0),
      mediaType: (m.mediaType === 'tv' ? 'tv' : 'movie'),
      tmdbId,
      title: String(m.title ?? m.name ?? 'Unknown'),
      requestedBy: String(r.requestedBy?.displayName ?? r.requestedBy?.username ?? '?'),
      createdAt: String(r.createdAt ?? ''),
    });
  }
  return out;
}

// Seerr decision endpoints. Both return the updated request object on success.
export async function approveRequest(id: number): Promise<{ id: number }> {
  return call(`/api/v1/request/${id}/approve`, { method: 'POST' });
}

export async function declineRequest(id: number): Promise<{ id: number }> {
  return call(`/api/v1/request/${id}/decline`, { method: 'POST' });
}

// Re-fires Sonarr/Radarr push for a Failed request. Seerr sets status back to
// APPROVED and re-runs the create-series call, so transient skyhook timeouts
// can succeed on a subsequent attempt.
export async function retryRequest(id: number): Promise<{ id: number }> {
  return call(`/api/v1/request/${id}/retry`, { method: 'POST' });
}

export async function createRequest(args: CreateRequestArgs): Promise<{ id: number }> {
  const body: Record<string, unknown> = {
    mediaType: args.mediaType,
    mediaId: args.mediaId,
    rootFolder: args.rootFolder,
    profileId: args.profileId,
    userId: args.userId ?? config.seerr.defaultUserId,
  };
  if (args.mediaType === 'tv') body.seasons = args.seasons ?? 'all';
  return call('/api/v1/request', { method: 'POST', body: JSON.stringify(body) });
}
