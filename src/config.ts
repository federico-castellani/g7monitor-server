export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Public address (e.g. https://glicemie.example.com), used to check the Origin of browser requests. */
  publicOrigin: string | null;
  /** false only for local tests over plain http on a LAN: cookies lose the Secure flag. */
  cookieSecure: boolean;
  /**
   * Addresses of the proxies in front of the server (nginx, Caddy, Traefik…), as proxy-addr
   * understands them. Never Fastify's "true": then the client's address would be the first entry
   * of X-Forwarded-For, which the client itself writes (spoofable per-IP throttling).
   */
  trustProxy: false | string;
  /**
   * Header set by a CDN with the real client address (e.g. CF-Connecting-IP with Cloudflare).
   * Used only on requests that arrive through a trusted proxy.
   */
  clientIpHeader: string | null;
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

/** Where a reverse proxy on the same machine or network connects from (Docker's gateway included). */
export const LOCAL_PROXIES = 'loopback, linklocal, uniquelocal';

/**
 * "" → no proxy. "true"/"1" (the usual setup: a reverse proxy on this machine, the port published
 * on localhost) → trust only local and private addresses: the first public address in
 * X-Forwarded-For is the client, whatever the client wrote before it. Anything else → the list
 * of proxy addresses.
 */
export function parseTrustProxy(raw: string | undefined): false | string {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return LOCAL_PROXIES;
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pepper = env.G7_PEPPER ?? '';
  if (pepper && pepper.length < 32) throw new Error('G7_PEPPER deve avere almeno 32 caratteri');
  const origin = normalizeOrigin(env.G7_ORIGIN);
  return {
    host: env.G7_HOST || '127.0.0.1',
    port: Number(env.G7_PORT || 8080),
    dbPath: env.G7_DB || 'data/g7.db',
    publicOrigin: origin,
    cookieSecure: bool(env.G7_COOKIE_SECURE, true),
    trustProxy: parseTrustProxy(env.G7_TRUST_PROXY),
    clientIpHeader: env.G7_CLIENT_IP_HEADER?.trim().toLowerCase() || null,
    pepper: pepper ? Buffer.from(pepper, 'utf8') : null,
  };
}
