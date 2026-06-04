import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AwaitingKind = 'confirm' | 'movie_or_tv' | 'pick' | 'season' | 'announce_target';

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

export type SubscriptionInput = {
  subscriberJid: string;
  subscriberNumber: string;
  groupJid: string | null;
  mediaType: string;                  // 'movie' | 'tv'
  tmdbId: number;
  seasons?: 'all' | number[] | null;  // undefined/null for movies
};

export type ActiveSubscriber = {
  id: number;
  subscriberJid: string;
  subscriberNumber: string;
  groupJid: string | null;
  seasons: 'all' | number[] | null;
};

export type WatchlistSourceType = 'plex' | 'letterboxd' | 'plex-friend' | 'plex-self';

export type StoredWatchlistSource = {
  id: number;
  type: WatchlistSourceType;
  url: string;          // RSS URL for plex/letterboxd; plexfriend://<userId> for plex-friend
  owner: string;
  label: string;
  createdAt: number;
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
      CREATE TABLE IF NOT EXISTS priority_quota (
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
      CREATE TABLE IF NOT EXISTS user_map (
        sender_number  TEXT PRIMARY KEY,
        seerr_user_id  INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscription (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriber_jid    TEXT    NOT NULL,
        subscriber_number TEXT    NOT NULL,
        group_jid         TEXT,                 -- null = DM-origin; non-null routes to group w/ @mention
        media_type        TEXT    NOT NULL,     -- 'movie' | 'tv'
        tmdb_id           INTEGER NOT NULL,
        seasons           TEXT,                 -- nullable JSON: '"all"' | '[1,2,3]' (TV only; null for movie)
        created_at        INTEGER NOT NULL,
        notified_at       INTEGER               -- null = active; set = already notified (auto-clear)
      );
      CREATE INDEX IF NOT EXISTS subscription_media_active
        ON subscription(media_type, tmdb_id, notified_at);
      CREATE TABLE IF NOT EXISTS watchlist_item (
        source     TEXT    NOT NULL,   -- feed identity (source label)
        guid       TEXT    NOT NULL,   -- stable per-item id from the feed
        tmdb_id    INTEGER,            -- resolved TMDb id (null if unresolved)
        media_type TEXT,               -- 'movie' | 'tv' (null if unresolved)
        status     TEXT    NOT NULL,   -- 'queued' | 'available' | 'unresolved' | 'failed'
        title      TEXT,               -- best-effort display, for logs/dashboard
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source, guid)
      );
      CREATE TABLE IF NOT EXISTS watchlist_source (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        type         TEXT    NOT NULL,   -- 'plex' | 'letterboxd'
        url          TEXT    NOT NULL,
        owner_number TEXT    NOT NULL,   -- WhatsApp number the requests attribute to
        label        TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        UNIQUE(owner_number, url)
      );
      CREATE TABLE IF NOT EXISTS links_optout (
        sender_number TEXT PRIMARY KEY,  -- present = this member silenced film-link 🎬 reactions
        ts            INTEGER NOT NULL
      );
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

  // Unexpired in-flight conversations, for the dashboard #conversations panel.
  // payloadPreview is a best-effort short string (the title/display the user is
  // mid-flow on) pulled from the JSON payload without exposing the whole blob.
  listActiveConversations(): { jid: string; awaiting: string; payloadPreview: string; expiresAt: number }[] {
    const rows = this.db.prepare(
      `SELECT sender_jid AS jid, awaiting, payload, expires_at AS expiresAt
       FROM conversation_state WHERE expires_at > ? ORDER BY expires_at DESC`,
    ).all(Date.now()) as any[];
    return rows.map(r => {
      let preview = '';
      try {
        const p = JSON.parse(r.payload);
        preview = String(p?.display ?? p?.title ?? (Array.isArray(p?.candidates) ? `${p.candidates.length} options` : ''));
      } catch { /* leave blank on unparseable payload */ }
      return { jid: r.jid, awaiting: r.awaiting, payloadPreview: preview, expiresAt: r.expiresAt };
    });
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

  // Per-day !prioritize counter (separate budget from the request quota).
  getPriorityCount(senderNumber: string): number {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db.prepare(
      `SELECT count FROM priority_quota WHERE sender_number = ? AND day = ?`,
    ).get(senderNumber, day) as any;
    return row?.count ?? 0;
  }

  bumpPriority(senderNumber: string): number {
    const day = new Date().toISOString().slice(0, 10);
    this.db.prepare(`
      INSERT INTO priority_quota(sender_number, day, count) VALUES (?, ?, 1)
      ON CONFLICT(sender_number, day) DO UPDATE SET count = count + 1
    `).run(senderNumber, day);
    return this.getPriorityCount(senderNumber);
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
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    ).all(senderNumber, limit) as any;
  }

  // Per-user Seerr account mapping. When a WhatsApp number is mapped, requests
  // are attributed to that Seerr user instead of SEERR_DEFAULT_USER_ID, so the
  // Seerr UI shows the real requester. Returns null when unmapped (callers pass
  // `?? undefined` so seerr.createRequest falls back to the default user).
  getSeerrUserId(senderNumber: string): number | null {
    const row = this.db.prepare(
      `SELECT seerr_user_id AS seerrUserId FROM user_map WHERE sender_number = ?`,
    ).get(senderNumber) as any;
    return row ? Number(row.seerrUserId) : null;
  }

  setSeerrUserId(senderNumber: string, seerrUserId: number): void {
    this.db.prepare(`
      INSERT INTO user_map(sender_number, seerr_user_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(sender_number) DO UPDATE SET seerr_user_id = excluded.seerr_user_id, updated_at = excluded.updated_at
    `).run(senderNumber, seerrUserId, Date.now());
  }

  deleteSeerrUserId(senderNumber: string): void {
    this.db.prepare(`DELETE FROM user_map WHERE sender_number = ?`).run(senderNumber);
  }

  listUserMap(): { senderNumber: string; seerrUserId: number; updatedAt: number }[] {
    return this.db.prepare(
      `SELECT sender_number AS senderNumber, seerr_user_id AS seerrUserId, updated_at AS updatedAt
       FROM user_map ORDER BY sender_number`,
    ).all() as any;
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

  // Multi-subscriber ready notifications. A subscription is written on each
  // successful createRequest (movie, season-pick, or batch item). Recipient
  // de-dup happens at notify time, not insert time, so re-subscribing for more
  // seasons is a legitimately distinct row.
  addSubscription(s: SubscriptionInput): number {
    const r = this.db.prepare(`
      INSERT INTO subscription(subscriber_jid, subscriber_number, group_jid,
                               media_type, tmdb_id, seasons, created_at, notified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      s.subscriberJid,
      s.subscriberNumber,
      s.groupJid,
      s.mediaType,
      s.tmdbId,
      s.seasons == null ? null : JSON.stringify(s.seasons),
      Date.now(),
    );
    return Number(r.lastInsertRowid);
  }

  // True if ANY subscription row (active or already-notified) exists for the
  // media. Used by notifyReady to decide whether the findRequester back-compat
  // fallback should fire: once this feature has written a subscription for a
  // media, the audit-based fallback must NOT re-notify on a later MEDIA_AVAILABLE
  // (which would defeat auto-clear, since the audit row stays status='queued').
  hasAnySubscription(mediaType: string, tmdbId: number): boolean {
    const r = this.db.prepare(
      `SELECT 1 FROM subscription WHERE media_type = ? AND tmdb_id = ? LIMIT 1`,
    ).get(mediaType, tmdbId) as any;
    return !!r;
  }

  findActiveSubscribers(mediaType: string, tmdbId: number): ActiveSubscriber[] {
    const rows = this.db.prepare(
      `SELECT id, subscriber_jid AS subscriberJid, subscriber_number AS subscriberNumber,
              group_jid AS groupJid, seasons
       FROM subscription
       WHERE media_type = ? AND tmdb_id = ? AND notified_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    ).all(mediaType, tmdbId) as any[];
    return rows.map(r => ({
      id: Number(r.id),
      subscriberJid: r.subscriberJid,
      subscriberNumber: r.subscriberNumber,
      groupJid: r.groupJid ?? null,
      seasons: r.seasons ? JSON.parse(r.seasons) : null,
    }));
  }

  markSubscriptionsNotified(ids: number[], at?: number): void {
    if (ids.length === 0) return;
    this.db.prepare(
      `UPDATE subscription SET notified_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).run(at ?? Date.now(), ...ids);
  }

  // Bound retention of subscriber identifiers: drop long-notified subscription
  // rows (mirrors reapDeadPending). Active rows (notified_at IS NULL) are never
  // reaped. Returns the number of rows removed.
  reapNotifiedSubscriptions(olderThanMs: number): number {
    const r = this.db.prepare(
      `DELETE FROM subscription WHERE notified_at IS NOT NULL AND notified_at < ?`,
    ).run(olderThanMs);
    return Number(r.changes);
  }

  // Watchlist-sync seen-set. Each feed item is recorded once it's been processed
  // (requested, found already-available, or unresolvable) so subsequent polls
  // skip it. Keyed by (source, guid); guid is the feed's stable per-item id.
  hasWatchlistItem(source: string, guid: string): boolean {
    const r = this.db.prepare(
      `SELECT 1 FROM watchlist_item WHERE source = ? AND guid = ? LIMIT 1`,
    ).get(source, guid) as any;
    return !!r;
  }

  recordWatchlistItem(e: { source: string; guid: string; tmdbId?: number | null; mediaType?: string | null; status: string; title?: string | null }): void {
    this.db.prepare(`
      INSERT INTO watchlist_item(source, guid, tmdb_id, media_type, status, title, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, guid) DO UPDATE SET
        tmdb_id = excluded.tmdb_id,
        media_type = excluded.media_type,
        status = excluded.status,
        title = excluded.title
    `).run(e.source, e.guid, e.tmdbId ?? null, e.mediaType ?? null, e.status, e.title ?? null, Date.now());
  }

  listWatchlistItems(limit = 100): { source: string; guid: string; tmdbId: number | null; mediaType: string | null; status: string; title: string | null; createdAt: number }[] {
    const rows = this.db.prepare(
      `SELECT source, guid, tmdb_id AS tmdbId, media_type AS mediaType, status, title, created_at AS createdAt
       FROM watchlist_item ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(limit) as any[];
    return rows.map(r => ({
      source: r.source,
      guid: r.guid,
      tmdbId: r.tmdbId != null ? Number(r.tmdbId) : null,
      mediaType: r.mediaType ?? null,
      status: r.status,
      title: r.title ?? null,
      createdAt: Number(r.createdAt),
    }));
  }

  // Bound watchlist_item growth (mirrors reapDeadPending / reapNotifiedSubscriptions).
  // Re-seeing a reaped guid just re-requests it, and the availability check + the
  // subscription/audit absorb that, so a long retention is safe.
  reapWatchlistItems(olderThanMs: number): number {
    const r = this.db.prepare(`DELETE FROM watchlist_item WHERE created_at < ?`).run(olderThanMs);
    return Number(r.changes);
  }

  // Self-service watchlist feeds (members register their own via !watchlist add).
  // Merged with the operator-seeded config.watchlist.sources by the poller.
  addWatchlistSource(s: { type: WatchlistSourceType; url: string; owner: string; label: string }): { id: number; inserted: boolean } {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO watchlist_source(type, url, owner_number, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(s.type, s.url, s.owner, s.label, Date.now());
    return { id: Number(r.lastInsertRowid), inserted: r.changes > 0 };
  }

  listWatchlistSources(): StoredWatchlistSource[] {
    return this.mapWatchlistSources(this.db.prepare(
      `SELECT id, type, url, owner_number, label, created_at FROM watchlist_source ORDER BY id`,
    ).all() as any[]);
  }

  listWatchlistSourcesByOwner(owner: string): StoredWatchlistSource[] {
    return this.mapWatchlistSources(this.db.prepare(
      `SELECT id, type, url, owner_number, label, created_at FROM watchlist_source WHERE owner_number = ? ORDER BY id`,
    ).all(owner) as any[]);
  }

  countWatchlistSourcesByOwner(owner: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM watchlist_source WHERE owner_number = ?`).get(owner) as any;
    return r?.c ?? 0;
  }

  getWatchlistSource(id: number): StoredWatchlistSource | null {
    const rows = this.mapWatchlistSources(this.db.prepare(
      `SELECT id, type, url, owner_number, label, created_at FROM watchlist_source WHERE id = ?`,
    ).all(id) as any[]);
    return rows[0] ?? null;
  }

  deleteWatchlistSource(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM watchlist_source WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  // Per-member opt-out of the ambient film-link 🎬 reaction. Presence = silenced.
  setLinksOptOut(senderNumber: string, optedOut: boolean): void {
    if (optedOut) {
      this.db.prepare(`INSERT OR REPLACE INTO links_optout(sender_number, ts) VALUES (?, ?)`).run(senderNumber, Date.now());
    } else {
      this.db.prepare(`DELETE FROM links_optout WHERE sender_number = ?`).run(senderNumber);
    }
  }

  isLinksOptedOut(senderNumber: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM links_optout WHERE sender_number = ? LIMIT 1`).get(senderNumber);
  }

  private mapWatchlistSources(rows: any[]): StoredWatchlistSource[] {
    return rows.map(r => ({
      id: Number(r.id),
      type: r.type as WatchlistSourceType,
      url: r.url,
      owner: r.owner_number,
      label: r.label,
      createdAt: Number(r.created_at),
    }));
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
