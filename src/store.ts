import type { DatabaseSync, StatementSync } from 'node:sqlite';

export const now = (): number => Math.floor(Date.now() / 1000);

export type Role = 'admin' | 'user';

export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export interface User {
  id: number;
  username: string;
  passwordHash: string;
  role: Role;
  canWrite: boolean;
  mustChangePassword: boolean;
  totpSecret: string | null;
  totpLastStep: number | null;
  failedLogins: number;
  lockedUntil: number | null;
  createdAt: number;
  lastLoginAt: number | null;
}

/** Admins can always upload; normal users only when an admin allowed it. */
export const mayWrite = (u: Pick<User, 'role' | 'canWrite'>): boolean => u.role === 'admin' || u.canWrite;

/** Compact row as sent on the wire: [unix seconds, mg/dL, trend x10 | null, source]. */
export type ReadingRow = [ts: number, mgdl: number, trend: number | null, source: number];

export interface Session { userId: number; createdAt: number; lastSeen: number }
export type DeviceKind = 'uploader' | 'reader';
export interface Device { id: number; userId: number; kind: DeviceKind; name: string; createdAt: number; lastUsed: number | null }

/** Lock an account for 1, 2, 4… minutes (max 1 h) once it reaches this many failures in a row. */
const USER_LOCK_AFTER = 5;
/** Per IP: at most this many failed logins in [IP_WINDOW] seconds. */
export const IP_MAX_FAILURES = 20;
const IP_WINDOW = 15 * 60;
/** Readings closer than this (seconds) are the same reading (sensor period: 300 s). */
export const DUPLICATE_WINDOW = 120;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toUser(r: Row | undefined): User | null {
  if (!r) return null;
  return {
    id: Number(r.id),
    username: String(r.username),
    passwordHash: String(r.password_hash),
    role: r.role === 'admin' ? 'admin' : 'user',
    canWrite: Boolean(r.can_write),
    mustChangePassword: Boolean(r.must_change_password),
    totpSecret: (r.totp_secret as string | null) ?? null,
    totpLastStep: num(r.totp_last_step),
    failedLogins: Number(r.failed_logins),
    lockedUntil: num(r.locked_until),
    createdAt: Number(r.created_at),
    lastLoginAt: num(r.last_login_at),
  };
}

