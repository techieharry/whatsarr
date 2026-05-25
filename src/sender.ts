import type { WASocket } from '@whiskeysockets/baileys';
import { log } from './log.ts';

const log_ = log.child({ mod: 'sender' });

export type SendContent = { text: string; mentions?: string[] } | { image: { url: string }; caption: string; mentions?: string[] };

// Baileys can briefly drop the WA Web socket and reconnect within a few
// seconds; sends during that gap fail with "Connection Closed" / "attrs" /
// 428. We retry a few times with backoff. If all attempts fail, the caller
// decides whether to drop (regular reply — chat moved on) or enqueue
// (webhook-driven notification — must be delivered).
export function isTransientSendError(e: any): boolean {
  const msg = String(e?.message ?? '');
  return (
    msg.includes('Connection Closed') ||
    msg.includes('Connection was lost') ||
    msg.includes("reading 'attrs'") ||
    e?.output?.statusCode === 428
  );
}

export async function sendWithRetry(
  sock: WASocket,
  to: string,
  content: SendContent,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 2000;
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      await sock.sendMessage(to, content as any);
      return;
    } catch (e: any) {
      lastErr = e;
      if (!isTransientSendError(e) || i === attempts - 1) throw e;
      const delay = base * (i + 1);
      log_.warn({ err: e?.message, to, attempt: i + 1, nextDelayMs: delay }, 'transient send failure, backing off');
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
