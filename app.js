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
const TaskLock = require('./models/taskLock'); // Nuovo modello per i lock delle operazioni

// Genera un ID univoco per questa istanza del bot
const INSTANCE_ID = `instance_${Date.now()}_${uuidv4().split('-')[0]}`;
const localLockManager = new LocalLockManager(INSTANCE_ID);
const instanceTracker = new InstanceTracker(INSTANCE_ID);

// Variabili per gestire il backoff e i tentativi di connessione
let pollingRetryCount = 0;
const MAX_RETRY_COUNT = 5;
const MIN_INITIAL_DELAY = 20000; // 20 secondi
const MAX_INITIAL_DELAY = 40000; // 40 secondi
const GLOBAL_LOCK_TIMEOUT = 60000; // 60 secondi prima che un lock sia considerato stale
const TASK_LOCK_TIMEOUT = 60000; // 60 secondi per i task lock

let bot = null;
let masterLockHeartbeatInterval = null;
let executionLockHeartbeatInterval = null;
let lockCheckInterval = null;
let isShuttingDown = false; // Flag per indicare che è in corso lo shutdown
let notificationSystem = null; // Riferimento al sistema di notifiche
let isBotStarting = false; // Flag per evitare avvii multipli simultanei
let lastHeartbeatTime = Date.now(); // Timestamp dell'ultimo heartbeat
let lastOperationId = null; // ID dell'ultima operazione eseguita

// Flag per monitorare lo stato della connessione Telegram
let telegramConflictDetected = false;
let lastTelegramConflictTime = null;

// Timeout per la terminazione (ms)
const SHUTDOWN_TIMEOUT = 10000; // Aumentato a 10 secondi per dare più tempo

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

/**
 * Verifica se siamo l'istanza attiva per eseguire operazioni
 * @returns {Promise<boolean>} - true se siamo l'istanza attiva, false altrimenti
 */
async function isActiveInstance() {
  try {
    // Verifica se abbiamo un lock di esecuzione valido
    const executionLock = await Lock.findOne({
      name: 'execution_lock',
      lock_type: 'execution',
      instance_id: INSTANCE_ID,
      last_heartbeat: { $gt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) }
    });
    
    // Se non abbiamo un lock valido, non siamo l'istanza attiva
    if (!executionLock) {
      return false;
    }
    
    // Verifica se ci sono altre istanze con lock di esecuzione più recenti
    const newerLock = await Lock.findOne({
      name: 'execution_lock',
      lock_type: 'execution',
      instance_id: { $ne: INSTANCE_ID },
      last_heartbeat: { $gt: executionLock.last_heartbeat }
    });
    
    // Se c'è un'istanza con un lock più recente, non siamo l'istanza attiva
    if (newerLock) {
      return false;
    }
    
    // Siamo l'istanza attiva
    return true;
  } catch (error) {
    logger.error('Errore nella verifica dell\'istanza attiva:', error);
    // In caso di errore, assumiamo che non siamo l'istanza attiva per sicurezza
    return false;
  }
}

/**
 * Acquisice un lock per un'operazione specifica
 * @param {string} taskName - Nome dell'operazione
 * @param {number} timeoutMs - Timeout in millisecondi per il lock
 * @returns {Promise<{success: boolean, lockId: string|null}>} - Risultato dell'acquisizione
 */
