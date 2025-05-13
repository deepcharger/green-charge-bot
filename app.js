// Aggiungere questa riga all'inizio di app.js per disabilitare i warning di Bluebird
process.env.BLUEBIRD_WARNINGS = '0';

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const messageHandler = require('./handlers/messageHandler');
const notifier = require('./utils/notifier');
const logger = require('./utils/logger');
const Lock = require('./models/lock');
const StartupNotification = require('./models/startupNotification');
const LocalLockManager = require('./utils/localLockManager');
const InstanceTracker = require('./utils/instanceTracker');

// Genera un ID univoco per questa istanza del bot
const INSTANCE_ID = `instance_${Date.now()}_${uuidv4().split('-')[0]}`;
const localLockManager = new LocalLockManager(INSTANCE_ID);
const instanceTracker = new InstanceTracker(INSTANCE_ID);

// Variabili per gestire il backoff e i tentativi di connessione
let pollingRetryCount = 0;
const MAX_RETRY_COUNT = 5;
const MIN_INITIAL_DELAY = 20000; // 20 secondi
const MAX_INITIAL_DELAY = 40000; // 40 secondi

let bot = null;
let masterLockHeartbeatInterval = null;
let executionLockHeartbeatInterval = null;
let lockCheckInterval = null;
let isShuttingDown = false; // Flag per indicare che è in corso lo shutdown
let notificationSystem = null; // Riferimento al sistema di notifiche

// Timeout per la terminazione (ms)
const SHUTDOWN_TIMEOUT = 5000;

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

// Opzioni per la connessione MongoDB per maggiore resilienza
const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4, // Usa IPv4, evita problemi con IPv6
  // Questi parametri migliorano la stabilità della connessione
  connectTimeoutMS: 10000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  maxPoolSize: 10, // Numero massimo di connessioni simultanee
  minPoolSize: 2  // Mantieni almeno due connessioni aperte
};

// Gestire gli eventi di MongoDB per monitorare la connessione
mongoose.connection.on('connecting', () => {
  logger.info('MongoDB: tentativo di connessione in corso...');
});

mongoose.connection.on('connected', () => {
  logger.info('MongoDB: connesso con successo');
});

mongoose.connection.on('disconnected', () => {
  if (!isShuttingDown) {
    logger.warn('MongoDB: disconnesso');
    logger.info('MongoDB: tentativo di riconnessione...');
  }
});

mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB: riconnesso con successo');
});

mongoose.connection.on('error', (err) => {
  logger.error(`MongoDB: errore di connessione: ${err.message}`);
  if (err.name === 'MongoNetworkError' && !isShuttingDown) {
    logger.info('MongoDB: tentativo di riconnessione automatica...');
  }
});

// Inizializzazione connessione MongoDB
logger.info('Tentativo di connessione a MongoDB...');
mongoose.connect(config.MONGODB_URI, mongooseOptions)
  .then(() => {
    logger.info('✅ Connessione a MongoDB riuscita');
    initializeBot();
  })
  .catch(err => {
    logger.error('❌ Errore di connessione a MongoDB:', err);
    logger.error(`URI MongoDB: ${config.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//****:****@')}`);
    process.exit(1);
  });

/**
 * Verifica se è possibile connettersi a Telegram senza conflitti
 * @returns {Promise<boolean>} - true se la connessione è riuscita
 */
async function testTelegramConnection() {
  try {
    const testBot = new TelegramBot(config.BOT_TOKEN, { polling: false });
    await testBot.getMe();
    return true;
  } catch (error) {
    if (error.code === 'ETELEGRAM' && error.message && error.message.includes('409 Conflict')) {
      logger.warn('Conflitto Telegram rilevato durante il test di connessione');
      return false;
    }
    logger.error('Errore durante il test di connessione a Telegram:', error);
    return false;
  }
}

/**
 * Avvia la sequenza di inizializzazione del bot
 */
