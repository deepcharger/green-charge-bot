const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid'); // Aggiungi questa dipendenza al package.json
const config = require('./config');
const messageHandler = require('./handlers/messageHandler');
const notifier = require('./utils/notifier');
const logger = require('./utils/logger');
const Lock = require('./models/lock'); // Importa il modello Lock

// Genera un ID univoco per questa istanza del bot
const INSTANCE_ID = uuidv4();
let bot = null;
let lockHeartbeatInterval = null;

// Logging all'avvio
logger.info('====== AVVIO BOT GREEN-CHARGE ======');
logger.info(`Versione Node: ${process.version}`);
logger.info(`Versione mongoose: ${mongoose.version}`);
logger.info(`ID Istanza: ${INSTANCE_ID}`);
logger.info(`Bot token length: ${config.BOT_TOKEN ? config.BOT_TOKEN.length : 'undefined'}`);
logger.info(`MongoDB URI: ${config.MONGODB_URI ? 'Configurato' : 'Non configurato'}`);
logger.info(`Admin user ID: ${config.ADMIN_USER_ID || 'Non configurato'}`);
logger.info(`Environment: ${config.ENVIRONMENT}`);
logger.info(`MAX_SLOTS: ${config.MAX_SLOTS}`);
logger.info(`MAX_CHARGE_TIME: ${config.MAX_CHARGE_TIME}`);
logger.info(`REMINDER_TIME: ${config.REMINDER_TIME}`);

// Inizializzazione connessione MongoDB
logger.info('Tentativo di connessione a MongoDB...');
mongoose.connect(config.MONGODB_URI)
  .then(() => {
    logger.info('✅ Connessione a MongoDB riuscita');
    acquireLock();
  })
  .catch(err => {
    logger.error('❌ Errore di connessione a MongoDB:', err);
    logger.error(`URI MongoDB: ${config.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//****:****@')}`); // Nasconde credenziali nei log
    process.exit(1);
  });

/**
 * Tenta di acquisire un lock per questa istanza del bot
 */
async function acquireLock() {
  try {
    logger.info(`Tentativo di acquisizione lock per istanza ${INSTANCE_ID}...`);
    
    // Controlla se esiste già un lock valido
    const existingLock = await Lock.findOne({ name: 'bot_lock' });
    
    if (existingLock) {
      // Verifica se il lock è scaduto (nessun heartbeat per più di 30 secondi)
      const now = new Date();
      const lockTimeDiff = now - existingLock.last_heartbeat;
      
      if (lockTimeDiff > 30000) { // 30 secondi
        logger.warn(`Lock esistente scaduto (${lockTimeDiff}ms), acquisizione forzata`);
        await Lock.deleteOne({ name: 'bot_lock' });
      } else {
        // Se c'è già un lock attivo e non è questa istanza, attendere e riprovare
        if (existingLock.instance_id !== INSTANCE_ID) {
          logger.info(`Lock già acquisito da un'altra istanza (${existingLock.instance_id}), attesa di 5 secondi...`);
          setTimeout(acquireLock, 5000);
          return;
        } else {
          // Se il lock è già di questa istanza (caso improbabile), lo aggiorniamo
          logger.info(`Lock già nostro, aggiornamento heartbeat`);
          existingLock.last_heartbeat = now;
          await existingLock.save();
          startBot();
          return;
        }
      }
    }
    
    // Creazione del lock
    const lock = new Lock({
      name: 'bot_lock',
      instance_id: INSTANCE_ID,
      created_at: new Date(),
      last_heartbeat: new Date()
    });
    
    await lock.save();
    logger.info(`✅ Lock acquisito con successo per istanza ${INSTANCE_ID}`);
    
    // Avvia heartbeat per mantenere il lock
    startLockHeartbeat();
    
    // Avvia il bot
    startBot();
  } catch (error) {
    logger.error(`Errore durante l'acquisizione del lock:`, error);
    // In caso di errore, riprova dopo 5 secondi
    setTimeout(acquireLock, 5000);
  }
}

/**
 * Avvia un interval per aggiornare periodicamente il lock
 */
function startLockHeartbeat() {
  if (lockHeartbeatInterval) {
    clearInterval(lockHeartbeatInterval);
  }
  
  lockHeartbeatInterval = setInterval(async () => {
    try {
      const lock = await Lock.findOne({ name: 'bot_lock', instance_id: INSTANCE_ID });
      if (lock) {
        lock.last_heartbeat = new Date();
        await lock.save();
        logger.debug(`Heartbeat per lock inviato (${INSTANCE_ID})`);
      } else {
        logger.warn(`Lock non trovato durante heartbeat, tentativo di riacquisizione...`);
        clearInterval(lockHeartbeatInterval);
        lockHeartbeatInterval = null;
        
        // Se il bot è in esecuzione, fermalo
        if (bot) {
          try {
            bot.stopPolling();
            bot = null;
            logger.info(`Bot fermato per perdita del lock`);
          } catch (err) {
            logger.error(`Errore durante l'arresto del bot:`, err);
          }
        }
        
        // Tenta di riacquisire il lock
        acquireLock();
      }
    } catch (error) {
      logger.error(`Errore durante l'aggiornamento del lock:`, error);
    }
  }, 15000); // Aggiorna ogni 15 secondi
}

/**
 * Rilascia il lock (da chiamare durante lo shutdown)
 */
