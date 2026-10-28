import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { normalizeOrigin } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import type { Role } from '../src/store.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../src/security/password.ts';
import { base32Decode, base32Encode, newTotpSecret, totpCode, verifyTotp } from '../src/security/totp.ts';

const ORIGIN = 'https://g7.test';
const PASSWORD = 'cavallo-batteria-graffetta';

const cfg: Config = {
  host: '127.0.0.1', port: 0, dbPath: ':memory:', publicOrigin: ORIGIN,
  cookieSecure: true, trustProxy: false, pepper: Buffer.from('p'.repeat(32)),
};

function setup() {
  const store = new Store(openDb(':memory:'));
  const app = buildApp(cfg, store, { logger: false });
  return { store, app };
}

async function addUser(store: Store, name: string, role: Role = 'user', canWrite = false): Promise<number> {
  return store.createUser(name, await hashPassword(PASSWORD, cfg.pepper), { role, canWrite });
}

async function login(app: FastifyInstance, username: string, password = PASSWORD, totp?: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
    payload: { username, password, ...(totp ? { totp } : {}) },
  });
  const set = String(res.headers['set-cookie'] ?? '');
  return { res, cookie: set.split(';')[0], set };
}

const pairRequest = (app: FastifyInstance, username: string, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/api/v1/devices', payload: { username, password, name: 'Pixel' } });

async function pair(app: FastifyInstance, username: string): Promise<string> {
  const res = await pairRequest(app, username);
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token;
}

/** Browser call with session cookie and same-origin header. */
const web = (app: FastifyInstance, cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie, origin: ORIGIN }, ...(payload ? { payload } : {}) });

// ------------------------------------------------------------------ config

describe('config', () => {
  test('G7_ORIGIN accepts the usual ways of writing the domain', () => {
    for (const v of ['glicemie.example.com', 'https://glicemie.example.com', 'https://glicemie.example.com/',
      ' "https://glicemie.example.com" ', 'https://https://glicemie.example.com', 'HTTPS://Glicemie.Example.com']) {
      assert.equal(normalizeOrigin(v), 'https://glicemie.example.com', v);
    }
    assert.equal(normalizeOrigin('http://192.168.1.10:8080'), 'http://192.168.1.10:8080');
    assert.equal(normalizeOrigin('https://g7.example.com:8443'), 'https://g7.example.com:8443');
    assert.equal(normalizeOrigin(''), null);
    assert.equal(normalizeOrigin(undefined), null);
    assert.throws(() => normalizeOrigin('https://glicemie.example.com/app'), /senza percorsi/);
  });
});

// ------------------------------------------------------------------ crypto

