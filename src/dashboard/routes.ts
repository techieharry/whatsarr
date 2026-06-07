import type { IncomingMessage as IM, ServerResponse } from 'node:http';
import type { Store } from '../state/store.ts';
import * as seerrModule from '../seerr/client.ts';
import * as syncthingModule from '../syncthing/client.ts';
import { runDiagnosis } from '../diagnostics.ts';
import { INDEX_HTML, APP_JS, APP_CSS } from './assets.ts';
import { isCommandName, runCommand, type CommandDeps } from './commands.ts';

export type DashboardDeps = {
  store: Store;
  seerr: typeof seerrModule;
  syncthing: typeof syncthingModule;
  getConnectionStatus: () => { connected: boolean; uptimeSec: number };
  syncthingFolders: string[];
  send: (to: string, content: { text: string; mentions?: string[] }) => Promise<unknown>;
  drainPending: () => Promise<void>;
  reconnectWa: () => Promise<void>;
  shutdown: () => void;
};

const BOOTSTRAP_PLACEHOLDER = '__WHATSARR_BOOTSTRAP__';

const BOOTSTRAP_JSON = JSON.stringify({
  apiBase: '/api',
  features: { writeActions: true },
  pollIntervals: { heartbeat: 1000, active: 5000, static: 30000 },
});

const MAX_BODY_BYTES = 8 * 1024;

