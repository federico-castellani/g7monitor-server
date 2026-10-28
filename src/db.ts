import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Times are Unix seconds. The server holds the readings of one person: they are
 * keyed by time only, so every chart is a single sequential range scan.
 */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    role                 TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    -- normal users: 1 = may pair a phone and upload readings (admins always may)
    can_write            INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1)),
    -- set when an admin creates the account or resets the password
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    totp_secret          TEXT,
    totp_last_step       INTEGER,
    failed_logins        INTEGER NOT NULL DEFAULT 0,
    locked_until         INTEGER,
    created_at           INTEGER NOT NULL,
    password_changed_at  INTEGER NOT NULL,
    last_login_at        INTEGER
  ) STRICT;

  -- browser sessions: only the SHA-256 of the cookie token is stored
  CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    ip         TEXT,
    user_agent TEXT
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX sessions_user ON sessions(user_id);

  -- tokens of the phones, owned by the user who paired them (revocable):
  -- 'uploader' sends readings from the sensor, 'reader' only downloads them (follower)
  CREATE TABLE devices (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'uploader' CHECK (kind IN ('uploader', 'reader')),
    name       TEXT NOT NULL,
    token_hash BLOB NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used  INTEGER,
    last_ip    TEXT
  ) STRICT;
  CREATE INDEX devices_user ON devices(user_id);

  CREATE TABLE readings (
    ts     INTEGER PRIMARY KEY,
    mgdl   INTEGER NOT NULL,
    trend  INTEGER,           -- mg/dL per minute x10
    source INTEGER NOT NULL   -- 0 live, 1 backfill
  ) STRICT, WITHOUT ROWID;

  -- failed logins per IP (sliding window)
  CREATE TABLE ip_failures (
    ip           TEXT PRIMARY KEY,
    count        INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  -- security events, shown to the user they concern
  CREATE TABLE audit (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    at      INTEGER NOT NULL,
    event   TEXT NOT NULL,
    ip      TEXT,
    detail  TEXT
  ) STRICT;
  CREATE INDEX audit_user ON audit(user_id, at);
  `,
];

export function openDb(path: string): DatabaseSync {
  const isFile = path !== ':memory:';
  if (isFile) mkdirSync(dirname(path), { recursive: true });
  const isNew = isFile && !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
  `);
  // Only the server's user may read the database (no effect on Windows).
  if (isNew && process.platform !== 'win32') chmodSync(path, 0o600);

  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
