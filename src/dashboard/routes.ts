import type { IncomingMessage as IM, ServerResponse } from 'node:http';
import type { Store } from '../state/store.ts';
import * as seerrModule from '../seerr/client.ts';
import * as syncthingModule from '../syncthing/client.ts';
import { runDiagnosis } from '../diagnostics.ts';
import { INDEX_HTML, APP_JS, APP_CSS } from './assets.ts';

export type DashboardDeps = {
  store: Store;
  seerr: typeof seerrModule;
  syncthing: typeof syncthingModule;
  getConnectionStatus: () => { connected: boolean; uptimeSec: number };
  syncthingFolders: string[];
};

const BOOTSTRAP_PLACEHOLDER = '__WHATSARR_BOOTSTRAP__';

const BOOTSTRAP_JSON = JSON.stringify({
  apiBase: '/api',
  features: { writeActions: false },
  pollIntervals: { heartbeat: 1000, active: 5000, static: 30000 },
});

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

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