export async function dashboardRoute(req: IM, res: ServerResponse, deps: DashboardDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/dashboard' || path === '/dashboard/')) {
    const bootstrap = `<script>window.__WHATSARR__ = ${BOOTSTRAP_JSON};</script>`;
    const html = INDEX_HTML.includes(BOOTSTRAP_PLACEHOLDER)
      ? INDEX_HTML.replace(BOOTSTRAP_PLACEHOLDER, bootstrap)
      : INDEX_HTML + bootstrap;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && path === '/dashboard/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(APP_JS);
    return;
  }

  if (req.method === 'GET' && path === '/dashboard/app.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    res.end(APP_CSS);
    return;
  }

  if (req.method === 'GET' && path === '/api/heartbeat') {
    const c = deps.getConnectionStatus();
    sendJson(res, 200, {
      connected: c.connected,
      uptimeSec: c.uptimeSec,
      pendingCount: deps.store.countPending(),
      retryCount: deps.store.countRetryEligible(),
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/overview') {
    const diagnosis = await runDiagnosis(deps.store);
    sendJson(res, 200, { diagnosis, connection: deps.getConnectionStatus() });
    return;
  }

  if (req.method === 'GET' && path === '/api/audit') {
    const q = url.searchParams;
    const filters = {
      status: q.get('status') ?? undefined,
      senderNumber: q.get('user') ?? undefined,
      groupJid: q.get('group') ?? undefined,
      since: q.get('since') ? Number(q.get('since')) : undefined,
      until: q.get('until') ? Number(q.get('until')) : undefined,
      limit: q.get('limit') ? Number(q.get('limit')) : 50,
      offset: q.get('offset') ? Number(q.get('offset')) : 0,
    };
    const rows = deps.store.listAudit(filters);
    const total = deps.store.countAudit({
      status: filters.status,
      senderNumber: filters.senderNumber,
      groupJid: filters.groupJid,
      since: filters.since,
      until: filters.until,
    });
    sendJson(res, 200, { rows, total });
    return;
  }

  if (req.method === 'GET' && path === '/api/pending') {
    const rows = deps.store.listPending(50);
    sendJson(res, 200, { rows, total: deps.store.countPending() });
    return;
  }

  if (req.method === 'GET' && path === '/api/feedback') {
    const kindRaw = url.searchParams.get('kind');
    const kind = kindRaw === 'feedback' || kindRaw === 'issue' ? kindRaw : undefined;
    const rows = deps.store.listFeedback(kind, 100);
    sendJson(res, 200, { rows });
    return;
  }

  if (req.method === 'GET' && path === '/api/syncthing') {
    if (!deps.syncthing.isConfigured()) {
      sendJson(res, 200, { configured: false });
      return;
    }
    const ping = await deps.syncthing.ping();
    const folders: { id: string; completion: unknown; status: unknown; error?: string }[] = [];
    for (const id of deps.syncthingFolders) {
      try {
        const [completion, status] = await Promise.all([
          deps.syncthing.getCompletion(id),
          deps.syncthing.getFolderStatus(id),
        ]);
        folders.push({ id, completion, status });
      } catch (e: any) {
        folders.push({ id, completion: null, status: null, error: e?.message ?? 'error' });
      }
    }
    sendJson(res, 200, { configured: true, ping, folders });
    return;
  }

  if (req.method === 'GET' && path === '/api/tasks') {
    sendJson(res, 200, { rows: deps.store.listCommands(50) });
    return;
  }

  if (req.method === 'GET' && path === '/api/seerr/pending') {
    try {
      const rows = await deps.seerr.listPendingRequests(20);
      // Enrich with the WhatsApp requester when we have an audit row for the
      // same media, so the panel can show "Haris" / the number instead of just
      // the Seerr display name.
      const enriched = rows.map(r => {
        const requester = deps.store.findRequester(r.mediaType, r.tmdbId);
        return { ...r, waNumber: requester?.senderNumber ?? null };
      });
      sendJson(res, 200, { rows: enriched });
    } catch (e: any) {
      sendJson(res, 502, { error: e?.message ?? 'seerr pending failed' });
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/conversations') {
    sendJson(res, 200, { rows: deps.store.listActiveConversations() });
    return;
  }

  const seerrApprove = path.match(/^\/api\/seerr\/request\/(\d+)\/approve$/);
  if (req.method === 'POST' && seerrApprove) {
    const id = Number(seerrApprove[1]);
    try {
      await deps.seerr.approveRequest(id);
      const audit = deps.store.findAuditBySeerrRequestId(id);
      if (audit) deps.store.updateAudit(audit.id, { status: 'approved' });
      sendJson(res, 200, { id, ok: true });
    } catch (e: any) {
      sendJson(res, 502, { id, error: e?.message ?? 'approve failed' });
    }
    return;
  }

  const seerrDeny = path.match(/^\/api\/seerr\/request\/(\d+)\/deny$/);
  if (req.method === 'POST' && seerrDeny) {
    const id = Number(seerrDeny[1]);
    try {
      await deps.seerr.declineRequest(id);
      sendJson(res, 200, { id, ok: true });
    } catch (e: any) {
      sendJson(res, 502, { id, error: e?.message ?? 'deny failed' });
    }
    return;
  }

  const seerrRetry = path.match(/^\/api\/seerr\/request\/(\d+)\/retry$/);
  if (req.method === 'POST' && seerrRetry) {
    const id = Number(seerrRetry[1]);
    try {
      await deps.seerr.retryRequest(id);
      const audit = deps.store.findAuditBySeerrRequestId(id);
      if (audit) deps.store.markRetrySucceeded(audit.id);
      sendJson(res, 200, { id, ok: true });
    } catch (e: any) {
      sendJson(res, 502, { id, error: e?.message ?? 'retry failed' });
    }
    return;
  }

  const pendingRetry = path.match(/^\/api\/pending\/(\d+)\/retry$/);
  if (req.method === 'POST' && pendingRetry) {
    const id = Number(pendingRetry[1]);
    const row = deps.store.listPending(1000).find(r => r.id === id);
    if (!row) {
      sendJson(res, 404, { id, error: 'not found' });
      return;
    }
    try {
      await deps.send(row.targetJid, { text: row.text, mentions: row.mentions });
      deps.store.deletePending(id);
      sendJson(res, 200, { id, ok: true });
    } catch (e: any) {
      const msg = e?.message ?? 'send failed';
      deps.store.markPendingFailed(id, msg);
      sendJson(res, 502, { error: msg });
    }
    return;
  }

  const pendingDelete = path.match(/^\/api\/pending\/(\d+)\/delete$/);
  if (req.method === 'POST' && pendingDelete) {
    const id = Number(pendingDelete[1]);
    deps.store.deletePending(id);
    sendJson(res, 200, { id, deleted: true });
    return;
  }

  // Resolve / dismiss a feedback or issue, then close the loop with the reporter.
  const fbResolve = path.match(/^\/api\/feedback\/(\d+)\/(resolve|wontfix)$/);
  if (req.method === 'POST' && fbResolve) {
    const id = Number(fbResolve[1]);
    const status = fbResolve[2] === 'wontfix' ? 'wontfix' : 'resolved';
    let note: string | null = null;
    try {
      const body = await readJsonBody(req);
      const n = (body as any)?.note;
      note = typeof n === 'string' && n.trim() ? n.trim() : null;
    } catch { /* note is optional */ }
    const row = deps.store.resolveFeedback(id, status, 'dashboard', note);
    if (!row) {
      sendJson(res, 404, { id, error: 'not found' });
      return;
    }
    // Close the loop: DM the original reporter (best-effort — don't fail the action).
    let reporterNotified = false;
    if (row.senderJid) {
      const verb = status === 'resolved' ? 'resolved ✓' : "closed (won't fix)";
      const noteStr = row.resolution ? `\n\n> ${row.resolution}` : '';
      try {
        await deps.send(row.senderJid, { text: `Update on your ${row.kind} #${row.id}: *${verb}*.${noteStr}` });
        reporterNotified = true;
      } catch { /* reporter DM is best-effort */ }
    }
    sendJson(res, 200, { id, status, reporterNotified });
    return;
  }

  if (req.method === 'POST' && path === '/api/commands') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
      const status = e?.message === 'body too large' ? 413 : 400;
      sendJson(res, status, { error: e?.message ?? 'invalid json' });
      return;
    }
    const name = (body as any)?.name;
    const args = (body as any)?.args;
    if (typeof name !== 'string' || !isCommandName(name)) {
      sendJson(res, 400, { error: 'unknown command' });
      return;
    }
    const id = deps.store.enqueueCommand(name, args);
    const cmdDeps: CommandDeps = {
      store: deps.store,
      seerr: deps.seerr,
      send: deps.send,
      drainPending: deps.drainPending,
      reconnectWa: deps.reconnectWa,
      shutdown: deps.shutdown,
    };
    queueMicrotask(() => { void runCommand(id, name, args, cmdDeps); });
    sendJson(res, 202, { id, name, status: 'queued' });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IM): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      buf += c;
      if (buf.length > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (aborted) return;
      if (buf === '') { resolve(undefined); return; }
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
