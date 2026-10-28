export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Public address (e.g. https://glicemie.example.com), used to check the Origin of browser requests. */
  publicOrigin: string | null;
  /** false only for local tests over plain http on a LAN: cookies lose the Secure flag. */
  cookieSecure: boolean;
  /** true / list of proxy IPs when running behind a reverse proxy (nginx, Caddy, Traefik…). */
  trustProxy: boolean | string;
  /** Optional server-side secret mixed into every password hash (not stored in the database). */
  pepper: Buffer | null;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'si'].includes(v.toLowerCase());
}

/**
 * Accepts "glicemie.example.com", "https://glicemie.example.com/", quotes, spaces and a
 * doubled scheme (G7_DOMAIN written with https:// in docker-compose): returns the bare origin.
 */
export function normalizeOrigin(raw: string | undefined): string | null {
  let v = (raw ?? '').trim().replace(/^["']|["']$/g, '').trim();
  if (!v) return null;
  v = v.replace(/^(https?:\/\/)+(https?:\/\/)/i, '$2');
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`G7_ORIGIN non valido: "${raw}" (es. https://glicemie.example.com)`);
  }
  if (url.pathname.replace(/\/+$/, '') !== '' || url.search || url.hash || url.username) {
    throw new Error(`G7_ORIGIN deve essere solo l'indirizzo, senza percorsi: "${raw}" (es. https://glicemie.example.com)`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pepper = env.G7_PEPPER ?? '';
  if (pepper && pepper.length < 32) throw new Error('G7_PEPPER deve avere almeno 32 caratteri');
  const origin = normalizeOrigin(env.G7_ORIGIN);
  const trust = env.G7_TRUST_PROXY ?? '';
  return {
    host: env.G7_HOST || '127.0.0.1',
    port: Number(env.G7_PORT || 8080),
    dbPath: env.G7_DB || 'data/g7.db',
    publicOrigin: origin,
    cookieSecure: bool(env.G7_COOKIE_SECURE, true),
    trustProxy: trust === '' ? false : ['1', 'true'].includes(trust) ? true : trust,
    pepper: pepper ? Buffer.from(pepper, 'utf8') : null,
  };
}
