export type MediaTypeHint = 'movie' | 'tv' | 'ambiguous';

export type Category =
  | 'western'
  | 'bollywood'
  | 'pakistani'
  | 'foreign'
  | 'documentary'
  | 'asian'
  | 'anime'
  | 'animated';

export type AdminAction = 'approve' | 'deny' | 'pending' | 'shutdown';

export type ParsedCommand =
  | { kind: 'request'; mediaTypeHint: MediaTypeHint; category: Category | null; title: string }
  | { kind: 'status' }
  | { kind: 'queue' }
  | { kind: 'help' }
  | { kind: 'sync' }
  | { kind: 'feedback'; body: string }
  | { kind: 'issue'; body: string }
  | { kind: 'admin'; action: AdminAction; requestId: number | null }
  | { kind: 'map'; op: 'set' | 'unset' | 'list'; number: string | null; seerrUserId: number | null }
  | { kind: 'watchlist'; op: 'guide' | 'add' | 'list' | 'remove'; wlType: 'plex' | 'letterboxd' | 'plex-friend' | null; url: string | null; id: number | null }
  | { kind: 'announce'; body: string }
  | { kind: 'links'; op: 'on' | 'off' | 'status' }
  | { kind: 'incomplete'; cmd: string; reason: string }
  | { kind: 'unknown'; reason: string };

// Strip a leading '+' and any spaces/dashes so '+1 555-555-0101' and
// '15555550101' map to the same key the rest of the system uses (digits only).
function normalizeNumberToken(token: string | undefined): string {
  return (token ?? '').replace(/^\+/, '').replace(/[\s-]/g, '');
}

const CATEGORY_ALIASES: Record<string, Category> = {
  western: 'western',
  bollywood: 'bollywood', bolly: 'bollywood', hindi: 'bollywood',
  pakistani: 'pakistani', pak: 'pakistani', urdu: 'pakistani',
  foreign: 'foreign', intl: 'foreign',
  documentary: 'documentary', doc: 'documentary', docu: 'documentary',
  asian: 'asian', kdrama: 'asian', cdrama: 'asian', jdrama: 'asian',
  anime: 'anime',
  animated: 'animated', cartoon: 'animated',
};

const MOVIE_CMDS = new Set(['movie', 'film']);
const TV_CMDS = new Set(['tv', 'show', 'series']);
const REQ_CMDS = new Set(['req', 'request']);

