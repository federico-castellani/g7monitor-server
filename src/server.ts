import { SESSION_IDLE, SESSION_MAX, buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { Store } from './store.ts';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const store = new Store(db);
const app = buildApp(cfg, store);

if (!cfg.cookieSecure) app.log.warn('G7_COOKIE_SECURE=false: i cookie viaggiano anche senza HTTPS, usalo solo per prove in rete locale');
if (!cfg.publicOrigin) app.log.warn('G7_ORIGIN non impostato: l\'origine viene ricavata dall\'header Host');

const housekeeping = setInterval(() => {
  store.purge(SESSION_IDLE, SESSION_MAX);
  db.exec('PRAGMA optimize');
}, 3_600_000);
store.purge(SESSION_IDLE, SESSION_MAX);

async function shutdown(signal: string) {
  app.log.info(`${signal}: chiusura in corso`);
  clearInterval(housekeeping);
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: cfg.host, port: cfg.port });