async function acquireTaskLock(taskName, timeoutMs = TASK_LOCK_TIMEOUT) {
  try {
    // Genera un ID univoco per il lock
    const lockId = `${taskName}_${Date.now()}_${uuidv4().split('-')[0]}`;
    
    // Verifica che non ci siano già lock attivi per questa operazione
    const existingLock = await TaskLock.findOne({
      task_name: taskName,
      expires_at: { $gt: new Date() }
    });
    
    if (existingLock) {
      // C'è già un lock attivo
      return { success: false, lockId: null };
    }
    
    // Calcola la scadenza del lock
    const expiresAt = new Date(Date.now() + timeoutMs);
    
    // Crea un nuovo lock
    const taskLock = new TaskLock({
      task_name: taskName,
      lock_id: lockId,
      instance_id: INSTANCE_ID,
      created_at: new Date(),
      expires_at: expiresAt
    });
    
    await taskLock.save();
    
    logger.debug(`Lock acquisito per l'operazione ${taskName} (ID: ${lockId})`);
    return { success: true, lockId };
  } catch (error) {
    logger.error(`Errore nell'acquisizione del lock per l'operazione ${taskName}:`, error);
    return { success: false, lockId: null };
  }
}

/**
 * Rilascia un lock per un'operazione
 * @param {string} taskName - Nome dell'operazione
 * @param {string} lockId - ID del lock da rilasciare
 * @returns {Promise<boolean>} - true se il lock è stato rilasciato, false altrimenti
 */
async function releaseTaskLock(taskName, lockId) {
  try {
    // Rilascia il lock
    const result = await TaskLock.deleteOne({
      task_name: taskName,
      lock_id: lockId
    });
    
    if (result.deletedCount > 0) {
      logger.debug(`Lock rilasciato per l'operazione ${taskName} (ID: ${lockId})`);
      return true;
    }
    
    logger.warn(`Lock non trovato per l'operazione ${taskName} (ID: ${lockId})`);
    return false;
  } catch (error) {
    logger.error(`Errore nel rilascio del lock per l'operazione ${taskName}:`, error);
    return false;
  }
}

/**
 * Esegue un'operazione con lock di sicurezza
 * @param {string} taskName - Nome dell'operazione
 * @param {Function} taskFunction - Funzione da eseguire
 * @param {number} timeoutMs - Timeout in millisecondi per il lock
 * @returns {Promise<any>} - Risultato dell'operazione
 */
async function executeWithLock(taskName, taskFunction, timeoutMs = TASK_LOCK_TIMEOUT) {
  // Acquisisce il lock
  const { success, lockId } = await acquireTaskLock(taskName, timeoutMs);
  
  if (!success || !lockId) {
    // Non è stato possibile acquisire il lock, l'operazione è già in corso
    logger.info(`Operazione ${taskName} già in corso, salto l'esecuzione`);
    return null;
  }
  
  try {
    // Esegue l'operazione
    const result = await taskFunction();
    return result;
  } catch (error) {
    logger.error(`Errore nell'esecuzione dell'operazione ${taskName}:`, error);
    throw error;
  } finally {
    // Rilascia il lock in ogni caso
    await releaseTaskLock(taskName, lockId);
  }
}

/**
 * Pulisce i task lock scaduti
 * @returns {Promise<number>} - Numero di lock scaduti rimossi
 */
async function cleanupExpiredTaskLocks() {
  try {
    const result = await TaskLock.deleteMany({
      expires_at: { $lt: new Date() }
    });
    
    if (result.deletedCount > 0) {
      logger.info(`Rimossi ${result.deletedCount} task lock scaduti`);
    }
    
    return result.deletedCount;
  } catch (error) {
    logger.error('Errore nella pulizia dei task lock scaduti:', error);
    return 0;
  }
}

/**
 * Funzione principale per verificare la presenza di una connessione globalmente attiva
 * @returns {Promise<boolean>} - true se nessuna connessione attiva rilevata, false se c'è una connessione attiva
 */
