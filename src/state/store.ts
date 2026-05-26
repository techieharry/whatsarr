import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AwaitingKind = 'confirm' | 'movie_or_tv' | 'pick' | 'season';

export type ConversationState = {
  awaiting: AwaitingKind;
  payload: unknown;
  expiresAt: number;
};

export type AuditEntry = {
  senderJid: string;
  senderNumber: string;
  groupJid: string | null;
  command: string;
  resolvedRoute?: string | null;
  seerrMediaType?: string | null;
  seerrMediaId?: number | null;
  seerrRequestId?: number | null;
  status: string;
};

export class Store {
  private db: Database.Database;

  constructor(path = 'data/whatsarr.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_state (
        sender_jid TEXT PRIMARY KEY,
        awaiting   TEXT NOT NULL,
        payload    TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quotas (
        sender_number TEXT NOT NULL,
        day           TEXT NOT NULL,
        count         INTEGER NOT NULL,
        PRIMARY KEY (sender_number, day)
      );
      CREATE TABLE IF NOT EXISTS dedup (
        sender_number    TEXT NOT NULL,
        media_type       TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        ts               INTEGER NOT NULL,
        PRIMARY KEY (sender_number, media_type, normalized_title)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                INTEGER NOT NULL,
        sender_jid        TEXT NOT NULL,
        sender_number     TEXT NOT NULL,
        group_jid         TEXT,
        command           TEXT NOT NULL,
        resolved_route    TEXT,
        seerr_media_type  TEXT,
        seerr_media_id    INTEGER,
        seerr_request_id  INTEGER,
        status            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_media_lookup
        ON audit(seerr_media_type, seerr_media_id);
      CREATE TABLE IF NOT EXISTS pending_notification (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        target_jid  TEXT NOT NULL,
        text        TEXT NOT NULL,
        mentions    TEXT,
        created_at  INTEGER NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        sender_jid    TEXT NOT NULL,
        sender_number TEXT NOT NULL,
        group_jid     TEXT,
        body          TEXT NOT NULL,
        report        TEXT
      );
      CREATE TABLE IF NOT EXISTS commands (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'queued',
        args_json   TEXT,
        result      TEXT,
        error       TEXT,
        started_at  INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_commands_status_ts ON commands(status, ts DESC);
    `);
    // Idempotent column adds for audit retry tracking (2026-05-26).
    // SQLite has no IF NOT EXISTS for ALTER ADD COLUMN; check pragma_table_info.
    const cols = this.db.prepare(`PRAGMA table_info(audit)`).all() as any[];
    const have = new Set(cols.map(c => c.name));
    if (!have.has('retry_attempts')) {
      this.db.exec(`ALTER TABLE audit ADD COLUMN retry_attempts INTEGER NOT NULL DEFAULT 0`);
    }
    if (!have.has('last_retry_at')) {
      this.db.exec(`ALTER TABLE audit ADD COLUMN last_retry_at INTEGER`);
    }
  }

  enqueuePending(target: string, text: string, mentions?: string[]): number {
    const r = this.db.prepare(`
      INSERT INTO pending_notification(target_jid, text, mentions, created_at)
      VALUES (?, ?, ?, ?)
    `).run(target, text, mentions ? JSON.stringify(mentions) : null, Date.now());
    return Number(r.lastInsertRowid);
  }

  listPending(limit = 50): { id: number; targetJid: string; text: string; mentions: string[] | undefined; attempts: number }[] {
    const rows = this.db.prepare(
      `SELECT id, target_jid AS targetJid, text, mentions, attempts
       FROM pending_notification ORDER BY id ASC LIMIT ?`,
    ).all(limit) as any[];
    return rows.map(r => ({
      id: r.id,
      targetJid: r.targetJid,
      text: r.text,
      mentions: r.mentions ? JSON.parse(r.mentions) : undefined,
      attempts: r.attempts,
    }));
  }

  countPending(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM pending_notification`).get() as any;
    return r?.c ?? 0;
  }

  markPendingFailed(id: number, err: string): void {
    this.db.prepare(
      `UPDATE pending_notification SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
    ).run(err, id);
  }

  deletePending(id: number): void {
    this.db.prepare(`DELETE FROM pending_notification WHERE id = ?`).run(id);
  }

  // Drop notifications that have failed too many times to keep table bounded.
  reapDeadPending(maxAttempts: number): number {
    const r = this.db.prepare(
      `DELETE FROM pending_notification WHERE attempts >= ?`,
    ).run(maxAttempts);
    return Number(r.changes);
  }

  recordFeedback(e: { kind: 'feedback' | 'issue'; senderJid: string; senderNumber: string; groupJid: string | null; body: string; report: string | null }): number {
    const r = this.db.prepare(`
      INSERT INTO feedback(ts, kind, sender_jid, sender_number, group_jid, body, report)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(Date.now(), e.kind, e.senderJid, e.senderNumber, e.groupJid, e.body, e.report);
    return Number(r.lastInsertRowid);
  }

  countAuditByStatusSince(status: string, sinceMs: number): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS c FROM audit WHERE status = ? AND ts >= ?`,
    ).get(status, sinceMs) as any;
    return r?.c ?? 0;
  }

  countAuditSince(sinceMs: number): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM audit WHERE ts >= ?`).get(sinceMs) as any;
    return r?.c ?? 0;
  }

