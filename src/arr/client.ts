import { config } from '../config.ts';
import { log } from '../log.ts';
import { getArrServers, type ArrServer } from '../seerr/client.ts';

const log_ = log.child({ mod: 'arr' });

export type ArrType = 'radarr' | 'sonarr';

const REQUEST_TIMEOUT_MS = 10_000;
const SERVER_CACHE_TTL_MS = 10 * 60_000;

// Hostnames Seerr uses to reach the *arr from INSIDE its Docker container. From
// the whatsarr host they don't resolve to the *arr, so rewrite them to the Seerr
// host (the *arr ports are published on the same box Seerr runs on).
const DOCKER_HOSTS = new Set(['host.docker.internal', 'gateway.docker.internal', 'localhost', '127.0.0.1']);

type ResolvedServer = { base: string; apiKey: string };

// Small per-type TTL cache so a burst of !prioritize calls doesn't re-hit Seerr
// settings each time. Module-level state is fine for the long-lived service;
// tests inject a mock arr dep and never touch this.
const cache: Record<ArrType, { at: number; servers: ArrServer[] } | undefined> = {
  radarr: undefined,
  sonarr: undefined,
};

function seerrHost(): string {
  try { return new URL(config.seerr.url).hostname; } catch { return '127.0.0.1'; }
}

function buildBase(s: ArrServer): string {
  let host = s.hostname;
  if (DOCKER_HOSTS.has(host.toLowerCase())) host = seerrHost();
  const scheme = s.useSsl ? 'https' : 'http';
  const path = s.baseUrl ? (s.baseUrl.startsWith('/') ? s.baseUrl : `/${s.baseUrl}`) : '';
  return `${scheme}://${host}:${s.port}${path}`.replace(/\/$/, '');
}

// Explicit .env override (RADARR_URL/SONARR_URL + key). Empty by default — the
// normal path is auto-discovery from Seerr. Use this only when the docker-host
// rewrite can't reach the *arr (e.g. it lives on a different box).
function envOverride(type: ArrType): ResolvedServer | null {
  const c = type === 'radarr' ? config.radarr : config.sonarr;
  if (c.url && c.apiKey) return { base: c.url.replace(/\/$/, ''), apiKey: c.apiKey };
  return null;
}

async function servers(type: ArrType): Promise<ArrServer[]> {
  const hit = cache[type];
  if (hit && Date.now() - hit.at < SERVER_CACHE_TTL_MS) return hit.servers;
  const list = await getArrServers(type);
  // Only cache a non-empty result. A transient Seerr hiccup makes getArrServers
  // return [] — caching that would pin the feature "off" for the full TTL even
  // after Seerr recovers a second later. An empty list is retried next call.
  if (list.length) cache[type] = { at: Date.now(), servers: list };
  return list;
}

// Resolve which *arr to call for a given Seerr serverId. With more than one
// server (e.g. an HD + a 4k Radarr), route by the request's serverId so the call
// lands on the box that actually holds the item. The env override is the
// single-box escape hatch, so it only wins when there's at most one discovered
// server (or none — e.g. discovery is down but an override is set).
async function resolve(type: ArrType, serverId: number | null): Promise<ResolvedServer | null> {
  const override = envOverride(type);
  const list = await servers(type);
  if (override && list.length <= 1) return override;
  if (serverId !== null) {
    const match = list.find(x => x.id === serverId);
    if (match?.apiKey) return { base: buildBase(match), apiKey: match.apiKey };
  }
  if (override) return override;
  const s = list.find(x => x.isDefault) ?? list[0];
  return s?.apiKey ? { base: buildBase(s), apiKey: s.apiKey } : null;
}

// True when prioritize can work at all — an override is set, or Seerr has at
// least one Radarr/Sonarr server. Cheap (cached). Lets the handler/diagnostics
// distinguish "not set up" from a transient failure.
export async function isConfigured(): Promise<boolean> {
  if (envOverride('radarr') || envOverride('sonarr')) return true;
  const [r, s] = await Promise.all([servers('radarr'), servers('sonarr')]);
  return r.length > 0 || s.length > 0;
}

async function call(base: string, apiKey: string, path: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`arr ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 150)}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? res.json() : res.text();
  } finally {
    clearTimeout(timer);
  }
}

export type ForceSearchResult = { commandId: number; server: ArrType };

// Trigger an immediate search/grab for an already-added movie/series — this is
// what "prioritize" does: skip the RSS-sync wait and grab the best release now.
// Movies -> Radarr MoviesSearch; TV -> Sonarr SeriesSearch (all monitored eps).
// Throws if no server resolves or the *arr rejects the command.
export async function forceSearch(
  mediaType: 'movie' | 'tv',
  itemId: number,
  serverId: number | null,
): Promise<ForceSearchResult> {
  const type: ArrType = mediaType === 'movie' ? 'radarr' : 'sonarr';
  const srv = await resolve(type, serverId);
  if (!srv) throw new Error(`no ${type} server available (check Seerr's ${type} settings)`);
  const body = type === 'radarr'
    ? { name: 'MoviesSearch', movieIds: [itemId] }
    : { name: 'SeriesSearch', seriesId: itemId };
  const r = await call(srv.base, srv.apiKey, '/api/v3/command', { method: 'POST', body: JSON.stringify(body) });
  log_.info({ type, itemId, commandId: r?.id }, 'force-search triggered');
  return { commandId: Number(r?.id ?? 0), server: type };
}
