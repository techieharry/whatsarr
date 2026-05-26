import type { IncomingMessage as IM, ServerResponse } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export type AuthResult = { ok: true } | { ok: false; status: number; body: string };

export function authGate(req: IM, _res: ServerResponse, token: string): AuthResult {
  if (token === '') return { ok: false, status: 503, body: 'dashboard disabled' };

  const remote = req.socket.remoteAddress ?? '';
  if (LOOPBACK.has(remote)) return { ok: true };

  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7) === token) {
    return { ok: true };
  }

  const cookieToken = parseCookie(req.headers['cookie']).get('whatsarr_token');
  if (cookieToken === token) return { ok: true };

  const url = new URL(req.url ?? '/', 'http://x');
  if (url.searchParams.get('token') === token) return { ok: true };

  return { ok: false, status: 401, body: 'unauthorized' };
}

export function maybeSetTokenCookie(req: IM, res: ServerResponse, token: string): void {
  if (token === '') return;
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('token');
  if (q !== token) return;
  res.setHeader(
    'Set-Cookie',
    `whatsarr_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
  );
}

function parseCookie(header: string | string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return m;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) m.set(k, v);
  }
  return m;
}
