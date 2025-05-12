# Green Charge Bot

Bot Telegram per gestire la coda e i turni delle colonnine di ricarica di Antonio Green-Charge.

## Funzionalità

- Gestione degli slot di ricarica (max 5 contemporanei)
- Sistema di coda automatico
- Timer per ricariche (max 30 minuti)
- Notifiche automatiche
- Comandi amministrativi

## Comandi Disponibili

- `/prenota` - Prenota uno slot o mettiti in coda
- `/iniziato` - Conferma l'inizio della ricarica
- `/terminato` - Conferma la fine della ricarica
- `/status` - Visualizza lo stato attuale del sistema
- `/help` - Mostra i comandi disponibili
- `/admin_*` - Comandi amministrativi (solo per admin)

## Configurazione

Il bot utilizza le seguenti variabili d'ambiente:

- `BOT_TOKEN` - Token del bot Telegram
- `MONGODB_URI` - URI di connessione MongoDB
- `ADMIN_USER_ID` - ID utente Telegram dell'amministratore
- `MAX_SLOTS` - Numero massimo di slot (default: 5)
- `MAX_CHARGE_TIME` - Tempo massimo di ricarica in minuti (default: 30)
- `REMINDER_TIME` - Minuti prima della scadenza per il promemoria (default: 5)

## Sviluppo
