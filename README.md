# G7 Monitor Server

Server per [G7 Monitor](https://github.com/federico-castellani/g7monitor). Raccoglie le glicemie di **una persona**, inviate dall'app Android, e le mostra in un'interfaccia web a chi ha un account.

> ⚠️ **Non è un dispositivo medico.** Progetto personale/sperimentale.

## Cosa fa

- **Interfaccia web**: valore attuale con freccia di tendenza, grafico 3 h / 6 h / 12 h / 24 h / 7 giorni (tocca o passa sopra per leggere il singolo valore), tempo nei range, media, GMI, variabilità. Tema chiaro/scuro, adatta al telefono, installabile come app.
- **Report** (scheda *Report*, 7/14/30/90 giorni), sul modello del report AGP e del consenso internazionale sul tempo nel range (2019): parametri principali (media, GMI, CV, deviazione standard, uso del sensore, range stretto 70–140), tempo nei 5 intervalli con gli obiettivi, profilo glicemico ambulatoriale (percentili 5–95 per ora del giorno), andamenti per fascia oraria con gli episodi di bassa e alta, confronto con il periodo precedente, glucometro rispetto al sensore (MARD), giorno per giorno, statistiche orarie. Si stampa o si salva in PDF dal pulsante *Stampa / PDF*; *Esporta CSV* scarica tutte le letture del periodo (apribile con Excel).
  Toccando un giorno in *Giorno per giorno* si apre il suo grafico ingrandito: passando col mouse (o col dito) si legge ogni valore, con le frecce si va al giorno prima o dopo.
- **Profilo** (icona con l'iniziale in alto a destra): unità e target, cambio password, **verifica in due passaggi** attivabile dal sito inquadrando un QR code con un'app di autenticazione, browser collegati (con la possibilità di scollegarli), i propri telefoni, attività recente.
- **Amministrazione** (solo amministratori): panoramica (utenti, 2FA, telefoni, ultima lettura, letture salvate), gestione utenti (ruolo, permesso di caricare, sblocco, reimpostazione password, azzeramento della 2FA per chi ha perso il telefono, eliminazione), tutti i telefoni, registro attività di tutti gli utenti con filtro sugli eventi di sicurezza.
- **Aggiornamento in tempo reale**: la pagina riceve le letture appena il telefono le carica (Server-Sent Events), senza ricaricare.
- **Glucometro**: le misurazioni capillari che l'app riceve da un glucometro Bluetooth compaiono sul grafico come rombi con il valore, in tempo reale, e arrivano anche ai telefoni che ricevono.
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

**In tempo reale.** Il telefono tiene aperta una connessione (`GET /api/v1/readings/stream`, Server-Sent Events) e il server gli spinge ogni lettura circa un secondo dopo che il telefono con il sensore l'ha caricata, come la sincronizzazione di xDrip.

Al collegamento il server invia prima le letture che il telefono ha perso. Poi la linea resta silenziosa fino alla lettura successiva, salvo un segnale ogni 4 minuti e mezzo di inattività: quanto basta perché router e reti mobili non la chiudano. La radio si sveglia quindi circa una volta per lettura, come con le richieste periodiche, ma senza ritardo.

Se la connessione cade, il telefono si ricollega dopo 5 s, 10 s, 20 s… fino a 5 minuti. Una sveglia ogni 10 minuti, attiva anche in Doze, verifica che la linea sia viva.

Con un server vecchio senza `/stream`, il telefono torna da solo alle richieste periodiche (`GET /api/v1/readings?since=…`) subito dopo l'ora attesa della lettura successiva.

## Caricamento dall'app: batteria e dati

- **Nessun timer proprio**: l'app invia subito dopo aver ricevuto una lettura dal G7, quando il telefono è già sveglio per il Bluetooth. Così la radio si accende una volta sola.
- **Un'unica richiesta** con tutte le letture in attesa, comprese quelle recuperate dal backfill. Il formato è `[secondi dal precedente, mg/dL, tendenza×10, origine]`, circa **15 byte per lettura**: una giornata intera pesa circa 4 KB, poco più di 1 KB con gzip.
- **Frequenza regolabile** (5, 15, 30 o 60 minuti) e opzione **solo Wi-Fi**.
- **Pausa crescente in caso di errore**: se manca la rete o il server non risponde, i tentativi si diradano fino a uno all'ora. Le letture restano sul telefono e partono tutte insieme appena possibile.
- **Nessun doppione**: il server considera già presente una lettura se ne ha un'altra entro ±2 minuti. Il G7 legge ogni 5 minuti, quindi due letture vere non sono mai così vicine. Così il telefono può reinviare senza problemi:
  - dopo un reset o un nuovo collegamento, ricarica tutto ciò che ha in locale;
  - dopo un errore di rete;
  - se due telefoni caricano lo stesso sensore.

  Lo stesso controllo copre la stessa lettura arrivata prima in diretta e poi dal backfill del sensore, con un'ora diversa di qualche secondo perché calcolata al momento della ricezione.

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

1. Configura e avvia. L'immagine è già pronta su GitHub Container Registry, per x86 e ARM, quindi non serve compilare nulla:
   ```bash
   git clone https://github.com/federico-castellani/g7monitor-server.git && cd g7monitor-server
   cp .env.example .env          # G7_DOMAIN = il dominio pubblico del proxy
   docker compose up -d
   docker compose exec g7server node src/cli.ts add federico   # primo amministratore
   ```
   Per compilare l'immagine da questi sorgenti invece di scaricarla: `docker compose up -d --build`.
2. Nel reverse proxy inoltra `https://glicemie.example.com` a `http://127.0.0.1:8080`:
   - passa gli header `Host`, `X-Forwarded-For` e `X-Forwarded-Proto`;
   - accetta corpi fino a 1 MB;
   - per `/api/readings/stream` (aggiornamento live del sito) e `/api/v1/readings/stream` (telefoni che ricevono) disattiva il buffering e usa un timeout di lettura di almeno 5 minuti. Il valore predefinito di nginx, 60 s, chiuderebbe la connessione dei telefoni tra un segnale e l'altro.

   Esempio con nginx:
   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       client_max_body_size 1m;
   }
   location ~ /readings/stream$ {
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

### Aggiornamento

A ogni push su `main`, GitHub Actions esegue i test e, solo se passano, pubblica la nuova immagine `ghcr.io/federico-castellani/g7monitor-server:latest`. Sul server basta:

```bash
./update.sh
```

Lo script:
- fa un backup del database nel volume (`/data/backup-pre-update-*.db`, conservato 30 giorni);
- scarica l'immagine nuova e riavvia il container;
- cancella le immagini vecchie;
- mostra la versione in esecuzione.

Le letture e gli utenti restano nel volume `g7data`, e le modifiche allo schema del database si applicano da sole all'avvio. Se non c'è nulla di nuovo, lo script non cambia niente: si può mettere anche in cron, per esempio ogni notte alle 4:

```
0 4 * * * /percorso/g7monitor-server/update.sh >> /var/log/g7monitor-update.log 2>&1
```

La versione in esecuzione si vede anche su `https://glicemie.example.com/healthz`.

Per fissare una versione invece di seguire `latest`, crea un tag `v1.2.3` su GitHub. La CI pubblica anche `:1.2.3` e `:1.2`, che puoi indicare in `image:` nel `docker-compose.yml`.

**Prima pubblicazione:** su GitHub i pacchetti nascono privati. Rendi pubblica l'immagine (*Packages → g7monitor-server → Package settings → Change visibility → Public*), oppure sul server esegui una volta `docker login ghcr.io` con un token che abbia il permesso `read:packages`.

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
| `G7_TRUST_PROXY` | — | `true` dietro un reverse proxy sulla stessa macchina o in rete locale (si fida solo degli indirizzi locali e privati), oppure l'elenco degli indirizzi dei proxy |
| `G7_CLIENT_IP_HEADER` | — | header con l'indirizzo reale del visitatore messo dalla CDN (`CF-Connecting-IP` con Cloudflare); letto solo sulle richieste arrivate dal proxy |
| `G7_PEPPER` | — | segreto di almeno 32 caratteri per le password; se lo perdi, le password vanno reimpostate |
| `G7_COOKIE_SECURE` | `true` | `false` solo per prove in rete locale senza HTTPS |

## API

| Metodo | Percorso | Autenticazione | |
|---|---|---|---|
| GET | `/api/v1/info` | nessuna | permette all'app di riconoscere un server G7 Monitor prima di chiedere le credenziali |
| POST | `/api/v1/devices` | nome utente e password (+ TOTP) | collega un telefono e restituisce il token: `kind: "uploader"` per caricare (serve il permesso di caricare), `"reader"` per ricevere |
| GET | `/api/v1/readings/stream?since=&fsince=` | `Bearer` (anche in sola lettura) | letture in tempo reale per i telefoni che ricevono (SSE): prima quelle successive a `since`, poi ogni nuova; con `fsince` anche le misurazioni del glucometro, come evento `fingerstick` |
| GET | `/api/v1/readings?since=&fsince=` | `Bearer` (anche in sola lettura) | letture successive a `since` (richiesta singola); con `fsince` anche le misurazioni del glucometro (`f`) |
| POST | `/api/v1/readings` | `Bearer` token di caricamento | carica letture (`Content-Encoding: gzip` facoltativo) |
| POST | `/api/v1/fingersticks` | `Bearer` token di caricamento | carica misurazioni del glucometro `[[secondi, mg/dL, nome glucometro], …]`; la stessa misurazione arrivata due volte (stesso valore entro 60 s) viene salvata una volta sola |
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
