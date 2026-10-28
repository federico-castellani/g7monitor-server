# G7 Monitor Server

Server per [G7 Monitor](https://github.com/federico-castellani/g7monitor). Raccoglie le glicemie di **una persona**, inviate dall'app Android, e le mostra in un'interfaccia web a chi ha un account.

> ⚠️ **Non è un dispositivo medico.** Progetto personale/sperimentale.

## Cosa fa

- **Interfaccia web**: valore attuale con freccia di tendenza, grafico 3 h / 6 h / 12 h / 24 h / 7 giorni (tocca o passa sopra per leggere il singolo valore), tempo nei range, media, GMI, variabilità. Tema chiaro/scuro, adatta al telefono, installabile come app.
- **Aggiornamento in tempo reale**: la pagina riceve le letture appena il telefono le carica (Server-Sent Events), senza ricaricare.
- **Due ruoli**:
  - *amministratore*: vede e carica le glicemie e gestisce gli utenti dal sito, cioè li crea, cambia ruolo e permessi, reimposta password, sblocca ed elimina;
  - *utente*: vede le glicemie e, se un amministratore lo consente, può anche caricarle (collegare un telefono).

  Il permesso di caricare viene controllato a ogni invio: se lo togli, il telefono smette subito di caricare.
- **Caricamento efficiente dall'app**: formato compatto, gzip, nessun risveglio extra del telefono (vedi sotto).

## Tecnologie

- **Node.js 24** con TypeScript eseguito direttamente, senza compilazione. Unica dipendenza: **Fastify**.
- **SQLite** integrato in Node (`node:sqlite`):
  - modalità WAL;
  - tabelle `STRICT`;
  - letture in una tabella `WITHOUT ROWID` con chiave l'ora della lettura, quindi ogni grafico è una sola lettura sequenziale su disco.

  Non serve un server di database a parte e il backup è un solo file.
- **Argon2id** integrato in Node (`crypto.argon2`) per le password.

## Sicurezza

| | |
|---|---|
| Password | Argon2id (64 MiB, 3 passaggi, 4 corsie: RFC 9106) in formato PHC, con aggiornamento automatico dei parametri al login. "Pepper" facoltativo fuori dal database (`G7_PEPPER`). Regole NIST: almeno 12 caratteri, niente password ovvie o contenenti il nome utente. |
| Account | Nessuna registrazione pubblica: il primo amministratore si crea dal server (`npm run user`), gli altri utenti li crea un amministratore. Chi riceve una password temporanea, alla creazione o dopo un reset, deve cambiarla al primo accesso, e fino ad allora non vede nulla. Deve sempre restare almeno un amministratore. |
| Tentativi | Blocco progressivo dell'account dopo 5 errori (1, 2, 4… minuti, max 1 h) e limite di 20 errori per IP ogni 15 minuti. Stesso tempo di risposta per utenti esistenti e inesistenti, stesso messaggio d'errore. |
| 2FA | Verifica in due passaggi TOTP facoltativa (Aegis, Google Authenticator…), con protezione dal riutilizzo del codice. |
| Sessioni | Cookie `__Host-` `HttpOnly` `Secure` `SameSite=Strict` con 256 bit casuali; nel database solo l'hash SHA-256. Scadenza dopo 14 giorni di inattività e comunque dopo 60. Nuovo ID a ogni login. Il cambio password chiude gli altri browser. |
| CSRF | `SameSite=Strict` più controllo di `Origin` e `Sec-Fetch-Site` su ogni richiesta che modifica dati. |
| Telefoni | Ogni telefono ha un proprio token (256 bit, salvato come hash), che può solo caricare letture ed è revocabile dal sito o dall'app. Il permesso di caricare del suo utente viene ricontrollato a ogni invio. La password non resta sul telefono. |
| Header | CSP senza script inline, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, `Permissions-Policy`. |
| Dati | Validazione stretta di ogni richiesta. Limite di dimensione applicato anche dopo la decompressione (niente "zip bomb"). Registro delle attività di sicurezza, comprese le modifiche fatte da un amministratore, visibile all'utente. |
| Deploy | HTTPS dal tuo reverse proxy; il container ascolta solo su localhost. Container non-root, file system in sola lettura, nessuna capability Linux. |

## Telefoni che ricevono (modalità "Dal server")

Il telefono non tiene una connessione sempre aperta, che sveglierebbe la radio ogni pochi secondi. Chiede `GET /api/v1/readings?since=…` appena dopo il momento in cui è attesa la prossima lettura (ultima lettura + 5 minuti + 20 secondi), quindi ogni richiesta porta di solito una sola lettura nuova. Se i dati sono in ritardo riprova ogni 2 minuti; dopo un errore aspetta 1, 2, 4… fino a 15 minuti.

## Caricamento dall'app: batteria e dati

- **Nessun timer proprio**: l'app invia subito dopo aver ricevuto una lettura dal G7, quando il telefono è già sveglio per il Bluetooth. Così la radio si accende una volta sola.
- **Un'unica richiesta** con tutte le letture in attesa, comprese quelle recuperate dal backfill. Il formato è `[secondi dal precedente, mg/dL, tendenza×10, origine]`, circa **15 byte per lettura**: una giornata intera pesa circa 4 KB, poco più di 1 KB con gzip.
- **Frequenza regolabile** (5, 15, 30 o 60 minuti) e opzione **solo Wi-Fi**.
- **Pausa crescente in caso di errore**: se manca la rete o il server non risponde, i tentativi si diradano fino a uno all'ora. Le letture restano sul telefono e partono tutte insieme appena possibile.

## Avvio in locale

Serve Node.js 24.7 o successivo.

```bash
npm install
npm run user -- add federico        # il primo utente è sempre amministratore
npm run dev
```

Poi apri http://localhost:8080 (in locale i cookie `Secure` funzionano anche senza HTTPS).

Per collegare il telefono serve un indirizzo **https**: l'app rifiuta http, quindi usa il deploy qui sotto o un tunnel HTTPS.

## Pubblicazione (Docker dietro il tuo reverse proxy)

Il TLS lo gestisce il tuo reverse proxy. Il container ascolta solo su `127.0.0.1:8080`, quindi non è raggiungibile da fuori senza passare dal proxy.

1. Configura e avvia:
   ```bash
   cp .env.example .env          # G7_DOMAIN = il dominio pubblico del proxy
   docker compose up -d --build
   docker compose exec g7server node src/cli.ts add federico   # primo amministratore
   ```
2. Nel reverse proxy inoltra `https://glicemie.example.com` a `http://127.0.0.1:8080`:
   - passa gli header `Host`, `X-Forwarded-For` e `X-Forwarded-Proto`;
   - accetta corpi fino a 1 MB;
   - per `/api/readings/stream` (aggiornamento live del sito) disattiva il buffering e usa un timeout di lettura lungo.

   Esempio con nginx:
   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       client_max_body_size 1m;
   }
   location /api/readings/stream {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_buffering off;
       proxy_read_timeout 1h;
   }
   ```
   Se il proxy gira in un container Docker, collegalo alla stessa rete di `g7server` e inoltra a `http://g7server:8080`.