  setState(jid: string, state: ConversationState): void {
    this.db.prepare(`
      INSERT INTO conversation_state(sender_jid, awaiting, payload, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sender_jid) DO UPDATE SET
        awaiting = excluded.awaiting,
        payload = excluded.payload,
        expires_at = excluded.expires_at
    `).run(jid, state.awaiting, JSON.stringify(state.payload), state.expiresAt);
  }

  getState(jid: string): ConversationState | null {
    const row = this.db.prepare(
      `SELECT awaiting, payload, expires_at FROM conversation_state
       WHERE sender_jid = ? AND expires_at > ?`,
    ).get(jid, Date.now()) as any;
    if (!row) return null;
    return {
      awaiting: row.awaiting,
      payload: JSON.parse(row.payload),
      expiresAt: row.expires_at,
    };
  }

  clearState(jid: string): void {
    this.db.prepare(`DELETE FROM conversation_state WHERE sender_jid = ?`).run(jid);
  }

  cleanupExpiredState(): void {
    this.db.prepare(`DELETE FROM conversation_state WHERE expires_at <= ?`).run(Date.now());
  }

  getQuota(senderNumber: string): number {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db.prepare(
      `SELECT count FROM quotas WHERE sender_number = ? AND day = ?`,
    ).get(senderNumber, day) as any;
    return row?.count ?? 0;
  }

  bumpQuota(senderNumber: string): number {
    const day = new Date().toISOString().slice(0, 10);
    this.db.prepare(`
      INSERT INTO quotas(sender_number, day, count) VALUES (?, ?, 1)
      ON CONFLICT(sender_number, day) DO UPDATE SET count = count + 1
    `).run(senderNumber, day);
    return this.getQuota(senderNumber);
  }

  recordDedup(senderNumber: string, mediaType: string, title: string): void {
    const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
    this.db.prepare(`
      INSERT INTO dedup(sender_number, media_type, normalized_title, ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sender_number, media_type, normalized_title) DO UPDATE SET ts = excluded.ts
    `).run(senderNumber, mediaType, normalized, Date.now());
  }

  recentDedup(senderNumber: string, mediaType: string, title: string, withinMs: number): boolean {
    const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
    const cutoff = Date.now() - withinMs;
    const row = this.db.prepare(
      `SELECT ts FROM dedup
       WHERE sender_number = ? AND media_type = ? AND normalized_title = ? AND ts >= ?`,
    ).get(senderNumber, mediaType, normalized, cutoff) as any;
    return !!row;
  }

