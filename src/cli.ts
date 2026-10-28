import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { Store, USERNAME_RE } from './store.ts';
import { hashPassword, passwordProblem } from './security/password.ts';
import { newTotpSecret, otpauthUri } from './security/totp.ts';

/**
 * Server-side administration. The first account is created here (it becomes an
 * administrator); afterwards admins can manage users from the web page too.
 */
const HELP = `Uso: npm run user -- <comando>

  add <nome> [--admin] [--write]  crea un utente (chiede la password)
                                  il primo utente creato è sempre amministratore
                                  --write: un utente normale può anche caricare glicemie
  role <nome> admin|user          cambia il ruolo
  write <nome> on|off             utente normale: consenti o togli il caricamento
  passwd <nome>                   cambia la password e chiude tutte le sessioni web
  delete <nome>                   elimina l'utente (le glicemie restano)
  list                            elenca gli utenti
  unlock <nome>                   sblocca un account dopo troppi tentativi falliti
  totp-on <nome>                  attiva la verifica in due passaggi (codice a 6 cifre)
  totp-off <nome>                 disattiva la verifica in due passaggi
  backup <file>                   copia coerente del database (anche a server acceso)`;

/**
 * Line reader shared by all prompts. What is typed is never echoed (passwords);
 * also works with piped input, e.g. `docker compose exec -T`.
 */
let input: Interface | null = null;
const queued: string[] = [];
const waiting: ((line: string | null) => void)[] = [];
let ended = false;

function nextLine(): Promise<string | null> {
  if (!input) {
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    (input as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    input.on('line', (l) => (waiting.length ? waiting.shift()!(l) : queued.push(l)));
    input.on('close', () => {
      ended = true;
      waiting.splice(0).forEach((w) => w(null));
    });
  }
  if (queued.length) return Promise.resolve(queued.shift()!);
  if (ended) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
}

async function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const line = await nextLine();
  process.stdout.write('\n');
  return line ?? fail('Input terminato.');
}

