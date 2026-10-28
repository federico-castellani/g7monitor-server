import type { Store, User } from './store.ts';
import { now } from './store.ts';
import { dummyHash, hashPassword, verifyPassword } from './security/password.ts';
import { verifyTotp } from './security/totp.ts';

export interface Credentials { username: string; password: string; totp?: string }

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 429; error: string; message: string };

const INVALID = { ok: false, status: 401, error: 'credenziali_non_valide', message: 'Nome utente o password non validi' } as const;
const TOO_MANY = { ok: false, status: 429, error: 'troppi_tentativi', message: 'Troppi tentativi: riprova tra qualche minuto' } as const;

/**
 * Single login path for the web and for the app's device pairing.
 * - per-IP and per-account throttling (exponential lock after repeated failures)
 * - the same Argon2 work is done for unknown users (no account enumeration by timing)
 * - TOTP checked only after a correct password, with replay protection
 */
export async function authenticate(store: Store, pepper: Buffer | null, c: Credentials, ip: string): Promise<AuthResult> {
  if (store.ipBlocked(ip)) return TOO_MANY;
  const user = store.userByName(c.username);
  if (user?.lockedUntil && user.lockedUntil > now()) {
    store.audit(user.id, 'login_bloccato', ip);
    return TOO_MANY;
  }

  const { ok, needsRehash } = await verifyPassword(user?.passwordHash ?? await dummyHash(pepper), c.password, pepper);
  if (!user || !ok) {
    store.recordIpFailure(ip);
    if (user) {
      store.recordUserFailure(user.id);
      store.audit(user.id, 'password_errata', ip);
    }
    return INVALID;
  }

  if (user.totpSecret) {
    if (!c.totp) return { ok: false, status: 401, error: 'totp_richiesto', message: 'Inserisci il codice di verifica' };
    const step = verifyTotp(user.totpSecret, c.totp, user.totpLastStep);
    if (step === null) {
      store.recordIpFailure(ip);
      store.recordUserFailure(user.id);
      store.audit(user.id, 'codice_2fa_errato', ip);
      return { ok: false, status: 401, error: 'codice_non_valido', message: 'Codice di verifica non valido' };
    }
    store.setTotpStep(user.id, step);
  }

  store.recordLogin(user.id);
  if (needsRehash) store.rehashPassword(user.id, await hashPassword(c.password, pepper));
  return { ok: true, user };
}