  audit(e: AuditEntry): number {
    const result = this.db.prepare(`
      INSERT INTO audit(ts, sender_jid, sender_number, group_jid, command,
                        resolved_route, seerr_media_type, seerr_media_id,
                        seerr_request_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      e.senderJid,
      e.senderNumber,
      e.groupJid,
      e.command,
      e.resolvedRoute ?? null,
      e.seerrMediaType ?? null,
      e.seerrMediaId ?? null,
      e.seerrRequestId ?? null,
      e.status,
    );
    return Number(result.lastInsertRowid);
  }

  updateAudit(id: number, fields: { seerrRequestId?: number | null; status?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.seerrRequestId !== undefined) { sets.push('seerr_request_id = ?'); vals.push(fields.seerrRequestId); }
    if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE audit SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getUserRequests(senderNumber: string, limit = 10): { command: string; seerrMediaType: string | null; seerrMediaId: number | null; status: string; ts: number }[] {
    return this.db.prepare(
      `SELECT command, seerr_media_type AS seerrMediaType, seerr_media_id AS seerrMediaId, status, ts
       FROM audit
       WHERE sender_number = ?
       ORDER BY ts DESC
       LIMIT ?`,
    ).all(senderNumber, limit) as any;
  }

  // Failed-request retry queue. Returns Whatsarr-originated audit rows whose
  // Seerr request landed as 'failed', have remaining attempts, and whose last
  // retry (if any) was far enough ago given exponential-backoff per-attempt.
  // Caller passes the schedule (ms-per-attempt-index, 0-indexed) so the policy
  // stays config-driven.
  listFailedForRetry(maxAttempts: number, backoffSchedule: number[]): { auditId: number; seerrRequestId: number; attempts: number; senderJid: string; senderNumber: string; groupJid: string | null; display: string }[] {
    const rows = this.db.prepare(
      `SELECT id, seerr_request_id, retry_attempts, last_retry_at,
              sender_jid, sender_number, group_jid, command
       FROM audit
       WHERE status = 'failed'
         AND seerr_request_id IS NOT NULL
         AND retry_attempts < ?
       ORDER BY ts ASC`,
    ).all(maxAttempts) as any[];
    const now = Date.now();
    const out: { auditId: number; seerrRequestId: number; attempts: number; senderJid: string; senderNumber: string; groupJid: string | null; display: string }[] = [];
    for (const r of rows) {
      const attempts = Number(r.retry_attempts ?? 0);
      const backoff = backoffSchedule[Math.min(attempts, backoffSchedule.length - 1)] ?? 0;
      if (r.last_retry_at && now - Number(r.last_retry_at) < backoff) continue;
      out.push({
        auditId: Number(r.id),
        seerrRequestId: Number(r.seerr_request_id),
        attempts,
        senderJid: r.sender_jid,
        senderNumber: r.sender_number,
        groupJid: r.group_jid ?? null,
        display: String(r.command ?? ''),
      });
    }
    return out;
  }

  // After a successful /retry call. We optimistically flip status back to
  // 'queued'; if Seerr fails it again the webhook + audit reconciliation will
  // restore 'failed' on the next pass.
  markRetrySucceeded(auditId: number): void {
    this.db.prepare(
      `UPDATE audit SET status = 'queued', retry_attempts = retry_attempts + 1,
                        last_retry_at = ? WHERE id = ?`,
    ).run(Date.now(), auditId);
  }

  // After a failed /retry call (network error, 404, etc.). Bumps attempt count
  // without changing status, so the row remains eligible for the next pass —
  // up to max_attempts.
  markRetryFailed(auditId: number): void {
    this.db.prepare(
      `UPDATE audit SET retry_attempts = retry_attempts + 1, last_retry_at = ? WHERE id = ?`,
    ).run(Date.now(), auditId);
  }

  listAudit(filters: {
    status?: string;
    senderNumber?: string;
    groupJid?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  } = {}): {
    id: number;
    ts: number;
    senderJid: string;
    senderNumber: string;
    groupJid: string | null;
    command: string;
    resolvedRoute: string | null;
    seerrMediaType: string | null;
    seerrMediaId: number | null;
    seerrRequestId: number | null;
    status: string;
    retryAttempts: number;
    lastRetryAt: number | null;
  }[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filters.status !== undefined) { where.push('status = ?'); vals.push(filters.status); }
    if (filters.senderNumber !== undefined) { where.push('sender_number = ?'); vals.push(filters.senderNumber); }
    if (filters.groupJid !== undefined) { where.push('group_jid = ?'); vals.push(filters.groupJid); }
    if (filters.since !== undefined) { where.push('ts >= ?'); vals.push(filters.since); }
    if (filters.until !== undefined) { where.push('ts <= ?'); vals.push(filters.until); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const rows = this.db.prepare(
      `SELECT id, ts, sender_jid AS senderJid, sender_number AS senderNumber,
              group_jid AS groupJid, command,
              resolved_route AS resolvedRoute,
              seerr_media_type AS seerrMediaType,
              seerr_media_id AS seerrMediaId,
              seerr_request_id AS seerrRequestId,
              status,
              retry_attempts AS retryAttempts,
              last_retry_at AS lastRetryAt
       FROM audit ${whereSql}
       ORDER BY ts DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...vals, limit, offset) as any[];
    return rows.map(r => ({
      id: Number(r.id),
      ts: Number(r.ts),
      senderJid: r.senderJid,
      senderNumber: r.senderNumber,
      groupJid: r.groupJid ?? null,
      command: r.command,
      resolvedRoute: r.resolvedRoute ?? null,
      seerrMediaType: r.seerrMediaType ?? null,
      seerrMediaId: r.seerrMediaId != null ? Number(r.seerrMediaId) : null,
      seerrRequestId: r.seerrRequestId != null ? Number(r.seerrRequestId) : null,
      status: r.status,
      retryAttempts: Number(r.retryAttempts ?? 0),
      lastRetryAt: r.lastRetryAt != null ? Number(r.lastRetryAt) : null,
    }));
  }

