import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zc, createGunzip, gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { USERNAME_RE, mayWrite, now } from './store.ts';
import type { DeviceKind, FingerRow, ReadingRow, Role, Store, User } from './store.ts';
import { authenticate } from './auth.ts';
import type { Credentials } from './auth.ts';
import { hashPassword, passwordProblem, verifyPassword } from './security/password.ts';
import { DEVICE_TOKEN_PREFIX, DEVICE_TOKEN_RE, SESSION_TOKEN_RE, newToken, sha256 } from './security/tokens.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './security/totp.ts';

/** A browser session ends after 14 days without use, and in any case after 60 days. */
export const SESSION_IDLE = 14 * 86400;
export const SESSION_MAX = 60 * 86400;
/** last_seen is written at most this often, to avoid a database write per request. */
const TOUCH_EVERY = 300;
const MAX_DEVICES = 20;
const MAX_STREAMS = 100;
/** Set at image build time (git tag or commit); "dev" when run from the sources. */
export const VERSION = process.env.G7_VERSION || 'dev';
/** Ping of the phones' live connection: under the usual 5-minute NAT timeouts, rarer than the readings. */
export const DEVICE_PING_MS = 270_000;
/** Oldest accepted reading timestamp (2020-01-01). */
const MIN_TS = 1_577_836_800;


interface Auth { tokenHash: Buffer; user: User }

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
    /** Address used for throttling and the activity log (see clientIpOf). */
    clientIp: string;
    deviceId: number | null;
    deviceUser: number | null;
    deviceKind: DeviceKind | null;
  }
}

// ---------------------------------------------------------------------- live updates

/** "r" sensor readings, "f" blood glucose meter results. */
type Listener = (kind: 'r' | 'f', rows: unknown[]) => void;

/** In-process fan-out of new readings to the open SSE streams. */
class Hub {
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get size(): number {
    return this.listeners.size;
  }

  publish(kind: 'r' | 'f', rows: unknown[]): void {
    if (rows.length) this.listeners.forEach((l) => l(kind, rows));
  }
}

// ---------------------------------------------------------------------- HTTP helpers

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function securityHeaders(set: (name: string, value: string) => void, https: boolean): void {
  set('Content-Security-Policy', CSP);
  set('X-Content-Type-Options', 'nosniff');
  set('X-Frame-Options', 'DENY');
  set('Referrer-Policy', 'no-referrer');
  set('Cross-Origin-Opener-Policy', 'same-origin');
  set('Cross-Origin-Resource-Policy', 'same-origin');
  set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (https) set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function pickEncoding(accept: string | undefined): 'br' | 'gzip' | null {
  if (!accept) return null;
  const tokens = accept.toLowerCase().split(',').map((s) => s.trim());
  const has = (e: string) => tokens.some((t) => t === e || (t.startsWith(e + ';') && !/q=0(\.0*)?$/.test(t)));
  return has('br') ? 'br' : has('gzip') ? 'gzip' : null;
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

interface StaticFile { type: string; etag: string; version: string; raw: Buffer; br: Buffer; gz: Buffer }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function staticFile(type: string, raw: Buffer): StaticFile {
  const hash = createHash('sha256').update(raw).digest('base64url');
  return {
    type,
    raw,
    etag: `"${hash.slice(0, 22)}"`,
    version: hash.slice(0, 10),
    br: brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }),
    gz: gzipSync(raw, { level: 9 }),
  };
}

/**
 * The web UI is a handful of small files: loaded and pre-compressed once at startup.
 * index.html links each file with its content hash (/app.js?v=…): a proxy or CDN in front
 * (Cloudflare caches .js and .css by default) can never serve an old script with a new page.
 */
function loadStatic(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  for (const name of readdirSync(dir)) {
    const type = TYPES[extname(name)];
    if (type) files.set(name, staticFile(type, readFileSync(join(dir, name))));
  }
  const index = files.get('index.html');
  if (index) {
    let html = index.raw.toString('utf8');
    for (const [name, f] of files) {
      if (name !== 'index.html') html = html.replaceAll(`"/${name}"`, `"/${name}?v=${f.version}"`);
    }
    files.set('index.html', staticFile(index.type, Buffer.from(html, 'utf8')));
  }
  return files;
}