export function parse(input: string, prefix = '!'): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith(prefix)) {
    return { kind: 'unknown', reason: 'no prefix' };
  }

  const tokens = trimmed.slice(prefix.length).trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') {
    return { kind: 'unknown', reason: 'empty command' };
  }

  const cmd = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === 'status') return { kind: 'status' };
  if (cmd === 'queue' || cmd === 'mine') return { kind: 'queue' };
  if (cmd === 'help') return { kind: 'help' };
  if (cmd === 'sync' || cmd === 'syncstatus') return { kind: 'sync' };
  if (cmd === 'feedback' || cmd === 'fb') {
    const body = rest.join(' ').trim();
    if (!body) return { kind: 'incomplete', cmd: 'feedback', reason: 'feedback needs a message' };
    return { kind: 'feedback', body };
  }
  if (cmd === 'issue' || cmd === 'bug' || cmd === 'report') {
    const body = rest.join(' ').trim();
    if (!body) return { kind: 'incomplete', cmd: 'issue', reason: 'issue needs a description' };
    return { kind: 'issue', body };
  }

  // Admin commands. Caller MUST check isAdmin() before executing.
  if (cmd === 'pending') return { kind: 'admin', action: 'pending', requestId: null };
  if (cmd === 'shutdown' || cmd === 'restart') {
    return { kind: 'admin', action: 'shutdown', requestId: null };
  }
  if (cmd === 'approve' || cmd === 'deny' || cmd === 'decline') {
    const action: AdminAction = cmd === 'approve' ? 'approve' : 'deny';
    if (rest.length === 0) return { kind: 'incomplete', cmd, reason: `${cmd} needs a request id` };
    const id = Number.parseInt(rest[0]!, 10);
    if (!Number.isFinite(id) || id < 1) {
      return { kind: 'incomplete', cmd, reason: `${cmd} needs a numeric request id` };
    }
    return { kind: 'admin', action, requestId: id };
  }

  // Toggle the ambient film-link 🎬 suggestion for the sender. `!links off`
  // silences it; `!links on` re-enables; `!links` shows status.
  if (cmd === 'links') {
    const sub = (rest[0] ?? '').toLowerCase();
    if (sub === 'off' || sub === 'mute' || sub === 'stop') return { kind: 'links', op: 'off' };
    if (sub === 'on' || sub === 'unmute') return { kind: 'links', op: 'on' };
    return { kind: 'links', op: 'status' };
  }

  // Broadcast a message to all allowed groups (admin). Caller MUST check
  // isAdmin() before executing. The body keeps its original formatting/newlines
  // (not whitespace-collapsed) so multi-line announcements come through intact.
  if (cmd === 'announce' || cmd === 'broadcast') {
    if (rest.length === 0) return { kind: 'incomplete', cmd: 'announce', reason: 'usage: !announce <message>' };
    const body = trimmed.replace(/^\S+\s+/, '').trim();   // strip the !announce token, keep the rest verbatim
    if (!body) return { kind: 'incomplete', cmd: 'announce', reason: 'usage: !announce <message>' };
    return { kind: 'announce', body };
  }

  // Per-user Seerr account mapping (admin). `!map` / `!map list` lists; `!map
  // <number> <seerrUserId>` sets; `!unmap <number>` removes. Caller MUST check
  // isAdmin() before executing.
  if (cmd === 'unmap') {
    const number = normalizeNumberToken(rest[0]);
    if (!number) return { kind: 'incomplete', cmd: 'unmap', reason: 'usage: !unmap <whatsapp number>' };
    return { kind: 'map', op: 'unset', number, seerrUserId: null };
  }
  if (cmd === 'map') {
    if (rest.length === 0 || rest[0]!.toLowerCase() === 'list') {
      return { kind: 'map', op: 'list', number: null, seerrUserId: null };
    }
    const number = normalizeNumberToken(rest[0]);
    const seerrUserId = Number.parseInt(rest[1] ?? '', 10);
    if (!number || !Number.isFinite(seerrUserId) || seerrUserId < 1) {
      return { kind: 'incomplete', cmd: 'map', reason: 'usage: !map <whatsapp number> <seerr user id>' };
    }
    return { kind: 'map', op: 'set', number, seerrUserId };
  }

  // Watchlist auto-sync self-service. `!watchlist` (or `!wl`) with no args shows
  // the guide; `add <plex|letterboxd> <url>` registers a feed; `list` shows your
  // feeds; `remove <id>` drops one. Owner is the sender (handler fills it in).
  if (cmd === 'watchlist' || cmd === 'wl') {
    const sub = (rest[0] ?? '').toLowerCase();
    if (!sub || sub === 'help' || sub === 'guide') {
      return { kind: 'watchlist', op: 'guide', wlType: null, url: null, id: null };
    }
    if (sub === 'list' || sub === 'ls') {
      return { kind: 'watchlist', op: 'list', wlType: null, url: null, id: null };
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      const id = Number.parseInt(rest[1] ?? '', 10);
      if (!Number.isFinite(id) || id < 1) {
        return { kind: 'incomplete', cmd: 'watchlist', reason: 'usage: !watchlist remove <id>' };
      }
      return { kind: 'watchlist', op: 'remove', wlType: null, url: null, id };
    }
    if (sub === 'add') {
      const typeRaw = (rest[1] ?? '').toLowerCase();
      const wlType = typeRaw === 'plex' ? 'plex'
        : (typeRaw === 'letterboxd' || typeRaw === 'lb') ? 'letterboxd'
        : (typeRaw === 'plex-friend' || typeRaw === 'plexfriend' || typeRaw === 'pf') ? 'plex-friend'
        : null;
      // For plex/letterboxd the 3rd token is a feed URL; for plex-friend it's the
      // member's Plex username (no feed, no credential).
      const url = rest[2] ?? '';
      if (!wlType || !url) {
        return { kind: 'incomplete', cmd: 'watchlist', reason: 'usage: !watchlist add <plex|letterboxd> <feed url>  ·  or: !watchlist add plex-friend <your plex username>' };
      }
      return { kind: 'watchlist', op: 'add', wlType, url, id: null };
    }
    return { kind: 'incomplete', cmd: 'watchlist', reason: 'usage: !watchlist [add <plex|letterboxd> <url> | add plex-friend <plex username> | list | remove <id>]' };
  }

  let mediaTypeHint: MediaTypeHint;
  if (MOVIE_CMDS.has(cmd)) mediaTypeHint = 'movie';
  else if (TV_CMDS.has(cmd)) mediaTypeHint = 'tv';
  else if (REQ_CMDS.has(cmd)) mediaTypeHint = 'ambiguous';
  else return { kind: 'unknown', reason: `unknown command: ${cmd}` };

  if (rest.length === 0) {
    return { kind: 'incomplete', cmd, reason: `${cmd} needs a title` };
  }

  const maybeCat = rest[0]!.toLowerCase();
  const category = CATEGORY_ALIASES[maybeCat] ?? null;
  const title = (category ? rest.slice(1) : rest).join(' ').trim();

  if (!title) {
    return { kind: 'incomplete', cmd, reason: `${cmd} ${maybeCat} needs a title` };
  }

  return { kind: 'request', mediaTypeHint, category, title };
}
