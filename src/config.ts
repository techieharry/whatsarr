import 'dotenv/config';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}
function optional(key: string, def: string): string {
  return process.env[key] ?? def;
}
function num(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${key}="${v}" is not an integer`);
  return n;
}

function normalizeNumber(s: string): string {
  return s.trim().replace(/^\+/, '').replace(/[\s-]/g, '');
}

// Resolve the set of Syncthing folder IDs the dashboard #syncthing panel shows.
// Prefer the explicit plural list (SYNCTHING_FOLDERS=a,b,c); fall back to the
// single folder the `!sync` command uses (SYNCTHING_FOLDER_ID) so the panel
// isn't blank when only the singular var is set. Empty when neither is set.
export function resolveSyncthingFolders(foldersCsv: string, folderId: string): string[] {
  const explicit = foldersCsv.split(',').map(s => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  return folderId ? [folderId] : [];
}

// A configured watchlist/list feed the poller pulls from. `owner` is a WhatsApp
// number: it's the identity each synced request is audited/attributed under
// (via the existing user_map / SEERR_DEFAULT_USER_ID) and the JID the "now
// ready" notification is DM'd to. `label` is cosmetic (logs/audit command text).
export type WatchlistSource = {
  // 'plex'|'letterboxd' = RSS feeds (url is the feed). 'plex-friend'|'plex-self'
  // = the Pass-free Plex path (url is plexfriend://<userId> / plexself://, read
  // via the owner token, not a feed). WATCHLIST_SOURCES env only accepts the
  // first two; the plex-* kinds come from the DB / PLEX_FRIEND_MAP.
  type: 'plex' | 'letterboxd' | 'plex-friend' | 'plex-self';
  url: string;
  owner: string;        // normalized WhatsApp number (digits only)
  label: string;
};

// Feed-URL safety: only the two known public feed hosts, over https. This is the
// main guardrail for member self-service (!watchlist add) — it blocks SSRF to
// internal hosts and arbitrary feeds. Returns the normalized URL, or throws a
// short human-readable reason (shown to the user by the !watchlist handler, and
// at startup by parseWatchlistSources).
export function validateFeedUrl(type: 'plex' | 'letterboxd', url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error('not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('URL must be https');
  const host = u.hostname.toLowerCase();
  const ok = type === 'plex'
    ? host === 'rss.plex.tv'
    : host === 'letterboxd.com' || host.endsWith('.letterboxd.com');
  if (!ok) throw new Error(`host "${host}" not allowed for ${type} (expected ${type === 'plex' ? 'rss.plex.tv' : 'letterboxd.com'})`);
  return u.toString();
}

// A Plex-friend → WhatsApp-number mapping (PLEX_FRIEND_MAP). The Pass-free Plex
// path reads friends' watchlists with the owner token; this says which WhatsApp
// number a given friend's requests attribute to (and get the ready-DM). Identify
// the friend by plexUsername (resolved to a Plex user id at poll time) and/or a
// plexUserId; at least one is required.
export type PlexFriendMapEntry = {
  plexUsername: string | null;
  plexUserId: string | null;
  owner: string;   // normalized WhatsApp number
  label: string;
};

export function parsePlexFriendMap(json: string): PlexFriendMapEntry[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e: any) {
    throw new Error(`PLEX_FRIEND_MAP is not valid JSON: ${e?.message ?? e}`);
  }
  if (!Array.isArray(raw)) throw new Error('PLEX_FRIEND_MAP must be a JSON array');
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`PLEX_FRIEND_MAP[${i}] must be an object`);
    const e = entry as Record<string, unknown>;
    const plexUsername = e.plexUsername != null ? String(e.plexUsername).trim() : '';
    const plexUserId = e.plexUserId != null ? String(e.plexUserId).trim() : '';
    if (!plexUsername && !plexUserId) {
      throw new Error(`PLEX_FRIEND_MAP[${i}] needs plexUsername or plexUserId`);
    }
    const owner = normalizeNumber(String(e.owner ?? ''));
    if (!owner) throw new Error(`PLEX_FRIEND_MAP[${i}].owner (a WhatsApp number) is required`);
    const label = String(e.label ?? '').trim() || `plex:${plexUsername || plexUserId}`;
    return { plexUsername: plexUsername || null, plexUserId: plexUserId || null, owner, label };
  });
}

// Parse WATCHLIST_SOURCES (a JSON array) into validated sources. Empty/unset ⇒
// []. Throws on malformed JSON or invalid entries so misconfiguration fails
// fast at startup, consistent with the rest of this loader.
export function parseWatchlistSources(json: string): WatchlistSource[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e: any) {
    throw new Error(`WATCHLIST_SOURCES is not valid JSON: ${e?.message ?? e}`);
  }
  if (!Array.isArray(raw)) throw new Error('WATCHLIST_SOURCES must be a JSON array');
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`WATCHLIST_SOURCES[${i}] must be an object`);
    const e = entry as Record<string, unknown>;
    const type = String(e.type ?? '').toLowerCase();
    if (type !== 'plex' && type !== 'letterboxd') {
      throw new Error(`WATCHLIST_SOURCES[${i}].type must be "plex" or "letterboxd"`);
    }
    const rawUrl = String(e.url ?? '').trim();
    if (!rawUrl) throw new Error(`WATCHLIST_SOURCES[${i}].url is required`);
    let url: string;
    try {
      url = validateFeedUrl(type, rawUrl);
    } catch (err: any) {
      throw new Error(`WATCHLIST_SOURCES[${i}].url ${err?.message ?? err}`);
    }
    const owner = normalizeNumber(String(e.owner ?? ''));
    if (!owner) throw new Error(`WATCHLIST_SOURCES[${i}].owner (a WhatsApp number) is required`);
    const label = String(e.label ?? '').trim() || `${type}:${owner}`;
    return { type, url, owner, label };
  });
}

const ALLOWED_GROUPS = required('ALLOWED_GROUPS').split(',').map(s => s.trim()).filter(Boolean);
// Optional friendly names for the !announce target picker, comma-separated and
// positional (aligned to ALLOWED_GROUPS order). Missing entries fall back to JID.
const GROUP_LABELS = optional('GROUP_LABELS', '').split(',');

export const config = {
  seerr: {
    url: required('SEERR_URL').replace(/\/$/, ''),
    apiKey: required('SEERR_API_KEY'),
    defaultUserId: num('SEERR_DEFAULT_USER_ID', 1),
    webhookSecret: optional('SEERR_WEBHOOK_SECRET', ''),
  },
  whatsapp: {
    allowedGroups: ALLOWED_GROUPS,
    groupLabels: Object.fromEntries(
      ALLOWED_GROUPS.map((jid, i) => [jid, (GROUP_LABELS[i] ?? '').trim() || jid]),
    ) as Record<string, string>,
    adminNumbers: optional('ADMIN_NUMBERS', '').split(',').map(normalizeNumber).filter(Boolean),
    commandPrefix: optional('COMMAND_PREFIX', '!'),
  },
  limits: {
    requestsPerDay: num('REQUESTS_PER_DAY', 5),
    dedupWindowHours: num('DEDUP_WINDOW_HOURS', 1),
    confirmTtlMinutes: num('CONFIRM_TTL_MINUTES', 10),
  },
  webhook: {
    enabled: optional('WEBHOOK_ENABLED', 'true') === 'true',
    port: num('WEBHOOK_PORT', 5056),
    bind: optional('WEBHOOK_BIND', '127.0.0.1'),
    // Per-IP fixed-window (60s) rate limit on POST /webhook. Generous default —
    // Seerr posts a handful per day, so legit traffic never trips it. 0 disables.
    rateLimit: num('WEBHOOK_RATE_LIMIT', 60),
    // Coalesce window for repeat MEDIA_AVAILABLE events on the same media (Seerr
    // re-fires as episodes/seasons land). A burst within this window flushes as
    // exactly one fan-out. 0 = flush immediately (tests).
    readyCoalesceMs: num('WEBHOOK_READY_COALESCE_MS', 45_000),
  },
  storage: {
    dbPath: optional('DB_PATH', 'data/whatsarr.sqlite'),
    authDir: optional('AUTH_DIR', 'auth_info_baileys'),
  },
  logLevel: optional('LOG_LEVEL', 'info'),
  // Optional: !sync command surfaces Syncthing's per-folder completion to a
  // remote device (a Plex box on the other end of the link). All vars are
  // optional; if url/apiKey are empty, src/syncthing/client.ts treats syncthing
  // as disabled.
  syncthing: {
    url: optional('SYNCTHING_URL', '').replace(/\/$/, ''),
    apiKey: optional('SYNCTHING_API_KEY', ''),
    folderId: optional('SYNCTHING_FOLDER_ID', ''),
    folders: resolveSyncthingFolders(optional('SYNCTHING_FOLDERS', ''), optional('SYNCTHING_FOLDER_ID', '')),
    remoteDeviceId: optional('SYNCTHING_REMOTE_DEVICE_ID', ''),
    remoteLabel: optional('SYNCTHING_REMOTE_LABEL', 'remote'),
  },
  dashboard: {
    token: optional('DASHBOARD_TOKEN', ''),
  },
  // Optional: watchlist auto-sync. The poller reads Plex Watchlist and/or
  // Letterboxd RSS feeds and funnels new items through the same search → route →
  // request → subscribe path as a chat request, so they inherit routing, audit,
  // dedup, and the "now ready" notification. Disabled when no sources are set.
  // maxPerRun bounds how many *new* items are processed (resolved against Seerr)
  // per poll — anti-flood for Sonarr/skyhook and a predictable trickle for large
  // backlogs. Already-seen items are skipped for free and don't count toward it.
  watchlist: {
    // Operator-seeded feeds (optional). Members add their own at runtime via
    // !watchlist add (stored in the DB) — see store.listWatchlistSources().
    sources: parseWatchlistSources(optional('WATCHLIST_SOURCES', '')),
    pollMinutes: num('WATCHLIST_POLL_MINUTES', 15),
    // Clamp to ≥1 so a stray 0 can't silently wedge the poller (0 >= 0 caps
    // every run). Set WATCHLIST_POLL_MINUTES=0 to disable the feature instead.
    maxPerRun: Math.max(1, num('WATCHLIST_MAX_PER_RUN', 10)),
    // Whether allow-listed members may self-register their own feeds over
    // WhatsApp (!watchlist add). Admins can always manage feeds regardless.
    selfService: optional('WATCHLIST_SELF_SERVICE', 'true') === 'true',
    // Cap on how many feeds one member may register (anti-abuse).
    maxSourcesPerMember: Math.max(1, num('WATCHLIST_MAX_SOURCES_PER_MEMBER', 5)),
  },
  // Plex-Pass-FREE watchlist path. With ONE owner Plex token, the poller reads
  // the owner's own + friends' Plex watchlists via the free Discover/Community
  // APIs (no RSS, no Plex Pass). Empty token ⇒ the plex-friend/plex-self source
  // types are skipped. The token is account-level — keep it in .env only.
  plex: {
    token: optional('PLEX_TOKEN', ''),
    clientId: optional('PLEX_CLIENT_IDENTIFIER', 'whatsarr'),
    discoverHost: optional('PLEX_DISCOVER_HOST', 'https://discover.provider.plex.tv').replace(/\/$/, ''),
    communityHost: optional('PLEX_COMMUNITY_HOST', 'https://community.plex.tv').replace(/\/$/, ''),
    friends: parsePlexFriendMap(optional('PLEX_FRIEND_MAP', '')),
  },
};

export type Config = typeof config;