async function checkGlobalConnectionState() {
  try {
    // Pulisci i lock scaduti
    await cleanupExpiredTaskLocks();
    
    // Verifica la presenza di lock attivi nel DB
    const activeLocks = await Lock.find({
      lock_type: 'execution',
      last_heartbeat: { $gt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) }
    });
    
    // Se non ci sono lock attivi, probabilmente non ci sono istanze attive
    if (activeLocks.length === 0) {
      logger.info('Nessun lock attivo rilevato nel DB, probabilmente non ci sono istanze attive');
      return true;
    }
    
    // Verifica se il lock appartiene a questa istanza
    const ownLock = activeLocks.find(lock => lock.instance_id === INSTANCE_ID);
    if (ownLock) {
      logger.info('Lock attivo appartiene a questa istanza');
      return true;
    }

    // Se ci sono lock di altre istanze, attendiamo
    logger.warn(`Rilevati ${activeLocks.length} lock attivi di altre istanze, meglio attendere`);
    return false;
  } catch (error) {
    logger.error('Errore nel controllo dello stato globale:', error);
    // In caso di errore, assumiamo che sia meglio attendere
    return false;
  }
}

/**
 * Verifica se è possibile connettersi a Telegram senza conflitti
 * @returns {Promise<boolean>} - true se la connessione è riuscita
 */
async function testTelegramConnection() {
  // Se abbiamo rilevato un conflitto negli ultimi 30 secondi, meglio attendere
  if (telegramConflictDetected && lastTelegramConflictTime) {
    const timeSinceLastConflict = Date.now() - lastTelegramConflictTime;
    if (timeSinceLastConflict < 30000) {
      logger.warn(`Conflitto Telegram rilevato ${Math.round(timeSinceLastConflict/1000)}s fa, meglio attendere`);
      return false;
    }
  }

  try {
    // Usiamo un lock per evitare che più istanze tentino di testare contemporaneamente
    const { success } = await acquireTaskLock('telegram_test', 5000);
    if (!success) {
      logger.warn('Un\'altra istanza sta già testando la connessione Telegram, attendiamo');
      return false;
    }
    
    const testBot = new TelegramBot(config.BOT_TOKEN, { polling: false });
    await testBot.getMe();
    // Reset del flag di conflitto se la connessione ha successo
    telegramConflictDetected = false;
    return true;
  } catch (error) {
    if (error.code === 'ETELEGRAM' && error.message && error.message.includes('409 Conflict')) {
      logger.warn('Conflitto Telegram rilevato durante il test di connessione');
      // Setta il flag di conflitto e il timestamp
      telegramConflictDetected = true;
      lastTelegramConflictTime = Date.now();
      return false;
    }
    logger.error('Errore durante il test di connessione a Telegram:', error);
    // In caso di altri errori, meglio evitare di connettersi
    return false;
  }
}

// Inizializzazione connessione MongoDB
logger.info('Tentativo di connessione a MongoDB...');
mongoose.connect(config.MONGODB_URI, mongooseOptions)
  .then(async () => {
    logger.info('✅ Connessione a MongoDB riuscita');
    
    // Inizializza i modelli se necessario
    if (!mongoose.models.TaskLock) {
      mongoose.model('TaskLock', require('./models/taskLock').schema);
    }
    
    // Pulisci eventuali task lock rimasti
    await cleanupExpiredTaskLocks();
    
    // Avvia il bot
    initializeBot();
  })
  .catch(err => {
    logger.error('❌ Errore di connessione a MongoDB:', err);
    logger.error(`URI MongoDB: ${config.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//****:****@')}`);
    process.exit(1);
  });

/**
 * Avvia la sequenza di inizializzazione del bot
 */