/** Decompresses gzip uploads; the body limit then applies to the decompressed size (no zip bombs). */
async function gunzipBody(req: FastifyRequest, _reply: FastifyReply, payload: Readable): Promise<Readable> {
  const enc = req.headers['content-encoding'];
  if (!enc || enc === 'identity') return payload;
  if (enc !== 'gzip') throw Object.assign(new Error('Codifica non supportata'), { statusCode: 415 });
  const gunzip = createGunzip();
  let received = 0;
  payload.on('data', (chunk: Buffer) => {
    received += chunk.length;
    // lets Fastify compare Content-Length with the compressed bytes actually received
    (gunzip as Readable & { receivedEncodedLength?: number }).receivedEncodedLength = received;
  });
  payload.on('error', (e) => gunzip.destroy(e));
  return payload.pipe(gunzip);
}

/**
 * Upload format, designed to be tiny: {"b": base time, "r": [[dt, mgdl, trend×10|null, source], …]}
 * where dt is seconds from the previous row (the first from b). A 5-minute series
 * becomes mostly "[300,123,-4,0]": about 15 bytes per reading before gzip.
 */
function decodeRows(b: number, rows: unknown[]): ReadingRow[] | string {
  const out: ReadingRow[] = [];
  const maxTs = now() + 600;
  let ts = b;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 4) return 'riga non valida';
    const [dt, mgdl, trend, src] = row as unknown[];
    if (!Number.isInteger(dt) || (dt as number) < 0 || (dt as number) > 90 * 86400) return 'intervallo di tempo non valido';
    ts += dt as number;
    if (ts > maxTs) return 'orario nel futuro';
    if (!Number.isInteger(mgdl) || (mgdl as number) < 39 || (mgdl as number) > 401) return 'glicemia fuori intervallo';
    if (trend !== null && (!Number.isInteger(trend) || (trend as number) < -250 || (trend as number) > 250)) return 'tendenza non valida';
    if (src !== 0 && src !== 1) return 'origine non valida';
    out.push([ts, mgdl as number, trend as number | null, src]);
  }
  return out;
}

/** What the browser may know about an account. */
function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    canWrite: mayWrite(u),
    mustChangePassword: u.mustChangePassword,
    totp: !!u.totpSecret,
  };
}

/** A plain IPv4 or IPv6 address, nothing else (header values are attacker-controlled). */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i;

/**
 * The client's address. Fastify already resolves X-Forwarded-For through the trusted hops; with a
 * CDN in front (Cloudflare), its header holds the real address, but only proxied requests may set it.
 */
function clientIpOf(req: FastifyRequest, header: string | null): string {
  if (header && req.ips && req.ips.length > 1) {
    const v = req.headers[header];
    if (typeof v === 'string' && IP_RE.test(v.trim())) return v.trim();
  }
  return req.ip;
}

// ---------------------------------------------------------------------- schemas

const credentialsProps = {
  username: { type: 'string', minLength: 1, maxLength: 64 },
  password: { type: 'string', minLength: 1, maxLength: 1024 },
  totp: { type: 'string', pattern: '^[0-9]{6}$' },
} as const;

const idParams = {
  type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } },
} as const;

// ---------------------------------------------------------------------- app

export interface AppOptions { logger?: boolean; publicDir?: string }