/** All SQL lives here. Statements are prepared once and reused. */
export class Store {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private q(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ------------------------------------------------------------------ users

  createUser(username: string, passwordHash: string, opts: { role?: Role; canWrite?: boolean; mustChangePassword?: boolean } = {}): number {
    const t = now();
    const r = this.q(`
      INSERT INTO users (username, password_hash, role, can_write, must_change_password, created_at, password_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(username, passwordHash, opts.role ?? 'user', opts.canWrite ? 1 : 0, opts.mustChangePassword ? 1 : 0, t, t);
    return Number(r.lastInsertRowid);
  }

  userByName(username: string): User | null {
    return toUser(this.q('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined);
  }

  userById(id: number): User | null {
    return toUser(this.q('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined);
  }

  listUsers(): User[] {
    return (this.q('SELECT * FROM users ORDER BY role, username').all() as Row[]).map((r) => toUser(r)!);
  }

  countUsers(): number {
    return Number((this.q('SELECT COUNT(*) AS n FROM users').get() as Row).n);
  }

  countAdmins(): number {
    return Number((this.q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as Row).n);
  }

  deleteUser(id: number): void {
    this.q('DELETE FROM users WHERE id = ?').run(id);
  }

  setRole(id: number, role: Role): void {
    this.q('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  setCanWrite(id: number, canWrite: boolean): void {
    this.q('UPDATE users SET can_write = ? WHERE id = ?').run(canWrite ? 1 : 0, id);
  }

  /** Also forgets lockouts: a new password is a fresh start. */
  setPassword(id: number, hash: string, mustChange = false): void {
    this.q(`UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = ?,
            failed_logins = 0, locked_until = NULL WHERE id = ?`).run(hash, now(), mustChange ? 1 : 0, id);
  }

  /** Silent upgrade of the hash parameters after a successful login. */
  rehashPassword(id: number, hash: string): void {
    this.q('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }

  setTotp(id: number, secret: string | null): void {
    this.q('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?').run(secret, id);
  }

  setTotpStep(id: number, step: number): void {
    this.q('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, id);
  }

  recordUserFailure(id: number): void {
    const u = this.userById(id);
    if (!u) return;
    const failures = u.failedLogins + 1;
    const lock = failures >= USER_LOCK_AFTER
      ? now() + Math.min(60 * 2 ** (failures - USER_LOCK_AFTER), 3600)
      : null;
    this.q('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failures, lock, id);
  }

  /** Successful login: clears failures and records the time. */
  recordLogin(id: number): void {
    this.q('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now(), id);
  }

  unlock(id: number): void {
    this.q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------------ IP throttling

  ipBlocked(ip: string): boolean {
    const r = this.q('SELECT count, window_start FROM ip_failures WHERE ip = ?').get(ip) as Row | undefined;
    return !!r && Number(r.window_start) > now() - IP_WINDOW && Number(r.count) >= IP_MAX_FAILURES;
  }

  recordIpFailure(ip: string): void {
    const t = now();
    this.q(`
      INSERT INTO ip_failures (ip, count, window_start) VALUES (?, 1, ?)
      ON CONFLICT(ip) DO UPDATE SET
        count = CASE WHEN window_start > ? THEN count + 1 ELSE 1 END,
        window_start = CASE WHEN window_start > ? THEN window_start ELSE excluded.window_start END`)
      .run(ip, t, t - IP_WINDOW, t - IP_WINDOW);
  }

  // ------------------------------------------------------------------ sessions

  createSession(tokenHash: Buffer, userId: number, ip: string, userAgent: string): void {
    const t = now();
    this.q('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tokenHash, userId, t, t, ip, userAgent.slice(0, 200));
  }

  session(tokenHash: Buffer): Session | null {
    const r = this.q('SELECT user_id, created_at, last_seen FROM sessions WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    return r ? { userId: Number(r.user_id), createdAt: Number(r.created_at), lastSeen: Number(r.last_seen) } : null;
  }

  touchSession(tokenHash: Buffer): void {
    this.q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), tokenHash);
  }

  deleteSession(tokenHash: Buffer): void {
    this.q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** Logs out every browser of the user, optionally keeping the current one. */
  deleteUserSessions(userId: number, keep: Buffer | null = null): void {
    if (keep) this.q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keep);
    else this.q('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /** Housekeeping: expired sessions and old throttling/audit rows. */
  purge(idleSeconds: number, maxSeconds: number): void {
    const t = now();
    this.q('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?').run(t - idleSeconds, t - maxSeconds);
    this.q('DELETE FROM ip_failures WHERE window_start < ?').run(t - IP_WINDOW);
    this.q('DELETE FROM audit WHERE at < ?').run(t - 180 * 86400);
  }

  // ------------------------------------------------------------------ devices

  createDevice(userId: number, kind: DeviceKind, name: string, tokenHash: Buffer): number {
    const r = this.q('INSERT INTO devices (user_id, kind, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, kind, name, tokenHash, now());
    return Number(r.lastInsertRowid);
  }

  /** The device together with its owner, so permissions are checked on every upload. */
  deviceByToken(tokenHash: Buffer): (Device & { owner: User }) | null {
    const r = this.q('SELECT id, user_id, kind, name, created_at, last_used FROM devices WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    if (!r) return null;
    const owner = this.userById(Number(r.user_id));
    if (!owner) return null;
    return {
      id: Number(r.id), userId: owner.id, kind: r.kind === 'reader' ? 'reader' : 'uploader', name: String(r.name),
      createdAt: Number(r.created_at), lastUsed: num(r.last_used), owner,
    };
  }

  touchDevice(id: number, ip: string): void {
    this.q('UPDATE devices SET last_used = ?, last_ip = ? WHERE id = ?').run(now(), ip, id);
  }

  /** userId null = every device (admin view). */
  listDevices(userId: number | null): (Device & { lastIp: string | null; username: string })[] {
    const rows = userId === null
      ? this.q(`SELECT d.*, u.username FROM devices d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC, d.id DESC`).all()
      : this.q(`SELECT d.*, u.username FROM devices d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? ORDER BY d.created_at DESC, d.id DESC`).all(userId);
    return (rows as Row[]).map((r) => ({
      id: Number(r.id), userId: Number(r.user_id), kind: r.kind === 'reader' ? 'reader' : 'uploader', name: String(r.name),
      createdAt: Number(r.created_at), lastUsed: num(r.last_used), lastIp: (r.last_ip as string | null) ?? null, username: String(r.username),
    }));
  }

  /** userId null = any device (admin). */
  deleteDevice(id: number, userId: number | null): boolean {
    const r = userId === null
      ? this.q('DELETE FROM devices WHERE id = ?').run(id)
      : this.q('DELETE FROM devices WHERE id = ? AND user_id = ?').run(id, userId);
    return Number(r.changes) > 0;
  }

  // ------------------------------------------------------------------ readings

  /**
   * Inserts in one transaction, skipping readings already stored. A reading counts as already
   * stored when another one lies within ±[DUPLICATE_WINDOW] seconds: the phone computes the time
   * of a reading when it receives it, so the same reading sent again (live, then from the sensor's
   * backfill after a reset, or by a second phone) can differ by a second or two. The G7 reads every
   * 5 minutes, so two genuine readings are never that close.
   * @return the rows that were new.
   */
  insertReadings(rows: ReadingRow[]): ReadingRow[] {
    const near = this.q('SELECT 1 FROM readings WHERE ts BETWEEN ? AND ? LIMIT 1');
    const ins = this.q('INSERT INTO readings (ts, mgdl, trend, source) VALUES (?, ?, ?, ?)');
    return this.transaction(() => rows.filter(([ts, mgdl, trend, src]) => {
      if (near.get(ts - DUPLICATE_WINDOW, ts + DUPLICATE_WINDOW)) return false;
      ins.run(ts, mgdl, trend, src);
      return true;
    }));
  }

  readings(from: number, to: number): ReadingRow[] {
    const s = this.q('SELECT ts, mgdl, trend, source FROM readings WHERE ts BETWEEN ? AND ? ORDER BY ts');
    s.setReturnArrays(true); // rows come out already in wire format
    return s.all(from, to) as unknown as ReadingRow[];
  }

  /** Readings after a time (follower phones), oldest first. */
  readingsAfter(since: number, limit: number): ReadingRow[] {
    const s = this.q('SELECT ts, mgdl, trend, source FROM readings WHERE ts > ? ORDER BY ts LIMIT ?');
    s.setReturnArrays(true);
    return s.all(since, limit) as unknown as ReadingRow[];
  }

  readingStats(): { count: number; last: number | null } {
    const r = this.q('SELECT COUNT(*) AS n, MAX(ts) AS t FROM readings').get() as Row;
    return { count: Number(r.n), last: num(r.t) };
  }

  // ------------------------------------------------------------------ audit

  audit(userId: number | null, event: string, ip: string | null, detail: string | null = null): void {
    this.q('INSERT INTO audit (user_id, at, event, ip, detail) VALUES (?, ?, ?, ?, ?)').run(userId, now(), event, ip, detail);
  }

  recentAudit(userId: number, limit = 30): { at: number; event: string; ip: string | null; detail: string | null }[] {
    return (this.q('SELECT at, event, ip, detail FROM audit WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(userId, limit) as Row[])
      .map((r) => ({ at: Number(r.at), event: String(r.event), ip: (r.ip as string | null) ?? null, detail: (r.detail as string | null) ?? null }));
  }
}