describe('password', () => {
  test('hash and verify (Argon2id, PHC format)', async () => {
    const h = await hashPassword(PASSWORD, null);
    assert.match(h, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    assert.deepEqual(await verifyPassword(h, PASSWORD, null), { ok: true, needsRehash: false });
    assert.equal((await verifyPassword(h, PASSWORD + 'x', null)).ok, false);
  });

  test('the pepper is part of the hash', async () => {
    const h = await hashPassword(PASSWORD, Buffer.from('a'.repeat(32)));
    assert.equal((await verifyPassword(h, PASSWORD, Buffer.from('b'.repeat(32)))).ok, false);
  });

  test('policy', () => {
    assert.ok(passwordProblem('corta', 'fede'));
    assert.ok(passwordProblem('fede-1234567890', 'fede'));
    assert.ok(passwordProblem('aaaaaaaaaaaaaaaa', 'x'));
    assert.equal(passwordProblem(PASSWORD, 'fede'), null);
  });
});

describe('totp', () => {
  test('RFC 6238 test vector (T = 59 s)', () => {
    assert.equal(totpCode(Buffer.from('12345678901234567890'), 1, 8), '94287082');
  });

  test('base32 round trip', () => {
    const s = newTotpSecret();
    assert.equal(base32Encode(base32Decode(s)), s);
  });

  test('accepts ±1 step, never the same step twice', () => {
    const secret = newTotpSecret();
    const t = 1_700_000_000_000;
    const step = Math.floor(t / 30_000);
    const code = totpCode(base32Decode(secret), step);
    assert.equal(verifyTotp(secret, code, null, t), step);
    assert.equal(verifyTotp(secret, code, null, t + 30_000), step);
    assert.equal(verifyTotp(secret, code, step, t), null);
    assert.equal(verifyTotp(secret, totpCode(base32Decode(secret), step - 2), null, t), null);
  });
});

// ------------------------------------------------------------------ web login

describe('web authentication', () => {
  let app: FastifyInstance, store: Store;
  before(async () => {
    ({ app, store } = setup());
    await addUser(store, 'fede', 'admin');
  });

  test('session cookie is HttpOnly, Secure, SameSite=Strict, __Host-', async () => {
    const { res, set } = await login(app, 'fede');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().role, 'admin');
    assert.match(set, /^__Host-g7s=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  });

  test('username is case insensitive, wrong password is a generic error', async () => {
    assert.equal((await login(app, 'FEDE')).res.statusCode, 200);
    const bad = await login(app, 'fede', 'sbagliata-sbagliata');
    assert.equal(bad.res.statusCode, 401);
    const missing = await login(app, 'nessuno', 'sbagliata-sbagliata');
    assert.deepEqual(missing.res.json(), bad.res.json());
  });

  test('requests from another origin are refused (CSRF)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { username: 'fede', password: PASSWORD } });
    assert.equal(res.statusCode, 403);
    const noOrigin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'fede', password: PASSWORD } });
    assert.equal(noOrigin.statusCode, 403);
  });

  test('protected endpoints need a session; logout invalidates it', async () => {
    assert.equal((await app.inject({ url: '/api/me' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/readings' })).statusCode, 401);
    const { cookie } = await login(app, 'fede');
    assert.equal((await web(app, cookie, 'GET', '/api/me')).json().username, 'fede');
    await web(app, cookie, 'POST', '/api/auth/logout');
    assert.equal((await web(app, cookie, 'GET', '/api/me')).statusCode, 401);
  });

  test('account is locked after repeated failures', async () => {
    const id = await addUser(store, 'lock');
    for (let i = 0; i < 5; i++) assert.equal((await login(app, 'lock', 'sbagliata-sbagliata')).res.statusCode, 401);
    assert.equal((await login(app, 'lock')).res.statusCode, 429);
    store.unlock(id);
    assert.equal((await login(app, 'lock')).res.statusCode, 200);
  });

  test('two-factor login, with replay protection', async () => {
    const id = await addUser(store, 'tfa');
    const secret = newTotpSecret();
    store.setTotp(id, secret);
    const first = await login(app, 'tfa');
    assert.equal(first.res.statusCode, 401);
    assert.equal(first.res.json().error, 'totp_richiesto');
    const code = totpCode(base32Decode(secret), Math.floor(Date.now() / 30_000));
    assert.equal((await login(app, 'tfa', PASSWORD, code)).res.statusCode, 200);
    assert.equal((await login(app, 'tfa', PASSWORD, code)).res.statusCode, 401);
  });

  test('changing password logs out the other browsers', async () => {
    await addUser(store, 'cambio');
    const a = await login(app, 'cambio');
    const b = await login(app, 'cambio');
    assert.equal((await web(app, a.cookie, 'POST', '/api/me/password', { current: PASSWORD, next: 'corta' })).statusCode, 400);
    assert.equal((await web(app, a.cookie, 'POST', '/api/me/password', { current: PASSWORD, next: 'nuova-frase-segreta-lunga' })).statusCode, 200);
    assert.equal((await web(app, a.cookie, 'GET', '/api/me')).statusCode, 200);
    assert.equal((await web(app, b.cookie, 'GET', '/api/me')).statusCode, 401);
    assert.equal((await login(app, 'cambio', 'nuova-frase-segreta-lunga')).res.statusCode, 200);
  });

  test('security headers', async () => {
    const res = await app.inject({ url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-security-policy']), /default-src 'none'; script-src 'self'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(String(res.headers['strict-transport-security']), /max-age=31536000/);
  });
});

// ------------------------------------------------------------------ roles and user management

describe('roles', () => {
  let app: FastifyInstance, store: Store, admin: string;
  before(async () => {
    ({ app, store } = setup());
    await addUser(store, 'admin', 'admin');
    await addUser(store, 'lettore');
    admin = (await login(app, 'admin')).cookie;
  });

  test('normal users cannot use the admin API', async () => {
    const reader = (await login(app, 'lettore')).cookie;
    assert.equal((await web(app, reader, 'GET', '/api/admin/users')).statusCode, 403);
    assert.equal((await web(app, reader, 'POST', '/api/admin/users', { username: 'x12', password: PASSWORD, role: 'admin', canWrite: true })).statusCode, 403);
    assert.equal((await web(app, admin, 'GET', '/api/admin/users')).statusCode, 200);
  });

  test('read-only users can read but cannot pair a phone', async () => {
    const reader = (await login(app, 'lettore')).cookie;
    assert.equal((await web(app, reader, 'GET', '/api/readings')).statusCode, 200);
    const res = await pairRequest(app, 'lettore');
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'scrittura_non_consentita');
  });

  test('revoking write permission stops the phone immediately', async () => {
    const id = await addUser(store, 'scrittore', 'user', true);
    const token = await pair(app, 'scrittore');
    const send = () => app.inject({
      method: 'POST', url: '/api/v1/readings', headers: { authorization: `Bearer ${token}` },
      payload: { b: Math.floor(Date.now() / 1000) - 60, r: [[0, 100, 0, 0]] },
    });
    assert.equal((await send()).statusCode, 200);
    assert.equal((await web(app, admin, 'PATCH', `/api/admin/users/${id}`, { canWrite: false })).statusCode, 200);
    assert.equal((await send()).statusCode, 403);
    // the phone may still revoke its own token
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/devices/self', headers: { authorization: `Bearer ${token}` } })).statusCode, 204);
  });

  test('admin creates a user with a temporary password that must be changed', async () => {
    const created = await web(app, admin, 'POST', '/api/admin/users', { username: 'nuovo', password: 'temporanea-1234-abcd', role: 'user', canWrite: true });
    assert.equal(created.statusCode, 201);
    assert.equal((await web(app, admin, 'POST', '/api/admin/users', { username: 'NUOVO', password: 'temporanea-1234-abcd', role: 'user', canWrite: false })).statusCode, 409);

    const { res, cookie } = await login(app, 'nuovo', 'temporanea-1234-abcd');
    assert.equal(res.json().mustChangePassword, true);
    const blocked = await web(app, cookie, 'GET', '/api/readings');
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error, 'cambio_password_richiesto');
    assert.equal((await pairRequest(app, 'nuovo', 'temporanea-1234-abcd')).statusCode, 403);

    const changed = await web(app, cookie, 'POST', '/api/me/password', { current: 'temporanea-1234-abcd', next: 'la-mia-frase-segreta' });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().mustChangePassword, false);
    assert.equal((await web(app, cookie, 'GET', '/api/readings')).statusCode, 200);
  });

  test('admin resets a password: the user is logged out and must change it', async () => {
    const id = await addUser(store, 'smemorato');
    const { cookie } = await login(app, 'smemorato');
    assert.equal((await web(app, admin, 'POST', `/api/admin/users/${id}/password`, { password: 'reset-temporaneo-9876' })).statusCode, 204);
    assert.equal((await web(app, cookie, 'GET', '/api/me')).statusCode, 401);
    assert.equal((await login(app, 'smemorato')).res.statusCode, 401);
    assert.equal((await login(app, 'smemorato', 'reset-temporaneo-9876')).res.json().mustChangePassword, true);
  });

  test('promotion, and at least one admin always remains', async () => {
    const me = (await web(app, admin, 'GET', '/api/me')).json();
    assert.equal((await web(app, admin, 'PATCH', `/api/admin/users/${me.id}`, { role: 'user' })).statusCode, 400);
    assert.equal((await web(app, admin, 'DELETE', `/api/admin/users/${me.id}`)).statusCode, 400);

    const id = store.userByName('lettore')!.id;
    assert.equal((await web(app, admin, 'PATCH', `/api/admin/users/${id}`, { role: 'admin' })).json().canWrite, true);
    const reader = (await login(app, 'lettore')).cookie;
    assert.equal((await web(app, reader, 'GET', '/api/admin/users')).statusCode, 200);
    // the new admin can demote the first one, but not the last admin left
    assert.equal((await web(app, reader, 'PATCH', `/api/admin/users/${me.id}`, { role: 'user' })).statusCode, 200);
    assert.equal((await web(app, admin, 'GET', '/api/admin/users')).statusCode, 403); // role change applies at once
    assert.equal((await web(app, reader, 'PATCH', `/api/admin/users/${id}`, { role: 'user' })).statusCode, 400);
  });

  test('any user can pair a follower phone that only reads', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/devices', payload: { username: 'ospite2', password: PASSWORD, name: 'Telefono', kind: 'reader' } });
    assert.equal(res.statusCode, 401); // unknown user
    await addUser(store, 'ospite2'); // read-only account
    const paired = await app.inject({ method: 'POST', url: '/api/v1/devices', payload: { username: 'ospite2', password: PASSWORD, name: 'Telefono', kind: 'reader' } });
    assert.equal(paired.statusCode, 201);
    const auth = { authorization: `Bearer ${paired.json().token}` };
    const t = Math.floor(Date.now() / 1000);
    const list = await app.inject({ url: `/api/v1/readings?since=${t - 86400}`, headers: auth });
    assert.equal(list.statusCode, 200);
    assert.ok(Array.isArray(list.json().r));
    const up = await app.inject({ method: 'POST', url: '/api/v1/readings', headers: auth, payload: { b: t - 60, r: [[0, 100, 0, 0]] } });
    assert.equal(up.statusCode, 403);
    assert.equal(up.json().error, 'token_di_sola_lettura');
  });

  test('deleting a user keeps the readings', async () => {
    const before = store.readingStats().count;
    const id = await addUser(store, 'temporaneo', 'user', true);
    const token = await pair(app, 'temporaneo');
    await app.inject({ method: 'POST', url: '/api/v1/readings', headers: { authorization: `Bearer ${token}` }, payload: { b: Math.floor(Date.now() / 1000) - 3600, r: [[0, 140, 0, 1]] } });
    const lettore = (await login(app, 'lettore')).cookie; // admin now
    assert.equal((await web(app, lettore, 'DELETE', `/api/admin/users/${id}`)).statusCode, 204);
    assert.equal(store.readingStats().count, before + 1);
    assert.equal((await app.inject({ url: '/api/v1/status', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  });
});

// ------------------------------------------------------------------ upload from the app

describe('upload', () => {
  let app: FastifyInstance, store: Store, token: string, cookie: string;
  const base = Math.floor(Date.now() / 1000) - 3600;

  before(async () => {
    ({ app, store } = setup());
    await addUser(store, 'fede', 'admin');
    await addUser(store, 'ospite');
    token = await pair(app, 'fede');
    cookie = (await login(app, 'fede')).cookie;
  });

  const upload = (body: unknown, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: '/api/v1/readings',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

  test('device token is stored hashed', async () => {
    assert.match(token, /^g7d_[A-Za-z0-9_-]{43}$/);
    const row = store.db.prepare('SELECT token_hash FROM devices').get() as { token_hash: Uint8Array };
    assert.equal(row.token_hash.length, 32);
  });

  test('compact rows with time deltas; duplicates are ignored; every user reads them', async () => {
    const body = { b: base, r: [[0, 110, 5, 0], [300, 118, 15, 0], [300, 125, null, 1]] };
    const first = await upload(body);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { n: 3 });
    assert.deepEqual((await upload(body)).json(), { n: 0 });
    const expected = [[base, 110, 5, 0], [base + 300, 118, 15, 0], [base + 600, 125, null, 1]];
    assert.deepEqual((await web(app, cookie, 'GET', `/api/readings?from=${base - 10}`)).json().r, expected);
    const guest = (await login(app, 'ospite')).cookie;
    assert.deepEqual((await web(app, guest, 'GET', `/api/readings?from=${base - 10}`)).json().r, expected);
  });

  test('the same reading sent again with a slightly different time is not duplicated', async () => {
    const t = base - 2 * 86400; // away from the other tests' readings
    assert.equal((await upload({ b: t, r: [[0, 140, 0, 0]] })).json().n, 1);
    // after a phone reset the backfill recomputes the time: a couple of seconds off
    assert.equal((await upload({ b: t + 2, r: [[0, 140, 0, 1]] })).json().n, 0);
    assert.equal((await upload({ b: t - 90, r: [[0, 140, 0, 1]] })).json().n, 0);
    // two rows of the same batch that are the same reading
    assert.equal((await upload({ b: t + 300, r: [[0, 150, 0, 1], [40, 150, 0, 0]] })).json().n, 1);
    // the next genuine reading, 5 minutes later, is kept
    assert.equal((await upload({ b: t + 600, r: [[0, 160, 0, 0]] })).json().n, 1);
    const stored = store.readings(t - 300, t + 900);
    assert.deepEqual(stored.map((r) => r[0]), [t, t + 300, t + 600]);
  });

  test('accepts the exact body produced by the Android app (ServerApiTest.kt)', async () => {
    const body = '{"b":1761660000,"r":[[0,110,5,0],[300,118,null,1],[300,39,null,0],[301,401,-250,0]]}';
    const res = await upload(body);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().n, 4);
  });

  test('gzip body', async () => {
    const rows = Array.from({ length: 288 }, (_, i) => [i === 0 ? 0 : 300, 100 + (i % 50), 0, 1]);
    const raw = JSON.stringify({ b: base - 86400, r: rows });
    const gz = gzipSync(raw);
    assert.ok(gz.length < raw.length / 3);
    const res = await upload(gz, { 'content-encoding': 'gzip' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().n, 288);
  });

  test('invalid data and tokens are refused', async () => {
    assert.equal((await upload({ b: base, r: [[0, 500, 0, 0]] })).statusCode, 400);
    assert.equal((await upload({ b: base, r: [[0, 100, 0, 7]] })).statusCode, 400);
    assert.equal((await upload({ b: Math.floor(Date.now() / 1000) + 86400, r: [[0, 100, 0, 0]] })).statusCode, 400);
    assert.equal((await upload('{"b":', { 'content-type': 'application/json' })).statusCode, 400);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/readings', headers: { authorization: 'Bearer g7d_' + 'A'.repeat(43) }, payload: { b: base, r: [] } });
    assert.equal(bad.statusCode, 401);
  });

  test('a phone revoked from the web can no longer upload', async () => {
    const t2 = await pair(app, 'fede');
    const devices = (await web(app, cookie, 'GET', '/api/devices')).json();
    assert.equal(devices[0].username, 'fede');
    assert.equal((await web(app, cookie, 'DELETE', `/api/devices/${devices[0].id}`)).statusCode, 204);
    const res = await app.inject({ method: 'POST', url: '/api/v1/readings', headers: { authorization: `Bearer ${t2}` }, payload: { b: base, r: [] } });
    assert.equal(res.statusCode, 401);
  });

  test('public info lets the app recognise the server', async () => {
    const res = await app.inject({ url: '/api/v1/info' });
    assert.deepEqual(res.json(), { service: 'g7monitor', api: 1, version: 'dev' });
  });

  test('follower polling returns only newer readings, oldest first', async () => {
    const res = await app.inject({ url: `/api/v1/readings?since=${base + 300}`, headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(res.json().r.slice(0, 1), [[base + 600, 125, null, 1]]);
    const none = await app.inject({ url: `/api/v1/readings?since=${Math.floor(Date.now() / 1000)}`, headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(none.json().r, []);
  });

  test('large responses are compressed', async () => {
    const res = await app.inject({ url: `/api/readings?from=${base - 90000}`, headers: { cookie, 'accept-encoding': 'br, gzip' } });
    assert.equal(res.headers['content-encoding'], 'br');
  });
});

// ------------------------------------------------------------------ live stream for phones

describe('live stream', () => {
  test('a follower phone gets the missed readings, then each new one as soon as it is uploaded', async () => {
    const { app, store } = setup();
    await addUser(store, 'fede', 'admin');
    await addUser(store, 'ospite');
    const uploader = await pair(app, 'fede');
    const readerRes = await app.inject({ method: 'POST', url: '/api/v1/devices', payload: { username: 'ospite', password: PASSWORD, name: 'Telefono', kind: 'reader' } });
    const reader = readerRes.json().token as string;
    const t = Math.floor(Date.now() / 1000) - 900;
    const upload = (b: number, mgdl: number) => app.inject({
      method: 'POST', url: '/api/v1/readings', headers: { authorization: `Bearer ${uploader}` }, payload: { b, r: [[0, mgdl, 0, 0]] },
    });
    await upload(t, 111); // uploaded while the follower was offline

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    try {
      assert.equal((await fetch(`${address}/api/v1/readings/stream?since=0`)).status, 401);
      const res = await fetch(`${address}/api/v1/readings/stream?since=${t - 60}`, {
        headers: { authorization: `Bearer ${reader}` }, signal: abort.signal,
      });
      assert.equal(res.status, 200);
      assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
      const reader$ = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const nextData = async () => {
        for (;;) {
          const i = buffer.indexOf('data: ');
          const end = i >= 0 ? buffer.indexOf('\n\n', i) : -1;
          if (end >= 0) {
            const json = buffer.slice(i + 6, end);
            buffer = buffer.slice(end + 2);
            return JSON.parse(json);
          }
          const { value, done } = await reader$.read();
          if (done) throw new Error('stream closed');
          buffer += decoder.decode(value, { stream: true });
        }
      };
      assert.deepEqual(await nextData(), [[t, 111, 0, 0]]); // backlog
      const started = Date.now();
      await upload(t + 300, 122);
      assert.deepEqual(await nextData(), [[t + 300, 122, 0, 0]]); // pushed live
      assert.ok(Date.now() - started < 1000);
    } finally {
      abort.abort();
      await app.close();
    }
  });
});
