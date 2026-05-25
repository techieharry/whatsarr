import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { log } from './log.ts';
import type { Store } from './state/store.ts';
import * as seerr from './seerr/client.ts';

const log_ = log.child({ mod: 'diag' });

export type ValidationReport = {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
};

export type DiagnosisReport = {
  uptimeSec: number;
  validation: ValidationReport;
  audit: { totalLast24h: number; queuedLast24h: number; failedLast24h: number };
  pendingNotifications: number;
  recentErrors: string[];
};

// Validation: cheap, in-process checks of the things a user request touches.
// Each check has its own short timeout via Seerr's client; total budget ~5s.
export async function runValidation(store: Store): Promise<ValidationReport> {
  const checks: ValidationReport['checks'] = [];

  // 1. Seerr reachable
  try {
    const s = await seerr.status();
    checks.push({ name: 'seerr', ok: true, detail: `v${s.version}` });
  } catch (e: any) {
    checks.push({ name: 'seerr', ok: false, detail: e?.message ?? 'unreachable' });
  }

  // 2. DB write probe (round-trip a transient row to confirm WAL is healthy)
  try {
    const id = store.enqueuePending('__probe__@s.whatsapp.net', '__probe__');
    store.deletePending(id);
    checks.push({ name: 'db', ok: true });
  } catch (e: any) {
    checks.push({ name: 'db', ok: false, detail: e?.message ?? 'write failed' });
  }

  // 3. Webhook configured
  checks.push({
    name: 'webhook',
    ok: config.webhook.enabled,
    detail: config.webhook.enabled
      ? `${config.webhook.bind}:${config.webhook.port}`
      : 'disabled in config',
  });

  // 4. Pending backlog (informational, but flag if huge)
  const pending = store.countPending();
  checks.push({
    name: 'pending_drain',
    ok: pending < 20,
    detail: `${pending} pending`,
  });

  return { ok: checks.every(c => c.ok), checks };
}

// Diagnosis: validation + counters + last few error log lines.
export async function runDiagnosis(store: Store, opts: { logPath?: string } = {}): Promise<DiagnosisReport> {
  const validation = await runValidation(store);
  const since24h = Date.now() - 24 * 3600 * 1000;
  const audit = {
    totalLast24h: store.countAuditSince(since24h),
    queuedLast24h: store.countAuditByStatusSince('queued', since24h),
    failedLast24h: store.countAuditByStatusSince('failed', since24h),
  };
  return {
    uptimeSec: Math.round(process.uptime()),
    validation,
    audit,
    pendingNotifications: store.countPending(),
    recentErrors: readRecentErrors(opts.logPath ?? defaultLogPath(), 15),
  };
}

function defaultLogPath(): string {
  return resolve(process.cwd(), 'logs', 'service.out.log');
}

function readRecentErrors(path: string, n: number): string[] {
  try {
    const st = statSync(path);
    if (!st.isFile()) return [];
    // Read the tail of the file: cheap O(file_size) read; logs rotate at 10MB so worst-case is ~10MB.
    const buf = readFileSync(path, 'utf8');
    const lines = buf.split(/\r?\n/);
    const errs: string[] = [];
    for (let i = lines.length - 1; i >= 0 && errs.length < n; i--) {
      const line = lines[i];
      if (!line) continue;
      if (!line.includes('"level":50') && !line.includes('"level":40')) continue;
      try {
        const o = JSON.parse(line);
        const ts = typeof o.time === 'number' ? new Date(o.time).toISOString() : o.time ?? '';
        const mod = o.mod ?? o.class ?? '';
        const msg = o.msg ?? '';
        const err = o.err ? ` err=${o.err}` : '';
        errs.push(`${ts} [${mod}] ${msg}${err}`);
      } catch {
        errs.push(line.slice(0, 200));
      }
    }
    return errs.reverse();
  } catch (e: any) {
    log_.debug({ path, err: e?.message }, 'log tail read failed');
    return [];
  }
}

export function formatValidation(v: ValidationReport): string {
  const lines = [`*validation* — ${v.ok ? 'PASS ✓' : 'FAIL ✗'}`];
  for (const c of v.checks) {
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  }
  return lines.join('\n');
}

export function formatDiagnosis(d: DiagnosisReport): string {
  const lines: string[] = [
    `*diagnosis*`,
    `uptime: ${formatUptime(d.uptimeSec)}`,
    `audit (24h): ${d.audit.totalLast24h} total, ${d.audit.queuedLast24h} queued, ${d.audit.failedLast24h} failed`,
    `pending notifications: ${d.pendingNotifications}`,
    '',
    formatValidation(d.validation),
  ];
  if (d.recentErrors.length > 0) {
    lines.push('', '*recent warn/error log lines:*', '```', ...d.recentErrors, '```');
  } else {
    lines.push('', '_no recent warn/error log lines_');
  }
  return lines.join('\n');
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}