async function releaseLock() {
  try {
    // Interrompe l'heartbeat
    if (lockHeartbeatInterval) {
      clearInterval(lockHeartbeatInterval);
      lockHeartbeatInterval = null;
    }
    
    // Elimina il lock dal database
    await Lock.deleteOne({ name: 'bot_lock', instance_id: INSTANCE_ID });
    logger.info(`Lock rilasciato per istanza ${INSTANCE_ID}`);
    
    return true;
  } catch (error) {
    logger.error(`Errore durante il rilascio del lock:`, error);
    return false;
  }
}

function startBot() {
  try {
    logger.info('Inizializzazione bot Telegram...');
    
    // Inizializzazione bot Telegram
    bot = new TelegramBot(config.BOT_TOKEN, { 
      polling: true,
      // Aggiungi parametri per gestione errori polling
      polling_error_timeout: 10000,
      onlyFirstMatch: false,
      request: {
        timeout: 30000,
        // Aggiungi agent per debug
        agentOptions: {
          keepAlive: true
        }
      } 
    });
    
    // Logging di eventi di polling
    bot.on('polling_error', (error) => {
      logger.error('❌ Errore di polling Telegram:', error);
      
      // Se l'errore è un conflitto (409), rilasciamo il lock e terminiamo l'istanza
      if (error.code === 'ETELEGRAM' && error.message && error.message.includes('409 Conflict')) {
        logger.warn('Rilevato conflitto con altra istanza, rilascio lock e terminazione...');
        
        releaseLock().then(() => {
          logger.info('Terminazione processo in corso dopo conflitto...');
          process.exit(0);
        }).catch(() => {
          logger.error('Terminazione forzata processo dopo conflitto...');
          process.exit(1);
        });
      }
    });
    
    // Test della connessione a Telegram
    logger.info('Verifica connessione a Telegram...');
    bot.getMe().then(info => {
      logger.info(`✅ Bot connesso correttamente come @${info.username} (ID: ${info.id})`);
      
      // Ping di prova per verificare che tutto funzioni
      if (config.ADMIN_USER_ID) {
        logger.info(`Tentativo di invio messaggio di avvio all'admin ${config.ADMIN_USER_ID}...`);
        bot.sendMessage(config.ADMIN_USER_ID, 
          `🤖 *Green-Charge Bot avviato*\n\nIl bot è ora online e pronto all'uso.\n\nVersione: 1.0.0\nAvviato: ${new Date().toLocaleString('it-IT')}\nID Istanza: ${INSTANCE_ID}`,
          { parse_mode: 'Markdown' })
          .then(() => logger.info('✅ Messaggio di avvio inviato all\'admin'))
          .catch(err => logger.warn('⚠️ Impossibile inviare messaggio all\'admin:', err.message));
      }
    }).catch(err => {
      logger.error('❌ Errore nella connessione a Telegram:', err);
      logger.error(`Token bot: ${config.BOT_TOKEN.substring(0, 5)}...${config.BOT_TOKEN.substring(config.BOT_TOKEN.length - 5)}`); // Mostra solo parte del token
    });

    // Gestione messaggi e comandi
    logger.info('Inizializzazione handler messaggi...');
    messageHandler.init(bot);

    // Avvio sistema di notifiche periodiche
    logger.info('Avvio sistema di notifiche...');
    const notifierSystem = notifier.startNotificationSystem(bot);
    if (notifierSystem) {
      logger.info('✅ Sistema di notifiche avviato correttamente');
    } else {
      logger.error('❌ Errore nell\'avvio del sistema di notifiche');
    }

    logger.info('✅ Bot avviato con successo');
    logger.logMemoryUsage(); // Log dell'utilizzo memoria
  } catch (error) {
    logger.error('❌ Errore critico durante l\'avvio del bot:', error);
    logger.error('Stack trace:', error.stack);
    releaseLock().then(() => process.exit(1));
  }
}

// Gestione graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Segnale SIGINT ricevuto, spegnimento bot in corso...');
  await performShutdown();
});

process.on('SIGTERM', async () => {
  logger.info('Segnale SIGTERM ricevuto, spegnimento bot in corso...');
  await performShutdown();
});

// Funzione di shutdown comune
async function performShutdown() {
  try {
    // Rilascia il lock
    logger.info('Rilascio lock...');
    await releaseLock();
    
    // Ferma il polling del bot
    if (bot) {
      logger.info('Arresto polling Telegram...');
      await bot.stopPolling();
    }
    
    // Chiudi la connessione a MongoDB
    logger.info('Chiusura connessione MongoDB...');
    await mongoose.connection.close();
    logger.info('Connessione MongoDB chiusa');
    
    // Termina il processo
    process.exit(0);
  } catch (error) {
    logger.error('Errore durante lo shutdown:', error);
    process.exit(1);
  }
}

// Gestione uncaught exceptions
process.on('uncaughtException', async (err) => {
  logger.error('❌ Eccezione non gestita:', err);
  logger.error('Stack trace:', err.stack);
  logger.logMemoryUsage();
  
  // Se è un'eccezione grave, rilascia il lock e termina
  await releaseLock();
  process.exit(1);
});

// Gestione unhandled rejections
process.on('unhandledRejection', async (reason, promise) => {
  logger.error('❌ Promise rejection non gestita:', reason);
  logger.logMemoryUsage();
  
  // Per le rejection non terminiamo il processo, ma logghiamo solamente
});