async function initializeBot() {
  try {
    // Pulisci eventuali lock orfani appartenenti a questa istanza (improbabile ma per sicurezza)
    await Lock.deleteMany({ instance_id: INSTANCE_ID });
    
    // Attendi un periodo casuale prima di tentare di acquisire il master lock
    // Aumenta il ritardo per ridurre i conflitti durante i deploy
    const delayMs = MIN_INITIAL_DELAY + Math.floor(Math.random() * (MAX_INITIAL_DELAY - MIN_INITIAL_DELAY));
    logger.info(`Attesa di ${delayMs}ms prima di tentare di acquisire il master lock...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    // Tenta di acquisire il master lock
    await acquireMasterLock();
  } catch (error) {
    logger.error('❌ Errore critico durante l\'inizializzazione:', error);
    await performShutdown('INIT_ERROR');
  }
}

/**
 * Tenta di acquisire il master lock
 * Il master lock è un lock esclusivo che determina quale istanza ha il diritto di provare ad acquisire il lock di esecuzione
 * Solo una istanza alla volta può avere il master lock
 */
async function acquireMasterLock() {
  if (isShuttingDown) return; // Non tentare di acquisire il lock se lo shutdown è in corso
  
  try {
    logger.info(`Tentativo di acquisire il master lock per l'istanza ${INSTANCE_ID}...`);
    
    // Prima verifica se possiamo connetterci a Telegram senza conflitti
    const canConnectToTelegram = await testTelegramConnection();
    if (!canConnectToTelegram) {
      logger.warn('Test di connessione a Telegram fallito, attesa prima di riprovare...');
      setTimeout(() => {
        if (!isShuttingDown) acquireMasterLock();
      }, 15000 + Math.random() * 10000); // Attesa più lunga in caso di conflitto rilevato
      return;
    }
    
    // Verifica se c'è già un'istanza attiva con un lock di esecuzione
    const activeLock = await Lock.findOne({ 
      lock_type: 'execution',
      last_heartbeat: { $gt: new Date(Date.now() - 30000) } // Consideriamo attivi i lock con heartbeat negli ultimi 30 secondi
    });
    
    if (activeLock) {
      // Ignora il lock se appartiene a questa istanza (potrebbe succedere in casi rari)
      if (activeLock.instance_id === INSTANCE_ID) {
        logger.info(`Il lock di esecuzione appartiene già a questa istanza, continuando...`);
      } else {
        // Se c'è già un'istanza attiva, termina questa istanza
        logger.info(`Rilevato un lock di esecuzione attivo: ${activeLock.instance_id}`);
        logger.info(`L'istanza ${activeLock.instance_id} è attiva e ha il lock di esecuzione. Termino questa istanza.`);
        await performShutdown('DUPLICATE_INSTANCE');
        return;
      }
    }
    
    // Verifica se esiste già un master lock valido
    const masterLock = await Lock.findOne({ 
      name: 'master_lock',
      lock_type: 'master',
      last_heartbeat: { $gt: new Date(Date.now() - 30000) } // Solo lock attivi negli ultimi 30 secondi
    });
    
    if (masterLock) {
      // Se c'è già un master lock attivo e non è di questa istanza, attendere e riprovare
      if (masterLock.instance_id !== INSTANCE_ID) {
        logger.info(`Master lock già acquisito da un'altra istanza (${masterLock.instance_id}), attesa di 10 secondi...`);
        setTimeout(acquireMasterLock, 10000);
        return;
      } else {
        // Se il master lock è già di questa istanza, lo aggiorniamo
        logger.info(`Master lock già nostro, aggiornamento heartbeat`);
        masterLock.last_heartbeat = new Date();
        await masterLock.save();
        
        // Procediamo con l'acquisizione del lock di esecuzione
        await acquireExecutionLock();
        return;
      }
    }
    
    // Se ci sono lock scaduti, li eliminiamo
    await Lock.deleteMany({
      name: 'master_lock',
      lock_type: 'master',
      last_heartbeat: { $lt: new Date(Date.now() - 30000) }
    });
    
    // Creazione del master lock
    const lock = new Lock({
      name: 'master_lock',
      lock_type: 'master',
      instance_id: INSTANCE_ID,
      created_at: new Date(),
      last_heartbeat: new Date()
    });
    
    await lock.save();
    logger.info(`Master lock acquisito con successo da ${INSTANCE_ID}`);
    
    // Avvia il heartbeat per il master lock
    startMasterLockHeartbeat();
    
    // Procedi con l'acquisizione del lock di esecuzione
    await acquireExecutionLock();
  } catch (error) {
    logger.error(`Errore durante l'acquisizione del master lock:`, error);
    // In caso di errore, riprova dopo 10 secondi
    if (!isShuttingDown) {
      setTimeout(acquireMasterLock, 10000);
    }
  }
}

/**
 * Tenta di acquisire il lock di esecuzione
 * Il lock di esecuzione determina quale istanza può effettivamente eseguire il bot
 */
async function acquireExecutionLock() {
  if (isShuttingDown) return; // Non tentare di acquisire il lock se lo shutdown è in corso
  
  try {
    logger.info(`Tentativo di acquisire il lock di esecuzione per l'istanza ${INSTANCE_ID}...`);
    
    // Prima verifica se possiamo connetterci a Telegram senza conflitti
    const canConnectToTelegram = await testTelegramConnection();
    if (!canConnectToTelegram) {
      logger.warn('Test di connessione a Telegram fallito prima di acquisire execution lock, attesa prima di riprovare...');
      setTimeout(() => {
        if (!isShuttingDown) acquireExecutionLock();
      }, 10000 + Math.random() * 5000);
      return;
    }
    
    // Verifica se esiste già un lock di esecuzione valido
    const executionLock = await Lock.findOne({ 
      name: 'execution_lock',
      lock_type: 'execution',
      last_heartbeat: { $gt: new Date(Date.now() - 30000) } // Solo lock attivi negli ultimi 30 secondi
    });
    
    if (executionLock) {
      // Se c'è già un lock di esecuzione attivo e non è di questa istanza, attendere e riprovare
      if (executionLock.instance_id !== INSTANCE_ID) {
        logger.info(`Lock di esecuzione già acquisito da un'altra istanza (${executionLock.instance_id}), attesa di 10 secondi...`);
        setTimeout(() => {
          if (!isShuttingDown) acquireExecutionLock();
        }, 10000);
        return;
      } else {
        // Se il lock di esecuzione è già di questa istanza, lo aggiorniamo
        logger.info(`Lock di esecuzione già nostro, aggiornamento heartbeat`);
        executionLock.last_heartbeat = new Date();
        await executionLock.save();
        
        // Procediamo con l'avvio del bot se non è già avviato
        if (!bot) {
          startBot();
        }
        return;
      }
    }
    
    // Se ci sono lock scaduti, li eliminiamo
    await Lock.deleteMany({
      name: 'execution_lock',
      lock_type: 'execution',
      last_heartbeat: { $lt: new Date(Date.now() - 30000) }
    });
    
    // Creazione del lock di esecuzione
    const lock = new Lock({
      name: 'execution_lock',
      lock_type: 'execution',
      instance_id: INSTANCE_ID,
      created_at: new Date(),
      last_heartbeat: new Date()
    });
    
    await lock.save();
    logger.info(`Lock di esecuzione acquisito con successo da ${INSTANCE_ID}`);
    
    // Crea anche un lock file locale
    if (localLockManager.createLockFile()) {
      logger.debug(`Lock file locale creato`);
    } else {
      logger.warn(`Impossibile creare lock file locale`);
    }
    
    // Avvia il heartbeat per il lock di esecuzione
    startExecutionLockHeartbeat();
    
    // Avvia il controllo periodico del lock
    startLockCheck();
    
    // Procedi con l'avvio del bot
    startBot();
  } catch (error) {
    logger.error(`Errore durante l'acquisizione del lock di esecuzione:`, error);
    // In caso di errore, riprova dopo 10 secondi
    if (!isShuttingDown) {
      setTimeout(acquireExecutionLock, 10000);
    }
  }
}

/**
 * Avvia un interval per aggiornare periodicamente il master lock
 */
function startMasterLockHeartbeat() {
  if (masterLockHeartbeatInterval) {
    clearInterval(masterLockHeartbeatInterval);
  }
  
  masterLockHeartbeatInterval = setInterval(async () => {
    if (isShuttingDown) return; // Non aggiornare il lock durante lo shutdown
    
    try {
      const lock = await Lock.findOne({ 
        name: 'master_lock', 
        lock_type: 'master',
        instance_id: INSTANCE_ID 
      });
      
      if (lock) {
        lock.last_heartbeat = new Date();
        await lock.save();
        logger.debug(`Heartbeat per master lock inviato (${INSTANCE_ID})`);
      } else {
        logger.warn(`Master lock non trovato durante heartbeat, tentativo di riacquisizione...`);
        clearInterval(masterLockHeartbeatInterval);
        masterLockHeartbeatInterval = null;
        
        // Tenta di riacquisire il master lock
        if (!isShuttingDown) {
          setTimeout(acquireMasterLock, 5000);
        }
      }
    } catch (error) {
      logger.error(`Errore durante l'aggiornamento del master lock:`, error);
    }
  }, 15000); // Aggiorna ogni 15 secondi
}

/**
 * Avvia un interval per aggiornare periodicamente il lock di esecuzione
 */
function startExecutionLockHeartbeat() {
  if (executionLockHeartbeatInterval) {
    clearInterval(executionLockHeartbeatInterval);
  }
  
  executionLockHeartbeatInterval = setInterval(async () => {
    if (isShuttingDown) return; // Non aggiornare il lock durante lo shutdown
    
    try {
      const lock = await Lock.findOne({ 
        name: 'execution_lock', 
        lock_type: 'execution',
        instance_id: INSTANCE_ID 
      });
      
      if (lock) {
        lock.last_heartbeat = new Date();
        await lock.save();
        logger.debug(`Heartbeat per lock di esecuzione inviato (${INSTANCE_ID})`);
      } else {
        logger.warn(`Lock di esecuzione non trovato durante heartbeat, tentativo di riacquisizione...`);
        clearInterval(executionLockHeartbeatInterval);
        executionLockHeartbeatInterval = null;
        
        // Se il bot è in esecuzione, fermalo
        if (bot) {
          try {
            bot.stopPolling();
            bot = null;
            logger.info(`Bot fermato per perdita del lock di esecuzione`);
          } catch (err) {
            logger.error(`Errore durante l'arresto del bot:`, err);
          }
        }
        
        // Tenta di riacquisire il lock di esecuzione
        if (!isShuttingDown) {
          setTimeout(acquireExecutionLock, 5000);
        }
      }
    } catch (error) {
      logger.error(`Errore durante l'aggiornamento del lock di esecuzione:`, error);
    }
  }, 10000); // Aggiorna ogni 10 secondi
}

/**
 * Avvia un interval per controllare periodicamente lo stato dei lock
 */
function startLockCheck() {
  if (lockCheckInterval) {
    clearInterval(lockCheckInterval);
  }
  
  lockCheckInterval = setInterval(async () => {
    if (isShuttingDown) return; // Non controllare i lock durante lo shutdown
    
    try {
      // Verifica che il lock file locale sia ancora valido
      if (!localLockManager.checkLockFile()) {
        logger.warn(`Lock file locale non valido o mancante, tentativo di riacquisizione...`);
        
        // Tenta di ricreare il lock file locale
        if (localLockManager.createLockFile()) {
          logger.info(`Lock file locale ricreato con successo`);
        } else {
          logger.error(`Impossibile ricreare lock file locale`);
        }
      }
      
      // Verifica che entrambi i lock siano ancora validi
      const masterLock = await Lock.findOne({ 
        name: 'master_lock', 
        lock_type: 'master',
        instance_id: INSTANCE_ID 
      });
      
      const executionLock = await Lock.findOne({ 
        name: 'execution_lock', 
        lock_type: 'execution',
        instance_id: INSTANCE_ID 
      });
      
      if (!masterLock && !isShuttingDown) {
        logger.warn(`Master lock perso, tentativo di riacquisizione...`);
        
        // Non terminiamo subito, ma proviamo a riacquisire il lock
        setTimeout(acquireMasterLock, 5000);
      }
      
      if (!executionLock && !isShuttingDown) {
        logger.warn(`Lock di esecuzione perso, tentativo di riacquisizione...`);
        
        // Non terminiamo subito, ma proviamo a riacquisire il lock
        setTimeout(acquireExecutionLock, 5000);
      }
    } catch (error) {
      logger.error(`Errore durante il controllo dei lock:`, error);
    }
  }, 60000); // Controlla ogni 60 secondi
}

/**
 * Rilascia tutti i lock per questa istanza
 */
async function releaseAllLocks() {
  try {
    logger.info(`Rilascio di tutti i lock per l'istanza ${INSTANCE_ID}...`);
    
    // Rilascia il lock di esecuzione
    const executionLockResult = await Lock.deleteOne({ 
      name: 'execution_lock', 
      lock_type: 'execution',
      instance_id: INSTANCE_ID 
    });
    
    if (executionLockResult.deletedCount > 0) {
      logger.info(`Lock di esecuzione rilasciato da ${INSTANCE_ID}`);
    } else {
      logger.info(`Nessun lock di esecuzione da rilasciare per ${INSTANCE_ID}`);
    }
    
    // Rilascia il master lock
    const masterLockResult = await Lock.deleteOne({ 
      name: 'master_lock', 
      lock_type: 'master',
      instance_id: INSTANCE_ID 
    });
    
    if (masterLockResult.deletedCount > 0) {
      logger.info(`Master lock rilasciato da ${INSTANCE_ID}`);
    } else {
      logger.info(`Nessun master lock da rilasciare per ${INSTANCE_ID}`);
    }
    
    // Rimuovi il lock file locale
    localLockManager.removeLockFile();
    
    return true;
  } catch (error) {
    logger.error(`Errore durante il rilascio dei lock:`, error);
    return false;
  }
}

/**
 * Avvia il bot Telegram
 */
function startBot() {
  if (isShuttingDown) return; // Non avviare il bot durante lo shutdown
  if (bot) return; // Non avviare il bot se è già in esecuzione
  
  try {
    logger.info('Avvio del bot...');
    
    // Inizializzazione bot Telegram
    bot = new TelegramBot(config.BOT_TOKEN, { 
      polling: true,
      polling_error_timeout: 10000,
      onlyFirstMatch: false,
      request: {
        timeout: 30000,
        agentOptions: {
          keepAlive: true
        }
      } 
    });
    
    // Logging di eventi di polling
    bot.on('polling_error', (error) => {
      logger.error('❌ Errore di polling Telegram:', error);
      
      // Se l'errore è un conflitto (409), implementa un backoff esponenziale
      if (error.code === 'ETELEGRAM' && error.message && error.message.includes('409 Conflict')) {
        logger.warn('Rilevato conflitto con altra istanza Telegram, gestione...');
        pollingRetryCount++;
        
        // Se abbiamo troppi tentativi falliti, meglio terminare
        if (pollingRetryCount > MAX_RETRY_COUNT) {
          logger.warn(`Troppi tentativi falliti (${pollingRetryCount}), terminazione...`);
          
          // Immediato arresto del polling per evitare ulteriori errori
          try {
            bot.stopPolling();
          } catch (err) {
            logger.error('Errore nell\'arresto del polling:', err);
          }
          
          // Termina l'istanza
          performShutdown('TELEGRAM_CONFLICT');
          return;
        }
        
        // Calcola il tempo di backoff esponenziale (tra 2 e 30 secondi)
        const backoffTime = Math.min(1000 * Math.pow(2, pollingRetryCount) + Math.random() * 1000, 30000);
        logger.info(`Attesa di ${Math.round(backoffTime/1000)} secondi prima di riprovare (tentativo ${pollingRetryCount})...`);
        
        // Ferma il polling attuale
        try {
          bot.stopPolling();
          bot = null;
        } catch (err) {
          logger.error('Errore nell\'arresto del polling:', err);
        }
        
        // Riprova dopo il backoff
        setTimeout(() => {
          if (!isShuttingDown) {
            logger.info(`Tentativo di riconnessione #${pollingRetryCount}...`);
            startBot(); // Riavvia il bot
          }
        }, backoffTime);
        
        return;
      }
    });
    
    // Test della connessione a Telegram
    logger.info('Verifica connessione a Telegram...');
    bot.getMe().then(async info => {
      logger.info(`✅ Bot connesso correttamente come @${info.username} (ID: ${info.id})`);
      
      // Controlla se è stata inviata una notifica di avvio nelle ultime 2 ore
      try {
        const recentlyNotified = await checkLastStartupNotification();
        
        // Se non c'è stata una notifica recente e l'admin è configurato, invia il messaggio
        if (!recentlyNotified && config.ADMIN_USER_ID) {
          logger.info(`Tentativo di invio messaggio di avvio all'admin ${config.ADMIN_USER_ID}...`);
          try {
            await bot.sendMessage(config.ADMIN_USER_ID, 
              `🤖 *Green-Charge Bot avviato*\n\n` +
              `Il bot è ora online e pronto all'uso.\n\n` +
              `Versione: 1.0.0\n` +
              `Avviato: ${new Date().toLocaleString('it-IT')}\n` +
              `ID Istanza: ${INSTANCE_ID}`,
              { parse_mode: 'Markdown' });
            
            logger.info('✅ Messaggio di avvio inviato all\'admin');
            
            // Salva il timestamp della notifica
            await saveStartupNotification('startup', 'Bot avviato con successo');
          } catch (err) {
            logger.warn('⚠️ Impossibile inviare messaggio all\'admin:', err.message);
          }
        } else {
          logger.info('Notifica di avvio recente, messaggio non inviato');
        }
      } catch (err) {
        logger.warn('Errore nel controllo notifiche di avvio:', err);
      }
      
      // Inizializza i comandi del bot
      try {
        await messageHandler.init(bot);
      } catch (err) {
        logger.error('Errore nell\'inizializzazione dell\'handler messaggi:', err);
      }
    }).catch(err => {
      logger.error('❌ Errore nella connessione a Telegram:', err);
      logger.error(`Token bot: ${config.BOT_TOKEN.substring(0, 5)}...${config.BOT_TOKEN.substring(config.BOT_TOKEN.length - 5)}`);
      
      // Se non riusciamo a connetterci a Telegram, ritentiamo più tardi
      if (!isShuttingDown) {
        logger.info('Nuovo tentativo di avvio tra 30 secondi...');
        setTimeout(startBot, 30000);
      }
    });

    // Avvio sistema di notifiche periodiche
    logger.info('Avvio sistema di notifiche...');
    try {
      // Ferma eventuali sistemi di notifiche precedenti
      if (notificationSystem && notificationSystem.stop) {
        notificationSystem.stop();
      }
      
      notificationSystem = notifier.startNotificationSystem(bot);
      if (notificationSystem) {
        logger.info('✅ Sistema di notifiche avviato correttamente');
      } else {
        logger.error('❌ Errore nell\'avvio del sistema di notifiche');
      }
    } catch (err) {
      logger.error('Errore nell\'avvio del sistema di notifiche:', err);
    }

    logger.info('✅ Bot avviato con successo');
    logger.logMemoryUsage(); // Log dell'utilizzo memoria
  } catch (error) {
    logger.error('❌ Errore critico durante l\'avvio del bot:', error);
    logger.error('Stack trace:', error.stack);
    
    // Se il bot è stato creato, proviamo a fermarlo
    if (bot) {
      try {
        bot.stopPolling();
        bot = null;
      } catch (err) {
        logger.error('Errore nell\'arresto del polling:', err);
      }
    }
    
    // Ritentiamo l'avvio dopo un po'
    if (!isShuttingDown) {
      logger.info('Nuovo tentativo di avvio tra 30 secondi...');
      setTimeout(startBot, 30000);
    }
  }
}

/**
 * Controlla se è stata inviata una notifica di avvio recentemente
 * @returns {Promise<boolean>} - true se è stata inviata una notifica nelle ultime 2 ore
 */
async function checkLastStartupNotification() {
  try {
    // Cerca notifiche nelle ultime 2 ore
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recentNotification = await StartupNotification.findOne({
      timestamp: { $gt: twoHoursAgo },
      notification_type: 'startup'
    });
    
    return !!recentNotification;
  } catch (error) {
    logger.error('Errore nel controllo delle notifiche di avvio:', error);
    // In caso di errore, assumiamo che non ci siano notifiche recenti
    return false;
  }
}

/**
 * Salva un record per la notifica di avvio
 * @param {string} type - Tipo di notifica ('startup', 'shutdown', 'error')
 * @param {string} message - Messaggio associato alla notifica
 */
async function saveStartupNotification(type = 'startup', message = '') {
  try {
    // Crea un nuovo record di notifica
    const notification = new StartupNotification({
      instance_id: INSTANCE_ID,
      notification_type: type,
      message: message
    });
    
    await notification.save();
    logger.info(`Notifica di ${type} salvata`);
  } catch (error) {
    logger.error(`Errore nel salvataggio della notifica di ${type}:`, error);
  }
}

/**
 * Esegue un processo di shutdown controllato
 * @param {string} reason - Motivo dello shutdown
 */
async function performShutdown(reason = 'NORMAL') {
  // Evita shutdown multipli
  if (isShuttingDown) {
    logger.info(`Shutdown già in corso (${instanceTracker.terminationReason}), ignorando la richiesta di terminazione per ${reason}`);
    return;
  }
  
  // Imposta il flag di shutdown
  isShuttingDown = true;
  
  // Imposta lo stato di terminazione nel tracker
  instanceTracker.startTermination(reason);
  logger.info(`Bot in fase di terminazione (${reason})`);
  
  try {
    // Ferma il sistema di notifiche
    if (notificationSystem && notificationSystem.stop) {
      notificationSystem.stop();
      notificationSystem = null;
    }
    
    // Ferma tutti gli intervalli
    if (masterLockHeartbeatInterval) {
      clearInterval(masterLockHeartbeatInterval);
      masterLockHeartbeatInterval = null;
    }
    
    if (executionLockHeartbeatInterval) {
      clearInterval(executionLockHeartbeatInterval);
      executionLockHeartbeatInterval = null;
    }
    
    if (lockCheckInterval) {
      clearInterval(lockCheckInterval);
      lockCheckInterval = null;
    }
    
    // Ferma il polling del bot PRIMA di rilasciare i lock
    // Questo è importante per evitare conflitti
    if (bot) {
      logger.info('Arresto polling Telegram...');
      try {
        await bot.stopPolling();
        bot = null;
      } catch (error) {
        logger.error('Errore durante l\'arresto del polling:', error);
      }
    }
    
    // Ora rilascia i lock
    await releaseAllLocks();
    
    // Resetta il contatore dei retry
    pollingRetryCount = 0;
    
    // Registra informazioni sull'istanza
    logger.info(`L'istanza ha tentato ${instanceTracker.restartCount} riavvii durante il ciclo di vita`);
    
    // Salva notifica di shutdown
    try {
      await saveStartupNotification('shutdown', `Terminazione: ${reason}`);
    } catch (err) {
      logger.error('Errore nel salvataggio della notifica di shutdown:', err);
    }
    
    // Chiudi la connessione a MongoDB
    try {
      logger.info('Connessione al database chiusa');
      await mongoose.connection.close();
    } catch (err) {
      logger.error('Errore nella chiusura della connessione MongoDB:', err);
    }
    
    // Aggiungi un ritardo prima della terminazione per far completare tutte le operazioni pendenti
    logger.info(`Uscita con codice 0 dopo ${SHUTDOWN_TIMEOUT}ms`);
    setTimeout(() => {
      process.exit(0);
    }, SHUTDOWN_TIMEOUT);
  } catch (error) {
    logger.error('Errore durante lo shutdown:', error);
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
}

// Gestione dei segnali del sistema operativo
process.on('SIGINT', () => {
  logger.info('Segnale SIGINT ricevuto, spegnimento bot in corso...');
  performShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  logger.info('Segnale SIGTERM ricevuto, spegnimento bot in corso...');
  performShutdown('SIGTERM');
});

// Gestione eccezioni non catturate
process.on('uncaughtException', (err) => {
  logger.error('❌ Eccezione non gestita:', err);
  logger.error('Stack trace:', err.stack);
  logger.logMemoryUsage();
  
  // Se è un'eccezione grave, rilascia i lock e termina
  performShutdown('UNCAUGHT_EXCEPTION');
});

// Gestione promise rejection non gestite
process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Promise rejection non gestita:', reason);
  logger.logMemoryUsage();
  
  // Solo log, non terminiamo l'istanza per una promise non gestita
});
