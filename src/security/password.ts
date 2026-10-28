import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id, RFC 9106 "second recommended option" (64 MiB, 3 passes, 4 lanes).
 * Hashes are stored in the standard PHC format, so parameters can be raised later:
 * old hashes are upgraded transparently at the next successful login.
 */
const PARAMS = { memory: 65536, passes: 3, parallelism: 4, tagLength: 32 };

interface Params { memory: number; passes: number; parallelism: number; tagLength: number }

function derive(password: string, salt: Buffer, p: Params, pepper: Buffer | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', {
      // NFKC: the same password typed on different keyboards/OSes gives the same bytes.
      message: password.normalize('NFKC'),
      nonce: salt,
      memory: p.memory,
      passes: p.passes,
      parallelism: p.parallelism,
      tagLength: p.tagLength,
      ...(pepper ? { secret: pepper } : {}),
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string, pepper: Buffer | null): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS, pepper);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(key)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(
  stored: string, password: string, pepper: Buffer | null,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const m = PHC.exec(stored);
  if (!m) return { ok: false, needsRehash: false };
  const expected = Buffer.from(m[5], 'base64');
  const p = { memory: +m[1], passes: +m[2], parallelism: +m[3], tagLength: expected.length };
  const key = await derive(password, Buffer.from(m[4], 'base64'), p, pepper);
  const ok = timingSafeEqual(key, expected);
  const needsRehash = ok && (p.memory !== PARAMS.memory || p.passes !== PARAMS.passes
    || p.parallelism !== PARAMS.parallelism || p.tagLength !== PARAMS.tagLength);
  return { ok, needsRehash };
}

let dummy: Promise<string> | null = null;

/**
 * Hash of a random password, verified when the username does not exist so that
 * the response time does not reveal which accounts exist.
 */
export function dummyHash(pepper: Buffer | null): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64'), pepper);
  return dummy;
}

/** NIST SP 800-63B style: long enough, no composition rules. @return an error message or null. */
export function passwordProblem(password: string, username: string): string | null {
  const len = [...password].length;
  if (len < 12) return 'La password deve avere almeno 12 caratteri';
  if (len > 256) return 'La password può avere al massimo 256 caratteri';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'La password non deve contenere il nome utente';
  if (new Set(password).size < 6) return 'La password è troppo ripetitiva';
  if (WEAK.some((w) => password.toLowerCase().includes(w))) return 'La password è troppo facile da indovinare';
  return null;
}

const WEAK = ['password', '123456', 'qwerty', 'abcdef', 'glicemia', 'dexcom', 'iloveyou', 'admin'];