async function newPassword(username: string): Promise<string> {
  for (;;) {
    const p1 = await askHidden('Password (almeno 12 caratteri): ');
    const problem = passwordProblem(p1, username);
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }
    if ((await askHidden('Ripeti la password: ')) === p1) return p1;
    console.log('  Le password non coincidono');
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const cfg = loadConfig();
const store = new Store(openDb(cfg.dbPath));
const args = process.argv.slice(2);
const flags = new Set(args.filter((x) => x.startsWith('--')));
const [cmd, a, b] = args.filter((x) => !x.startsWith('--'));
const need = (name: string | undefined) => {
  const u = name ? store.userByName(name) : null;
  return u ?? fail(`Utente "${name ?? ''}" non trovato`);
};
const describe = (role: string, canWrite: boolean) =>
  role === 'admin' ? 'amministratore' : canWrite ? 'utente (lettura e caricamento)' : 'utente (solo lettura)';

switch (cmd) {
  case 'add': {
    if (!a || !USERNAME_RE.test(a)) fail('Nome utente non valido: 3-32 caratteri tra lettere, numeri, . _ -');
    if (store.userByName(a)) fail(`L'utente "${a}" esiste già`);
    const first = store.countUsers() === 0;
    const role = first || flags.has('--admin') ? 'admin' : 'user';
    const canWrite = flags.has('--write');
    const id = store.createUser(a, await hashPassword(await newPassword(a), cfg.pepper), { role, canWrite });
    store.audit(id, 'account_creato', null);
    console.log(`Utente "${a}" creato: ${describe(role, canWrite)}.${first && !flags.has('--admin') ? ' (È il primo utente, quindi è amministratore.)' : ''}`);
    break;
  }
  case 'role': {
    const u = need(a);
    if (b !== 'admin' && b !== 'user') fail('Ruolo: admin oppure user');
    if (b === 'user' && u.role === 'admin' && store.countAdmins() <= 1) fail('Deve restare almeno un amministratore');
    store.setRole(u.id, b);
    store.audit(u.id, 'ruolo_cambiato', null, `${b} (da riga di comando)`);
    console.log(`"${u.username}" ora è ${describe(b, u.canWrite)}.`);
    break;
  }
  case 'write': {
    const u = need(a);
    if (b !== 'on' && b !== 'off') fail('Usa: write <nome> on|off');
    store.setCanWrite(u.id, b === 'on');
    store.audit(u.id, b === 'on' ? 'scrittura_consentita' : 'solo_lettura', null, 'riga di comando');
    console.log(u.role === 'admin'
      ? `"${u.username}" è amministratore: può comunque caricare.`
      : `"${u.username}" ora è ${describe('user', b === 'on')}.`);
    break;
  }
  case 'passwd': {
    const u = need(a);
    store.setPassword(u.id, await hashPassword(await newPassword(u.username), cfg.pepper));
    store.deleteUserSessions(u.id);
    store.audit(u.id, 'password_reimpostata', null, 'riga di comando');
    console.log('Password cambiata; tutte le sessioni web sono state chiuse.');
    break;
  }
  case 'delete': {
    const u = need(a);
    if (u.role === 'admin' && store.countAdmins() <= 1) fail('È l\'unico amministratore: nominane prima un altro');
    const confirm = await askHidden(`Scrivi "${u.username}" per eliminare l'utente: `);
    if (confirm !== u.username) fail('Annullato.');
    store.deleteUser(u.id);
    console.log('Utente eliminato.');
    break;
  }
  case 'list': {
    const users = store.listUsers();
    if (!users.length) console.log('Nessun utente. Crea l\'amministratore con: npm run user -- add <nome>');
    for (const u of users) {
      const locked = u.lockedUntil && u.lockedUntil * 1000 > Date.now() ? '  [bloccato]' : '';
      const last = u.lastLoginAt ? new Date(u.lastLoginAt * 1000).toLocaleString('it-IT') : 'mai';
      console.log(`${u.username.padEnd(20)} ${describe(u.role, u.canWrite).padEnd(32)} 2FA: ${u.totpSecret ? 'sì' : 'no'}   ultimo accesso: ${last}${locked}`);
    }
    const { count, last } = store.readingStats();
    console.log(`\nGlicemie salvate: ${count}${last ? `, ultima ${new Date(last * 1000).toLocaleString('it-IT')}` : ''}`);
    break;
  }
  case 'unlock': {
    store.unlock(need(a).id);
    console.log('Account sbloccato.');
    break;
  }
  case 'totp-on': {
    const u = need(a);
    const secret = newTotpSecret();
    store.setTotp(u.id, secret);
    store.audit(u.id, '2fa_attivata', null);
    console.log(`Verifica in due passaggi attiva per "${u.username}".
Aggiungi l'account nella tua app di autenticazione (Aegis, Google Authenticator, 1Password…)
inserendo questa chiave:

  ${secret.match(/.{1,4}/g)!.join(' ')}

oppure trasforma in QR code questo indirizzo:

  ${otpauthUri('G7 Monitor', u.username, secret)}

Da ora l'accesso chiede anche il codice a 6 cifre.`);
    break;
  }
  case 'totp-off': {
    const u = need(a);
    store.setTotp(u.id, null);
    store.audit(u.id, '2fa_disattivata', null);
    console.log('Verifica in due passaggi disattivata.');
    break;
  }
  case 'backup': {
    if (!a) fail('Indica il file di destinazione, es. npm run user -- backup data/backup.db');
    if (existsSync(a)) fail(`"${a}" esiste già`);
    store.db.prepare('VACUUM INTO ?').run(a);
    console.log(`Backup salvato in ${a}`);
    break;
  }
  default:
    console.log(HELP);
}

(input as Interface | null)?.close();