async function initializeBot() {
  try {
    // Pulisci eventuali lock orfani appartenenti a questa istanza (improbabile ma per sicurezza)
    await Lock.deleteMany({ instance_id: INSTANCE_ID });
    await TaskLock.deleteMany({ instance_id: INSTANCE_ID });
    
    // Attendi un periodo casuale prima di tentare di acquisire il master lock
    // Aumenta il ritardo per ridurre i conflitti durante i deploy
    const delayMs = MIN_INITIAL_DELAY + Math.floor(Math.random() * (MAX_INITIAL_DELAY - MIN_INITIAL_DELAY));
    logger.info(`Attesa di ${delayMs}ms prima di tentare di acquisire il master lock...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    // Prima di procedere, verifica lo stato globale
    const canProceed = await checkGlobalConnectionState();
    if (!canProceed) {
      logger.warn('Rilevate altre istanze attive, attesa aggiuntiva prima di procedere...');
      await new Promise(resolve => setTimeout(resolve, 15000 + Math.random() * 15000));
    }
    
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
      }, 20000 + Math.random() * 20000); // Attesa più lunga in caso di conflitto rilevato
      return;
    }
    
    // Verifica se c'è già un'istanza attiva con un lock di esecuzione
    const activeLock = await Lock.findOne({ 
      lock_type: 'execution',
      last_heartbeat: { $gt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) } // Considerare attivi i lock con heartbeat negli ultimi 60 secondi
    });
    
    if (activeLock) {
      // Ignora il lock se appartiene a questa istanza (potrebbe succedere in casi rari)
      if (activeLock.instance_id === INSTANCE_ID) {
        logger.info(`Il lock di esecuzione appartiene già a questa istanza, continuando...`);
      } else {
        // Se c'è già un'istanza attiva, attendiamo di più
        logger.info(`Rilevato un lock di esecuzione attivo: ${activeLock.instance_id}`);
        logger.info(`L'istanza ${activeLock.instance_id} è attiva. Attendiamo più a lungo prima di riprovare.`);
        
        // Attesa più lunga per dare tempo all'altra istanza di terminare
        setTimeout(() => {
          if (!isShuttingDown) acquireMasterLock();
        }, 30000 + Math.random() * 30000);
        return;
      }
    }
    
    // Cerca lock scaduti (vecchi) e li rimuove
    const staleLocksRemoved = await Lock.deleteMany({
      last_heartbeat: { $lt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) }
    });
    
    if (staleLocksRemoved.deletedCount > 0) {
      logger.info(`Rimossi ${staleLocksRemoved.deletedCount} lock scaduti`);
    }
    
    // Verifica se esiste già un master lock valido
    const masterLock = await Lock.findOne({ 
      name: 'master_lock',
      lock_type: 'master',
      last_heartbeat: { $gt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) } // Considerare attivi i lock con heartbeat negli ultimi 60 secondi
    });
    
    if (masterLock) {
      // Se c'è già un master lock attivo e non è di questa istanza, attendere e riprovare
      if (masterLock.instance_id !== INSTANCE_ID) {
        logger.info(`Master lock già acquisito da un'altra istanza (${masterLock.instance_id}), attesa di 20 secondi...`);
        setTimeout(acquireMasterLock, 20000);
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
      last_heartbeat: { $lt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) }
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
      }, 15000 + Math.random() * 15000);
      return;
    }
    
    // Verifica se esiste già un lock di esecuzione valido
    const executionLock = await Lock.findOne({ 
      name: 'execution_lock',
      lock_type: 'execution',
      last_heartbeat: { $gt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) } // Considerare attivi i lock con heartbeat negli ultimi 60 secondi
    });
    
    if (executionLock) {
      // Se c'è già un lock di esecuzione attivo e non è di questa istanza, attendere e riprovare
      if (executionLock.instance_id !== INSTANCE_ID) {
        logger.info(`Lock di esecuzione già acquisito da un'altra istanza (${executionLock.instance_id}), attesa di 15 secondi...`);
        setTimeout(() => {
          if (!isShuttingDown) acquireExecutionLock();
        }, 15000);
        return;
      } else {
        // Se il lock di esecuzione è già di questa istanza, lo aggiorniamo
        logger.info(`Lock di esecuzione già nostro, aggiornamento heartbeat`);
        executionLock.last_heartbeat = new Date();
        lastHeartbeatTime = Date.now();
        await executionLock.save();
        
        // Procediamo con l'avvio del bot se non è già avviato
        if (!bot && !isBotStarting) {
          startBot();
        }
        return;
      }
    }
    
    // Se ci sono lock scaduti, li eliminiamo
    const oldLocksResult = await Lock.deleteMany({
      name: 'execution_lock',
      lock_type: 'execution',
      last_heartbeat: { $lt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) }
    });
    
    if (oldLocksResult.deletedCount > 0) {
      logger.info(`Eliminati ${oldLocksResult.deletedCount} lock di esecuzione scaduti`);
    }
    
    // Creazione del lock di esecuzione
    const lock = new Lock({
      name: 'execution_lock',
      lock_type: 'execution',
      instance_id: INSTANCE_ID,
      created_at: new Date(),
      last_heartbeat: new Date()
    });
    
    await lock.save();
    lastHeartbeatTime = Date.now();
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
    
    // Attendi un po' prima di avviare il bot per sicurezza
    setTimeout(() => {
      // Procedi con l'avvio del bot se non è già in avvio
      if (!isBotStarting) {
        startBot();
      }
    }, 2000);
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
      // Usa executeWithLock per evitare operazioni concorrenti
      await executeWithLock('master_heartbeat', async () => {
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
      });
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
      // Usa executeWithLock per evitare operazioni concorrenti
      await executeWithLock('execution_heartbeat', async () => {
        const lock = await Lock.findOne({ 
          name: 'execution_lock', 
          lock_type: 'execution',
          instance_id: INSTANCE_ID 
        });
        
        if (lock) {
          lock.last_heartbeat = new Date();
          lastHeartbeatTime = Date.now();
          await lock.save();
          logger.debug(`Heartbeat per lock di esecuzione inviato (${INSTANCE_ID})`);
        } else {
          logger.warn(`Lock di esecuzione non trovato durante heartbeat, tentativo di riacquisizione...`);
          clearInterval(executionLockHeartbeatInterval);
          executionLockHeartbeatInterval = null;
          
          // Se il bot è in esecuzione, fermalo
          if (bot) {
            try {
              await stopBot();
              logger.info(`Bot fermato per perdita del lock di esecuzione`);
            } catch (err) {
              logger.error(`Errore durante l'arresto del bot:`, err);
            }
          }
          
          // Tenta di riacquisire il lock di esecuzione
          if (!isShuttingDown) {
            // Attendi un po' prima di riprovare per non creare race conditions
            setTimeout(acquireExecutionLock, 5000 + Math.random() * 5000);
          }
        }
      });
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
      // Verifica se il lock è stato aggiornato di recente (negli ultimi 30 secondi)
      const timeSinceLastHeartbeat = Date.now() - lastHeartbeatTime;
      if (timeSinceLastHeartbeat > 30000) {
        logger.warn(`Nessun heartbeat per il lock di esecuzione negli ultimi ${Math.round(timeSinceLastHeartbeat/1000)}s, possibile problema`);
      }
      
      // Usa executeWithLock per evitare operazioni concorrenti
      await executeWithLock('lock_check', async () => {
        // Pulisci i task lock scaduti
        await cleanupExpiredTaskLocks();
        
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
        
        // Verifica se ci sono altri lock di esecuzione attivi che non sono nostri
        const otherActiveLocks = await Lock.find({
          name: 'execution_lock',
          lock_type: 'execution',
          instance_id: { $ne: INSTANCE_ID },
          last_heartbeat: { $gt: new Date(Date.now() - GLOBAL_LOCK_TIMEOUT) }
        });
        
        if (otherActiveLocks.length > 0 && executionLock) {
          logger.warn(`Rilevati ${otherActiveLocks.length} altri lock di esecuzione attivi, possibile conflitto.`);
          
          // Se abbiamo rilevato un conflitto Telegram recentemente, terminiamo 
          // la nostra sessione per lasciare il controllo all'altra istanza
          if (telegramConflictDetected && lastTelegramConflictTime && 
              (Date.now() - lastTelegramConflictTime < 60000)) {
              
            logger.warn('Conflitto Telegram recente rilevato, terminazione volontaria per evitare problemi');
            await performShutdown('CONFLICT_AVOIDANCE');
          }
        }
      });
    } catch (error) {
      logger.error(`Errore durante il controllo dei lock:`, error);
    }
  }, 30000); // Controlla ogni 30 secondi (ridotto per minimizzare overhead)
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
    
    // Rilascia tutti i task lock di questa istanza
    const taskLockResult = await TaskLock.deleteMany({
      instance_id: INSTANCE_ID
    });
    
    if (taskLockResult.deletedCount > 0) {
      logger.info(`Rilasciati ${taskLockResult.deletedCount} task lock`);
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
 * Funzione per fermare il bot in modo sicuro
 */
async function stopBot() {
  if (!bot) return; // Se non c'è bot, nulla da fare
  
  try {
    // Ferma il sistema di notifiche
    if (notificationSystem && notificationSystem.stop) {
      notificationSystem.stop();
      notificationSystem = null;
      logger.info('Sistema di notifiche fermato');
    }
    
    // Ferma il polling del bot
    logger.info('Arresto polling Telegram...');
    await bot.stopPolling();
    
    // Attendi un po' per assicurarsi che il polling sia completamente fermato
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Resetta il bot
    bot = null;
    
    // Resetta il contatore dei tentativi
    pollingRetryCount = 0;
    
    // Resetta il flag di avvio
    isBotStarting = false;
    
    return true;
  } catch (error) {
    logger.error('Errore durante l\'arresto del bot:', error);
    bot = null; // Forza il reset del bot anche in caso di errore
    return false;
  }
}

/**
 * Avvia il bot Telegram
 */
function startBot() {
  if (isShuttingDown) return; // Non avviare il bot durante lo shutdown
  if (bot) return; // Non avviare il bot se è già in esecuzione
  if (isBotStarting) return; // Non avviare il bot se è già in fase di avvio
  
  // Imposta il flag di avvio
  isBotStarting = true;
  
  // Esegui con lock per evitare avvii multipli
  executeWithLock('bot_start', async () => {
    // Verifica se c'è stato un conflitto recente
    const shouldDelay = telegramConflictDetected && lastTelegramConflictTime && 
                       (Date.now() - lastTelegramConflictTime < 30000);
    
    // Se c'è stato un conflitto recente, attendiamo prima di riavviare
    if (shouldDelay) {
      const delayTime = 30000 - (Date.now() - lastTelegramConflictTime);
      logger.info(`Attesa di ${Math.round(delayTime/1000)}s prima di avviare il bot per evitare conflitti`);
      
      await new Promise(resolve => setTimeout(resolve, delayTime));
    }
    
    // Verifica se siamo ancora l'istanza attiva
    const isActive = await isActiveInstance();
    if (!isActive) {
      logger.warn('Non siamo più l\'istanza attiva, annullo l\'avvio del bot');
      isBotStarting = false;
      return;
    }
    
    // Avvia il bot
    await startBotImplementation();
  }).catch(err => {
    logger.error('Errore durante l\'avvio del bot con lock:', err);
    isBotStarting = false;
  });
}

/**
 * Implementazione effettiva dell'avvio del bot
 */
async function startBotImplementation() {
  try {
    logger.info('Avvio del bot...');
    
    // Verifica se ci sono già conflitti Telegram
    const telegramStatus = await testTelegramConnection();
    if (!telegramStatus) {
      logger.warn('Rilevato conflitto Telegram prima dell\'avvio del bot, attendiamo...');
      isBotStarting = false;
      setTimeout(startBot, 20000 + Math.random() * 10000);
      return;
    }
    
    // Inizializzazione bot Telegram
    bot = new TelegramBot(config.BOT_TOKEN, { 
      polling: {
        interval: 1000, // Intervallo tra le richieste di polling in ms
        timeout: 30, // Timeout per il long polling in secondi
        limit: 100, // Massimo numero di aggiornamenti da ricevere in una volta
        retryTimeout: 5000, // Tempo di attesa dopo un errore prima di riprovare
        autoStart: true // Avvia automaticamente il polling
      },
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
        // Setta i flag di conflitto
        telegramConflictDetected = true;
        lastTelegramConflictTime = Date.now();
        
        logger.warn('Rilevato conflitto con altra istanza Telegram, gestione...');
        pollingRetryCount++;
        
        // Se abbiamo troppi tentativi falliti, meglio terminare
        if (pollingRetryCount > MAX_RETRY_COUNT) {
          logger.warn(`Troppi tentativi falliti (${pollingRetryCount}), terminazione...`);
          
          // Immediato arresto del polling per evitare ulteriori errori
          performShutdown('TELEGRAM_CONFLICT');
          return;
        }
        
        // Calcola il tempo di backoff esponenziale (tra 2 e 30 secondi)
        const backoffTime = Math.min(1000 * Math.pow(2, pollingRetryCount) + Math.random() * 1000, 30000);
        logger.info(`Attesa di ${Math.round(backoffTime/1000)} secondi prima di riprovare (tentativo ${pollingRetryCount})...`);
        
        // Ferma il polling attuale
        stopBot().then(() => {
          // Riprova dopo il backoff
          setTimeout(() => {
            if (!isShuttingDown) {
              logger.info(`Tentativo di riconnessione #${pollingRetryCount}...`);
              isBotStarting = false; // Reset del flag per permettere il riavvio
              startBot(); // Riavvia il bot
            }
          }, backoffTime);
        });
        
        return;
      } else if (error.code === 'EFATAL' || error.code === 'EPARSE' || error.code === 'ETELEGRAM') {
        // Per errori fatali, EPARSE o altri errori di Telegram, attendiamo un po' e ritentiamo
        logger.warn(`Errore ${error.code}, tentatvo di ripartire il bot...`);
        stopBot().then(() => {
          // Attesa prima di riprovare
          setTimeout(() => {
            if (!isShuttingDown) {
              isBotStarting = false;
              startBot();
            }
          }, 5000);
        });
      }
    });
    
    // Test della connessione a Telegram
    logger.info('Verifica connessione a Telegram...');
    const info = await bot.getMe();
    logger.info(`✅ Bot connesso correttamente come @${info.username} (ID: ${info.id})`);
    
    // Reset flag di avvio
    isBotStarting = false;
    
    // Reset del contatore e del flag di conflitto quando la connessione ha successo
    pollingRetryCount = 0;
    telegramConflictDetected = false;
    
    // Controlla se è stata inviata una notifica di avvio nelle ultime 2 ore
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
    
    // Inizializza i comandi del bot
    try {
      await messageHandler.init(bot);
    } catch (err) {
      logger.error('Errore nell\'inizializzazione dell\'handler messaggi:', err);
    }

    // Avvio sistema di notifiche periodiche
    logger.info('Avvio sistema di notifiche...');
    try {
      // Ferma eventuali sistemi di notifiche precedenti
      if (notificationSystem && notificationSystem.stop) {
        notificationSystem.stop();
      }
      
      notificationSystem = notifier.startNotificationSystem(bot, executeWithLock, isActiveInstance);
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
    
    // Reset flag di avvio
    isBotStarting = false;
    
    // Se il bot è stato creato, proviamo a fermarlo
    if (bot) {
      await stopBot();
    }
    
    // Ritentiamo l'avvio dopo un po'
    if (!isShuttingDown) {
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
    await stopBot();
    
    // Attendi che il bot si fermi completamente
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Ora rilascia i lock
    await releaseAllLocks();
    
    // Resetta il contatore dei retry
    pollingRetryCount = 0;
    
    // Resetta i flag di conflitto
    telegramConflictDetected = false;
    lastTelegramConflictTime = null;
    
    // Resetta il flag di avvio
    isBotStarting = false;
    
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

// Esportazione per test
module.exports = {
  acquireTaskLock,
  releaseTaskLock,
  executeWithLock,
  isActiveInstance
};