export function buildApp(cfg: Config, store: Store, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: cfg.trustProxy,
    bodyLimit: 16 * 1024,
    return503OnClosing: true,
  });

  const hub = new Hub();
  const streams = new Set<() => void>();
  const cookieName = cfg.cookieSecure ? '__Host-g7s' : 'g7s';
  const sessionCookie = (token: string, maxAge: number) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cfg.cookieSecure ? '; Secure' : ''}`;
  const isBrowserApi = (url: string) => url.startsWith('/api/') && !url.startsWith('/api/v1/');
  const forbidden = (reply: FastifyReply, error: string, message: string) => reply.code(403).send({ error, message });

  app.decorateRequest('auth', null);
  app.decorateRequest('clientIp', '');
  app.decorateRequest('deviceId', null);
  app.decorateRequest('deviceUser', null);
  app.decorateRequest('deviceKind', null);

  app.addHook('onRequest', async (req) => {
    req.clientIp = clientIpOf(req, cfg.clientIpHeader);
  });

  // ----- browser session + CSRF protection
  app.addHook('onRequest', async (req, reply) => {
    if (!isBrowserApi(req.url)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Besides SameSite=Strict cookies: state-changing calls only from our own pages.
      const expected = cfg.publicOrigin ?? `${req.protocol}://${req.host}`;
      const site = req.headers['sec-fetch-site'];
      if (req.headers.origin !== expected || (site !== undefined && site !== 'same-origin')) {
        return forbidden(reply, 'origine_non_valida', 'Richiesta non consentita');
      }
    }
    const token = readCookie(req, cookieName);
    if (!token || !SESSION_TOKEN_RE.test(token)) return;
    const hash = sha256(token);
    const s = store.session(hash);
    if (!s) return;
    const t = now();
    if (s.lastSeen < t - SESSION_IDLE || s.createdAt < t - SESSION_MAX) {
      store.deleteSession(hash);
      return;
    }
    // Loaded on every request: role and permission changes apply immediately.
    const user = store.userById(s.userId);
    if (!user) return;
    req.auth = { tokenHash: hash, user };
    if (t - s.lastSeen > TOUCH_EVERY) store.touchSession(hash);
  });

  /** Until a temporary password is replaced, only these calls are allowed. */
  const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(['/api/me', '/api/me/password', '/api/auth/logout']);

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) return reply.code(401).send({ error: 'non_autenticato', message: 'Accesso richiesto' });
    if (req.auth.user.mustChangePassword && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(req.routeOptions.url ?? '')) {
      return forbidden(reply, 'cambio_password_richiesto', 'Prima di continuare scegli una nuova password');
    }
  };

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const refused = await requireAuth(req, reply);
    if (refused) return refused;
    if (req.auth!.user.role !== 'admin') return forbidden(reply, 'solo_amministratori', 'Funzione riservata agli amministratori');
  };

  /** Phone token of any kind: enough to read, since every account can see the readings. */
  const requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const device = m && DEVICE_TOKEN_RE.test(m[1]) ? store.deviceByToken(sha256(m[1])) : null;
    if (!device) return reply.code(401).send({ error: 'token_non_valido', message: 'Dispositivo non autorizzato' });
    req.deviceId = device.id;
    req.deviceUser = device.userId;
    req.deviceKind = device.kind;
    store.touchDevice(device.id, req.clientIp);
  };

  /** Upload token of an account allowed to write: checked on every request, so revoking the permission is immediate. */
  const requireUploader = async (req: FastifyRequest, reply: FastifyReply) => {
    const refused = await requireDevice(req, reply);
    if (refused) return refused;
    if (req.deviceKind !== 'uploader') return forbidden(reply, 'token_di_sola_lettura', 'Questo telefono è collegato solo per ricevere le glicemie');
    if (!mayWrite(store.userById(req.deviceUser!)!)) {
      return forbidden(reply, 'scrittura_non_consentita', 'Il tuo account può solo leggere: chiedi a un amministratore il permesso di caricare');
    }
  };

  // ----- security headers + compression of dynamic responses
  app.addHook('onSend', async (req, reply, payload) => {
    securityHeaders((k, v) => reply.header(k, v), cfg.cookieSecure);
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if ((typeof payload !== 'string' && !Buffer.isBuffer(payload)) || reply.hasHeader('content-encoding')) return payload;
    const type = String(reply.getHeader('content-type') ?? '');
    if (Buffer.byteLength(payload) < 1024 || !/json|text/.test(type)) return payload;
    reply.header('Vary', 'Accept-Encoding');
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc) return payload;
    reply.header('Content-Encoding', enc);
    reply.removeHeader('content-length');
    return enc === 'br'
      ? brotliCompressSync(payload, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } })
      : gzipSync(payload, { level: 6 });
  });

  app.addHook('preClose', async () => {
    for (const close of [...streams]) close();
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'richiesta_non_valida', message: 'Dati non validi' });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error(err);
    return reply.code(status).send({
      error: status === 413 ? 'troppo_grande' : status === 429 ? 'server_occupato' : status === 500 ? 'errore_interno' : 'richiesta_non_valida',
      message: status === 500 ? 'Errore interno del server' : err.message,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(req.url.startsWith('/api/') ? { error: 'non_trovato', message: 'Non trovato' } : 'Non trovato'));

  // The exact version helps an attacker pick known bugs: only local checks (update.sh, Docker) see it.
  const isLocal = (req: FastifyRequest) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  app.get('/healthz', async (req) => (isLocal(req) && !req.headers['x-forwarded-for'] ? { ok: true, version: VERSION } : { ok: true }));

  // ================================================================ web: authentication and account

  app.post('/api/auth/login', {
    schema: { body: { type: 'object', required: ['username', 'password'], additionalProperties: false, properties: credentialsProps } },
  }, async (req, reply) => {
    const r = await authenticate(store, cfg.pepper, req.body as Credentials, req.clientIp);
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    if (req.auth) store.deleteSession(req.auth.tokenHash); // never reuse a session id across logins
    const token = newToken();
    const ua = String(req.headers['user-agent'] ?? '');
    store.createSession(sha256(token), r.user.id, req.clientIp, ua);
    store.audit(r.user.id, 'accesso_web', req.clientIp, ua.slice(0, 120));
    reply.header('Set-Cookie', sessionCookie(token, SESSION_MAX));
    return publicUser(r.user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) store.deleteSession(req.auth.tokenHash);
    reply.header('Set-Cookie', sessionCookie('', 0));
    return reply.code(204).send();
  });

  app.get('/api/me', { preHandler: requireAuth }, async (req) => publicUser(req.auth!.user));

  app.post('/api/me/password', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object', required: ['current', 'next'], additionalProperties: false,
        properties: { current: { type: 'string', maxLength: 1024 }, next: { type: 'string', maxLength: 1024 } },
      },
    },
  }, async (req, reply) => {
    const { current, next } = req.body as { current: string; next: string };
    const u = req.auth!.user;
    if (store.ipBlocked(req.clientIp)) return reply.code(429).send({ error: 'troppi_tentativi', message: 'Troppi tentativi: riprova tra qualche minuto' });
    if (!(await verifyPassword(u.passwordHash, current, cfg.pepper)).ok) {
      store.recordIpFailure(req.clientIp);
      store.audit(u.id, 'cambio_password_fallito', req.clientIp);
      return reply.code(400).send({ error: 'password_errata', message: 'La password attuale non è corretta' });
    }
    if (next === current) return reply.code(400).send({ error: 'password_uguale', message: 'La nuova password deve essere diversa da quella attuale' });
    const problem = passwordProblem(next, u.username);
    if (problem) return reply.code(400).send({ error: 'password_debole', message: problem });
    store.setPassword(u.id, await hashPassword(next, cfg.pepper));
    store.deleteUserSessions(u.id, req.auth!.tokenHash); // other browsers must log in again
    store.audit(u.id, 'password_cambiata', req.clientIp);
    return publicUser(store.userById(u.id)!);
  });

  app.post('/api/me/logout-all', { preHandler: requireAuth }, async (req, reply) => {
    store.deleteUserSessions(req.auth!.user.id);
    store.audit(req.auth!.user.id, 'disconnessione_ovunque', req.clientIp);
    reply.header('Set-Cookie', sessionCookie('', 0));
    return reply.code(204).send();
  });

  app.get('/api/activity', { preHandler: requireAuth }, async (req) => store.recentAudit(req.auth!.user.id));

  // ----- profile: open browsers

  app.get('/api/me/sessions', { preHandler: requireAuth }, async (req) => {
    const current = req.auth!.tokenHash.toString('hex');
    return store.listSessions(req.auth!.user.id).map((s) => ({ ...s, current: s.id === current }));
  });

  app.delete('/api/me/sessions/:id', {
    preHandler: requireAuth,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteUserSession(req.auth!.user.id, Buffer.from(id, 'hex'))) {
      return reply.code(404).send({ error: 'non_trovato', message: 'Sessione non trovata' });
    }
    store.audit(req.auth!.user.id, 'sessione_chiusa', req.clientIp);
    return reply.code(204).send();
  });

  // ----- profile: two-step verification (TOTP), set up from the web

  /** Secrets offered but not confirmed yet (10 minutes): nothing changes until the first code is right. */
  const pendingTotp = new Map<number, { secret: string; until: number }>();
  const tooMany = (reply: FastifyReply) => reply.code(429).send({ error: 'troppi_tentativi', message: 'Troppi tentativi: riprova tra qualche minuto' });

  app.post('/api/me/totp/setup', { preHandler: requireAuth }, async (req, reply) => {
    const u = req.auth!.user;
    if (u.totpSecret) return reply.code(409).send({ error: 'gia_attiva', message: 'La verifica in due passaggi è già attiva' });
    const secret = newTotpSecret();
    pendingTotp.set(u.id, { secret, until: now() + 600 });
    return { secret, uri: otpauthUri('G7 Monitor', u.username, secret) };
  });

  app.post('/api/me/totp/enable', {
    preHandler: requireAuth,
    schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: credentialsProps.totp } } },
  }, async (req, reply) => {
    const u = req.auth!.user;
    if (store.ipBlocked(req.clientIp)) return tooMany(reply);
    const pending = pendingTotp.get(u.id);
    if (!pending || pending.until < now()) return reply.code(400).send({ error: 'scaduto', message: 'Richiesta scaduta: ricomincia l\'attivazione' });
    const step = verifyTotp(pending.secret, (req.body as { code: string }).code, null);
    if (step === null) {
      store.recordIpFailure(req.clientIp);
      return reply.code(400).send({ error: 'codice_non_valido', message: 'Codice non valido: controlla l\'ora del telefono e riprova' });
    }
    pendingTotp.delete(u.id);
    store.setTotp(u.id, pending.secret);
    store.setTotpStep(u.id, step);
    store.audit(u.id, '2fa_attivata', req.clientIp);
    return publicUser(store.userById(u.id)!);
  });

  app.post('/api/me/totp/disable', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object', required: ['password', 'code'], additionalProperties: false,
        properties: { password: credentialsProps.password, code: credentialsProps.totp },
      },
    },
  }, async (req, reply) => {
    const u = req.auth!.user;
    const { password, code } = req.body as { password: string; code: string };
    if (store.ipBlocked(req.clientIp)) return tooMany(reply);
    if (!u.totpSecret) return reply.code(409).send({ error: 'non_attiva', message: 'La verifica in due passaggi non è attiva' });
    const passwordOk = (await verifyPassword(u.passwordHash, password, cfg.pepper)).ok;
    const step = passwordOk ? verifyTotp(u.totpSecret, code, u.totpLastStep) : null;
    if (step === null) {
      store.recordIpFailure(req.clientIp);
      store.audit(u.id, 'cambio_2fa_fallito', req.clientIp);
      return reply.code(400).send({ error: 'non_valido', message: 'Password o codice non validi' });
    }
    store.setTotp(u.id, null);
    store.audit(u.id, '2fa_disattivata', req.clientIp);
    return publicUser(store.userById(u.id)!);
  });

  /** Phones: admins see and revoke all of them, users only their own. */
  app.get('/api/devices', { preHandler: requireAuth }, async (req) => {
    const u = req.auth!.user;
    return store.listDevices(u.role === 'admin' ? null : u.id)
      .map(({ id, kind, name, createdAt, lastUsed, username }) => ({ id, kind, name, createdAt, lastUsed, username }));
  });

  app.delete('/api/devices/:id', { preHandler: requireAuth, schema: { params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const u = req.auth!.user;
    if (!store.deleteDevice(id, u.role === 'admin' ? null : u.id)) return reply.code(404).send({ error: 'non_trovato', message: 'Dispositivo non trovato' });
    store.audit(u.id, 'dispositivo_rimosso', req.clientIp, String(id));
    return reply.code(204).send();
  });

  // ================================================================ web: readings (every user can read)

  app.get('/api/readings', {
    preHandler: requireAuth,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 0 } },
      },
    },
  }, async (req) => {
    const q = req.query as { from?: number; to?: number };
    const to = q.to ?? now() + 600;
    const from = Math.max(q.from ?? to - 86400, to - 90 * 86400);
    return { r: store.readings(from, to), f: store.fingersticks(from, to) };
  });

  /**
   * Server-Sent Events: new readings are pushed as soon as the phone with the sensor uploads them.
   * @param idlePingMs a comment line is sent only after this long without writes, so proxies and
   *   mobile networks keep the connection open; nothing else crosses the network between readings.
   * @param stillValid re-checked periodically: the stream ends when the session or token is revoked.
   * @param backlog readings to send first (what a phone missed while disconnected).
   */
  const openStream = (
    req: FastifyRequest, reply: FastifyReply,
    opts: {
      idlePingMs: number;
      stillValid: () => boolean;
      backlog?: ReadingRow[];
      /** null: the client does not know meter results, never send them (older apps). */
      fingersticks: FingerRow[] | null;
    },
  ) => {
    reply.hijack();
    const res = reply.raw;
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // nginx: don't buffer
    };
    securityHeaders((k, v) => { headers[k] = v; }, cfg.cookieSecure);
    res.writeHead(200, headers);
    let lastWrite = Date.now();
    const write = (chunk: string) => {
      res.write(chunk);
      lastWrite = Date.now();
    };
    write('retry: 15000\n\n');
    // Readings are unnamed events (what older clients expect); meter results are a named event,
    // which old web pages ignore and old apps never request.
    const send = (kind: 'r' | 'f', rows: unknown[]) => {
      if (kind === 'r') write(`data: ${JSON.stringify(rows)}\n\n`);
      else if (opts.fingersticks) write(`event: fingerstick\ndata: ${JSON.stringify(rows)}\n\n`);
    };
    const unsubscribe = hub.subscribe(send);
    if (opts.backlog?.length) send('r', opts.backlog);
    if (opts.fingersticks?.length) send('f', opts.fingersticks);

    const timer = setInterval(() => {
      if (!opts.stillValid()) close();
      else if (Date.now() - lastWrite >= opts.idlePingMs) write(': ping\n\n');
    }, Math.min(opts.idlePingMs, 30_000));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      streams.delete(close);
      res.end();
    };
    streams.add(close);
    req.raw.on('close', close);
  };

  /** The web page: browsers reconnect by themselves, a short ping keeps every proxy happy. */
  app.get('/api/readings/stream', { preHandler: requireAuth }, (req, reply) => {
    if (hub.size >= MAX_STREAMS) return reply.code(429).send({ error: 'troppe_connessioni', message: 'Troppe connessioni aperte' });
    const token = req.auth!.tokenHash;
    const stillValid = () => {
      const s = store.session(token);
      const t = now();
      return !!s && s.createdAt >= t - SESSION_MAX && s.lastSeen >= t - SESSION_IDLE;
    };
    openStream(req, reply, { idlePingMs: 25_000, stillValid, fingersticks: [] });
  });

  // ================================================================ web: user management (admins)

  app.get('/api/admin/overview', { preHandler: requireAdmin }, async () => ({
    ...store.overview(), version: VERSION, streams: hub.size,
  }));

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () => store.allAudit());

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () =>
    store.listUsers().map((u) => ({
      ...publicUser(u),
      canWrite: u.canWrite,
      locked: !!u.lockedUntil && u.lockedUntil > now(),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    })));

  /** Accounts are created with a temporary password that must be changed at the first login. */
  app.post('/api/admin/users', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object', required: ['username', 'password', 'role', 'canWrite'], additionalProperties: false,
        properties: {
          username: { type: 'string', maxLength: 32 },
          password: { type: 'string', maxLength: 1024 },
          role: { type: 'string', enum: ['admin', 'user'] },
          canWrite: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string; role: Role; canWrite: boolean };
    if (!USERNAME_RE.test(b.username)) return reply.code(400).send({ error: 'nome_non_valido', message: 'Nome utente: 3-32 caratteri tra lettere, numeri, . _ -' });
    if (store.userByName(b.username)) return reply.code(409).send({ error: 'nome_esistente', message: 'Esiste già un utente con questo nome' });
    const problem = passwordProblem(b.password, b.username);
    if (problem) return reply.code(400).send({ error: 'password_debole', message: problem });
    const id = store.createUser(b.username, await hashPassword(b.password, cfg.pepper), {
      role: b.role, canWrite: b.canWrite, mustChangePassword: true,
    });
    const admin = req.auth!.user;
    store.audit(admin.id, 'utente_creato', req.clientIp, b.username);
    store.audit(id, 'account_creato_da_admin', null, admin.username);
    return reply.code(201).send(publicUser(store.userById(id)!));
  });

  app.patch('/api/admin/users/:id', {
    preHandler: requireAdmin,
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          role: { type: 'string', enum: ['admin', 'user'] }, canWrite: { type: 'boolean' }, unlock: { type: 'boolean' },
          // a user who lost the phone with the authenticator app
          resetTotp: { type: 'boolean', const: true },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const b = req.body as { role?: Role; canWrite?: boolean; unlock?: boolean; resetTotp?: true };
    const admin = req.auth!.user;
    const target = store.userById(id);
    if (!target) return reply.code(404).send({ error: 'non_trovato', message: 'Utente non trovato' });
    if (b.role === 'user' && target.role === 'admin') {
      if (target.id === admin.id) return reply.code(400).send({ error: 'operazione_non_consentita', message: 'Non puoi togliere a te stesso il ruolo di amministratore' });
      if (store.countAdmins() <= 1) return reply.code(400).send({ error: 'ultimo_admin', message: 'Deve restare almeno un amministratore' });
    }
    store.transaction(() => {
      if (b.role && b.role !== target.role) {
        store.setRole(id, b.role);
        store.audit(id, 'ruolo_cambiato', null, `${b.role} (da ${admin.username})`);
      }
      if (b.canWrite !== undefined && b.canWrite !== target.canWrite) {
        store.setCanWrite(id, b.canWrite);
        store.audit(id, b.canWrite ? 'scrittura_consentita' : 'solo_lettura', null, admin.username);
      }
      if (b.unlock) store.unlock(id);
      if (b.resetTotp && target.totpSecret) {
        store.setTotp(id, null);
        store.audit(id, '2fa_azzerata', null, admin.username);
      }
    });
    store.audit(admin.id, 'utente_modificato', req.clientIp, target.username);
    return publicUser(store.userById(id)!);
  });

  /** Sets a temporary password, logs the user out everywhere; the user must choose a new one. */
  app.post('/api/admin/users/:id/password', {
    preHandler: requireAdmin,
    schema: {
      params: idParams,
      body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: { type: 'string', maxLength: 1024 } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { password } = req.body as { password: string };
    const admin = req.auth!.user;
    const target = store.userById(id);
    if (!target) return reply.code(404).send({ error: 'non_trovato', message: 'Utente non trovato' });
    if (target.id === admin.id) return reply.code(400).send({ error: 'operazione_non_consentita', message: 'Per la tua password usa "Cambia password"' });
    const problem = passwordProblem(password, target.username);
    if (problem) return reply.code(400).send({ error: 'password_debole', message: problem });
    store.setPassword(id, await hashPassword(password, cfg.pepper), true);
    store.deleteUserSessions(id);
    store.audit(id, 'password_reimpostata', null, admin.username);
    store.audit(admin.id, 'password_utente_reimpostata', req.clientIp, target.username);
    return reply.code(204).send();
  });

  app.delete('/api/admin/users/:id', { preHandler: requireAdmin, schema: { params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const admin = req.auth!.user;
    const target = store.userById(id);
    if (!target) return reply.code(404).send({ error: 'non_trovato', message: 'Utente non trovato' });
    if (target.id === admin.id) return reply.code(400).send({ error: 'operazione_non_consentita', message: 'Non puoi eliminare il tuo account' });
    store.deleteUser(id); // sessions and phones go with it; readings stay
    store.audit(admin.id, 'utente_eliminato', req.clientIp, target.username);
    return reply.code(204).send();
  });

  // ================================================================ app (device) API

  /** Public: lets the app check that an address really is a G7 Monitor server before asking for credentials. */
  app.get('/api/v1/info', async () => ({ service: 'g7monitor', api: 1 }));

  /**
   * Pairs a phone: the app sends the user's credentials once and keeps only the returned token.
   * kind "uploader" (phone with the sensor) needs write permission; "reader" (follower) does not.
   */
  app.post('/api/v1/devices', {
    schema: {
      body: {
        type: 'object', required: ['username', 'password', 'name'], additionalProperties: false,
        properties: {
          ...credentialsProps,
          name: { type: 'string', minLength: 1, maxLength: 60 },
          kind: { type: 'string', enum: ['uploader', 'reader'] },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as Credentials & { name: string; kind?: DeviceKind };
    const kind = body.kind ?? 'uploader';
    const r = await authenticate(store, cfg.pepper, body, req.clientIp);
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    if (r.user.mustChangePassword) {
      return forbidden(reply, 'cambio_password_richiesto', 'Accedi prima al sito e scegli una nuova password');
    }
    if (kind === 'uploader' && !mayWrite(r.user)) {
      return forbidden(reply, 'scrittura_non_consentita', 'Il tuo account può solo leggere: chiedi a un amministratore il permesso di caricare');
    }
    if (store.listDevices(r.user.id).length >= MAX_DEVICES) {
      return reply.code(409).send({ error: 'troppi_dispositivi', message: 'Troppi dispositivi collegati: rimuovine qualcuno dal sito' });
    }
    const token = newToken(DEVICE_TOKEN_PREFIX);
    store.createDevice(r.user.id, kind, body.name.trim() || 'Telefono', sha256(token));
    store.audit(r.user.id, 'dispositivo_aggiunto', req.clientIp, body.name.slice(0, 60));
    return reply.code(201).send({ token, username: r.user.username, last: store.readingStats().last });
  });

  /** "Scollega" in the app: the phone revokes its own token (allowed even without write permission). */
  app.delete('/api/v1/devices/self', { preHandler: requireDevice }, async (req, reply) => {
    store.deleteDevice(req.deviceId!, req.deviceUser!);
    store.audit(req.deviceUser!, 'dispositivo_rimosso', req.clientIp, "dall'app");
    return reply.code(204).send();
  });

  app.get('/api/v1/status', { preHandler: requireDevice }, async (req) => {
    const u = store.userById(req.deviceUser!)!;
    return { username: u.username, last: store.readingStats().last };
  });

  /**
   * Follower phones: readings newer than "since" (Unix seconds), oldest first, at most "limit".
   * Polled once per expected reading, so a typical answer holds a single row.
   */
  app.get('/api/v1/readings', {
    preHandler: requireDevice,
    schema: {
      querystring: {
        type: 'object', required: ['since'], additionalProperties: false,
        properties: {
          since: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 5000 },
          fsince: { type: 'integer', minimum: 0 }, // meter results after this time (newer apps)
        },
      },
    },
  }, async (req) => {
    const q = req.query as { since: number; limit?: number; fsince?: number };
    const r = store.readingsAfter(Math.max(q.since, now() - 90 * 86400), q.limit ?? 3000);
    if (q.fsince === undefined) return { r };
    return { r, f: store.fingersticksAfter(Math.max(q.fsince, now() - 90 * 86400), 1000) };
  });

  /**
   * Phones that receive (follower): one open connection instead of polling, so a reading arrives
   * about a second after the sensor phone uploads it. First the readings after "since" (missed while
   * disconnected), then each new one. Between readings the line stays silent except for a ping after
   * [DEVICE_PING_MS] of inactivity, just enough for NAT/mobile networks not to drop it.
   */
  app.get('/api/v1/readings/stream', {
    preHandler: requireDevice,
    schema: {
      querystring: {
        type: 'object', required: ['since'], additionalProperties: false,
        properties: { since: { type: 'integer', minimum: 0 }, fsince: { type: 'integer', minimum: 0 } },
      },
    },
  }, (req, reply) => {
    if (hub.size >= MAX_STREAMS) return reply.code(429).send({ error: 'troppe_connessioni', message: 'Troppe connessioni aperte' });
    const { since, fsince } = req.query as { since: number; fsince?: number };
    const deviceId = req.deviceId!;
    openStream(req, reply, {
      idlePingMs: DEVICE_PING_MS,
      stillValid: () => store.deviceExists(deviceId),
      backlog: store.readingsAfter(Math.max(since, now() - 90 * 86400), 3000),
      fingersticks: fsince === undefined ? null : store.fingersticksAfter(Math.max(fsince, now() - 90 * 86400), 1000),
    });
  });

  app.post('/api/v1/readings', {
    onRequest: requireUploader, // before reading and decompressing the body
    preParsing: gunzipBody,
    bodyLimit: 512 * 1024,
    schema: {
      body: {
        type: 'object', required: ['b', 'r'], additionalProperties: false,
        properties: {
          b: { type: 'integer', minimum: MIN_TS, maximum: 4_102_444_800 },
          r: { type: 'array', maxItems: 5000, items: { type: 'array' } },
        },
      },
    },
  }, async (req, reply) => {
    const { b, r } = req.body as { b: number; r: unknown[] };
    const rows = decodeRows(b, r);
    if (typeof rows === 'string') return reply.code(400).send({ error: 'dati_non_validi', message: rows });
    const added = store.insertReadings(rows);
    hub.publish('r', added);
    return { n: added.length };
  });

  /** Blood glucose meter results from the sensor phone: [[unix seconds, mg/dL, meter name | null], …]. */
  app.post('/api/v1/fingersticks', {
    onRequest: requireUploader,
    schema: {
      body: {
        type: 'object', required: ['f'], additionalProperties: false,
        properties: { f: { type: 'array', maxItems: 1000, items: { type: 'array' } } },
      },
    },
  }, async (req, reply) => {
    const rows: FingerRow[] = [];
    const maxTs = now() + 600;
    for (const row of (req.body as { f: unknown[] }).f) {
      if (!Array.isArray(row) || row.length !== 3) return reply.code(400).send({ error: 'dati_non_validi', message: 'riga non valida' });
      const [ts, mgdl, meter] = row as unknown[];
      if (!Number.isInteger(ts) || (ts as number) < MIN_TS || (ts as number) > maxTs) {
        return reply.code(400).send({ error: 'dati_non_validi', message: 'orario non valido' });
      }
      if (!Number.isInteger(mgdl) || (mgdl as number) < 20 || (mgdl as number) > 600) {
        return reply.code(400).send({ error: 'dati_non_validi', message: 'glicemia fuori intervallo' });
      }
      if (meter !== null && (typeof meter !== 'string' || meter.length > 60)) {
        return reply.code(400).send({ error: 'dati_non_validi', message: 'nome del glucometro non valido' });
      }
      rows.push([ts as number, mgdl as number, meter as string | null]);
    }
    const added = store.insertFingersticks(rows);
    hub.publish('f', added);
    return { n: added.length };
  });

  // ================================================================ static web UI

  const publicDir = opts.publicDir ?? fileURLToPath(new URL('../public/', import.meta.url));
  const files = loadStatic(publicDir);
  const serve = (name: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    const f = files.get(name)!;
    // The page is always revalidated (tiny 304s); a file asked for by its current hash never changes.
    const versioned = (req.query as { v?: string }).v === f.version && name !== 'index.html';
    reply.header('Content-Type', f.type).header('ETag', f.etag).header('Vary', 'Accept-Encoding')
      .header('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache')
    if (req.headers['if-none-match'] === f.etag) return reply.code(304).send();
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (enc) reply.header('Content-Encoding', enc);
    return reply.send(enc === 'br' ? f.br : enc === 'gzip' ? f.gz : f.raw);
  };
  for (const name of files.keys()) app.get(name === 'index.html' ? '/' : `/${name}`, serve(name));

  return app;
}