  countAudit(filters: {
    status?: string;
    senderNumber?: string;
    groupJid?: string;
    since?: number;
    until?: number;
  } = {}): number {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filters.status !== undefined) { where.push('status = ?'); vals.push(filters.status); }
    if (filters.senderNumber !== undefined) { where.push('sender_number = ?'); vals.push(filters.senderNumber); }
    if (filters.groupJid !== undefined) { where.push('group_jid = ?'); vals.push(filters.groupJid); }
    if (filters.since !== undefined) { where.push('ts >= ?'); vals.push(filters.since); }
    if (filters.until !== undefined) { where.push('ts <= ?'); vals.push(filters.until); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM audit ${whereSql}`).get(...vals) as any;
    return r?.c ?? 0;
  }

  listFeedback(kind?: 'feedback' | 'issue', limit = 100): {
    id: number;
    ts: number;
    kind: string;
    senderJid: string;
    senderNumber: string;
    groupJid: string | null;
    body: string;
    report: string | null;
  }[] {
    const rows = kind
      ? this.db.prepare(
          `SELECT id, ts, kind, sender_jid AS senderJid, sender_number AS senderNumber,
                  group_jid AS groupJid, body, report
           FROM feedback WHERE kind = ? ORDER BY ts DESC LIMIT ?`,
        ).all(kind, limit) as any[]
      : this.db.prepare(
          `SELECT id, ts, kind, sender_jid AS senderJid, sender_number AS senderNumber,
                  group_jid AS groupJid, body, report
           FROM feedback ORDER BY ts DESC LIMIT ?`,
        ).all(limit) as any[];
    return rows.map(r => ({
      id: Number(r.id),
      ts: Number(r.ts),
      kind: r.kind,
      senderJid: r.senderJid,
      senderNumber: r.senderNumber,
      groupJid: r.groupJid ?? null,
      body: r.body,
      report: r.report ?? null,
    }));
  }

  countRetryEligible(): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS c FROM audit WHERE status = 'failed' AND seerr_request_id IS NOT NULL`,
    ).get() as any;
    return r?.c ?? 0;
  }

  findRequester(seerrMediaType: string, seerrMediaId: number): { senderJid: string; senderNumber: string; groupJid: string | null } | null {
    const row = this.db.prepare(
      `SELECT sender_jid, sender_number, group_jid FROM audit
       WHERE seerr_media_type = ? AND seerr_media_id = ? AND status = 'queued'
       ORDER BY ts DESC LIMIT 1`,
    ).get(seerrMediaType, seerrMediaId) as any;
    if (!row) return null;
    return { senderJid: row.sender_jid, senderNumber: row.sender_number, groupJid: row.group_jid };
  }

  findAuditBySeerrRequestId(seerrRequestId: number): { id: number; senderNumber: string; senderJid: string; groupJid: string | null; status: string } | null {
    const row = this.db.prepare(
      `SELECT id, sender_number AS senderNumber, sender_jid AS senderJid,
              group_jid AS groupJid, status
       FROM audit WHERE seerr_request_id = ? ORDER BY ts DESC, id DESC LIMIT 1`,
    ).get(seerrRequestId) as any;
    if (!row) return null;
    return {
      id: Number(row.id),
      senderNumber: row.senderNumber,
      senderJid: row.senderJid,
      groupJid: row.groupJid ?? null,
      status: row.status,
    };
  }

  enqueueCommand(name: string, args?: Record<string, unknown>): number {
    const r = this.db.prepare(
      `INSERT INTO commands(ts, name, status, args_json)
       VALUES (?, ?, 'queued', ?)`,
    ).run(Date.now(), name, args ? JSON.stringify(args) : null);
    return Number(r.lastInsertRowid);
  }

  markCommandRunning(id: number): void {
    this.db.prepare(
      `UPDATE commands SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(Date.now(), id);
  }

  completeCommand(id: number, result?: string): void {
    this.db.prepare(
      `UPDATE commands SET status = 'succeeded', finished_at = ?, result = ? WHERE id = ?`,
    ).run(Date.now(), result ?? null, id);
  }

  failCommand(id: number, err: string): void {
    this.db.prepare(
      `UPDATE commands SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
    ).run(Date.now(), err, id);
  }

  listCommands(limit = 50): {
    id: number;
    ts: number;
    name: string;
    status: string;
    argsJson: string | null;
    result: string | null;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
  }[] {
    const rows = this.db.prepare(
      `SELECT id, ts, name, status, args_json AS argsJson, result, error,
              started_at AS startedAt, finished_at AS finishedAt
       FROM commands ORDER BY ts DESC, id DESC LIMIT ?`,
    ).all(limit) as any[];
    return rows.map(r => ({
      id: Number(r.id),
      ts: Number(r.ts),
      name: r.name,
      status: r.status,
      argsJson: r.argsJson ?? null,
      result: r.result ?? null,
      error: r.error ?? null,
      startedAt: r.startedAt != null ? Number(r.startedAt) : null,
      finishedAt: r.finishedAt != null ? Number(r.finishedAt) : null,
    }));
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }
}