3. Nell'app:
   - **telefono con il sensore**: *Impostazioni → Server (caricamento) → Configura server*. Inserisci l'indirizzo `glicemie.example.com`; se il server risponde, si apre la pagina delle credenziali. Serve un account con il permesso di caricare.
   - **telefono che riceve**: al primo avvio scegli *Dal server*, oppure *Impostazioni → Origine dei dati → Server*. Poi indirizzo e credenziali: basta un account in sola lettura.

## Gestione utenti

Dal sito: un amministratore usa l'icona **Utenti** in alto. Da lì crea gli utenti con una password temporanea generata, sceglie il ruolo, concede o toglie il permesso di caricare, reimposta password, sblocca ed elimina.

Dalla riga di comando del server:

```bash
npm run user -- add <nome> [--admin] [--write]  # crea un utente (il primo è sempre amministratore)
npm run user -- role <nome> admin|user          # cambia il ruolo
npm run user -- write <nome> on|off             # utente normale: può caricare oppure no
npm run user -- passwd <nome>                   # nuova password (chiude le sessioni web)
npm run user -- totp-on <nome>                  # attiva la verifica in due passaggi
npm run user -- unlock <nome>                   # sblocca dopo troppi tentativi
npm run user -- list
npm run user -- backup data/backup.db           # copia coerente, anche a server acceso
```

Eliminare un utente non cancella le glicemie: appartengono al server, non agli account.

Con Docker: `docker compose exec g7server node src/cli.ts <comando>`.

## Configurazione

| Variabile | Predefinito | |
|---|---|---|
| `G7_HOST` / `G7_PORT` | `127.0.0.1` / `8080` | indirizzo di ascolto |
| `G7_DB` | `data/g7.db` | file del database |
| `G7_ORIGIN` | — | indirizzo pubblico (es. `https://glicemie.example.com`), usato per il controllo CSRF |
| `G7_TRUST_PROXY` | — | `true` dietro un reverse proxy |
| `G7_PEPPER` | — | segreto di almeno 32 caratteri per le password; se lo perdi, le password vanno reimpostate |
| `G7_COOKIE_SECURE` | `true` | `false` solo per prove in rete locale senza HTTPS |

## API

| Metodo | Percorso | Autenticazione | |
|---|---|---|---|
| GET | `/api/v1/info` | nessuna | permette all'app di riconoscere un server G7 Monitor prima di chiedere le credenziali |
| POST | `/api/v1/devices` | nome utente e password (+ TOTP) | collega un telefono e restituisce il token: `kind: "uploader"` per caricare (serve il permesso di caricare), `"reader"` per ricevere |
| GET | `/api/v1/readings?since=` | `Bearer` (anche in sola lettura) | letture successive a `since`, per i telefoni che ricevono |
| POST | `/api/v1/readings` | `Bearer` token di caricamento | carica letture (`Content-Encoding: gzip` facoltativo) |
| GET | `/api/v1/status` | `Bearer` | account e ultima lettura |
| DELETE | `/api/v1/devices/self` | `Bearer` | il telefono revoca il proprio token |
| GET | `/api/readings?from=&to=` | cookie | letture (max 90 giorni per richiesta) |
| GET | `/api/readings/stream` | cookie | nuove letture in tempo reale (SSE) |
| GET/POST | `/api/admin/users` | cookie, amministratore | elenco e creazione utenti |
| PATCH/DELETE | `/api/admin/users/:id` | cookie, amministratore | ruolo, permesso di caricare, sblocco; eliminazione |
| POST | `/api/admin/users/:id/password` | cookie, amministratore | password temporanea |

## Test

```bash
npm test        # 31 test: crittografia, login, blocchi, 2FA, CSRF, ruoli e permessi, caricamento e ricezione
npm run check   # controllo dei tipi TypeScript
```

## Licenza

GPLv3, come G7 Monitor.
