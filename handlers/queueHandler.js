const Session = require('../models/session');
const Queue = require('../models/queue');
const System = require('../models/system');
const User = require('../models/user');
const config = require('../config');
const moment = require('moment');
const logger = require('../utils/logger');
const formatters = require('../utils/formatters');

/**
 * Richiede uno slot di ricarica
 * @param {Number} userId - ID Telegram dell'utente
 * @param {String} username - Username Telegram dell'utente
 * @returns {Promise<Object>} - Oggetto risultato con stato e messaggio
 */
async function requestCharge(userId, username) {
  try {
    logger.info(`User ${userId} (${username}) requesting a charging slot`);
    
    // Controlla se l'utente è già in una sessione attiva
    const activeSession = await Session.findOne({ 
      telegram_id: userId, 
      status: 'active' 
    });
    
    if (activeSession) {
      logger.info(`User ${userId} already has an active session`);
      throw new Error('Hai già una sessione di ricarica attiva.');
    }
    
    // Controlla se l'utente è già in coda
    const inQueue = await Queue.findOne({ telegram_id: userId });
    if (inQueue) {
      logger.info(`User ${userId} is already in queue at position ${inQueue.position}`);
      return {
        slotAvailable: false,
        position: inQueue.position,
        message: 'Sei già in coda.'
      };
    }
    
    // Ottieni lo stato del sistema
    logger.info('Getting system status');
    let system = await System.findOne({ name: 'system' });
    if (!system) {
      // Inizializza il sistema se non esiste
      logger.info('System not found, creating a new one');
      system = new System();
      await system.save();
    }
    
    // Controlla se ci sono slot disponibili
    if (system.slots_available > 0) {
      logger.info(`Slot available (${system.slots_available}/${system.total_slots})`);
      return {
        slotAvailable: true,
        message: 'Slot disponibile. Puoi procedere con la ricarica.'
      };
    } else {
      // Aggiungi l'utente alla coda
      logger.info(`No slots available. Adding user ${userId} to queue`);
      const position = system.queue_length + 1;
      
      const queueEntry = new Queue({
        telegram_id: userId,
        username,
        position
      });
      
      await queueEntry.save();
      
      // Aggiorna la lunghezza della coda nel sistema
      system.queue_length = position;
      await system.save();
      
      logger.info(`User ${userId} added to queue at position ${position}`);
      
      return {
        slotAvailable: false,
        position,
        message: 'Tutti gli slot sono occupati. Sei stato aggiunto alla coda.'
      };
    }
  } catch (error) {
    logger.error(`Error in requestCharge for user ${userId}: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Ottiene gli utenti in coda
 * @returns {Promise<Array>} - Array di utenti in coda
 */
async function getQueuedUsers() {
  try {
    logger.info('Getting queued users');
    return await Queue.find().sort({ position: 1 });
  } catch (error) {
    logger.error(`Error getting queued users: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Ottiene un utente in coda per posizione
 * @param {Number} position - Posizione in coda
 * @returns {Promise<Object|null>} - Oggetto utente in coda o null se non trovato
 */
async function getUserByPosition(position) {
  try {
    logger.info(`Getting user at queue position ${position}`);
    return await Queue.findOne({ position });
  } catch (error) {
    logger.error(`Error getting user at position ${position}: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Ottiene il prossimo utente in coda
 * @returns {Promise<Object|null>} - Oggetto utente in coda o null se non ce ne sono
 */
async function getNextInQueue() {
  try {
    logger.info('Getting next user in queue');
    return await Queue.findOne().sort({ position: 1 });
  } catch (error) {
    logger.error(`Error getting next user in queue: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Rimuove un utente dalla coda
 * @param {Number} userId - ID Telegram dell'utente
 * @returns {Promise<Object|null>} - Oggetto utente rimosso o null se non trovato
 */
async function removeFromQueue(userId) {
  try {
    logger.info(`Removing user ${userId} from queue`);
    
    // Trova l'utente in coda
    const queuedUser = await Queue.findOne({ telegram_id: userId });
    
    if (!queuedUser) {
      logger.info(`User ${userId} not found in queue`);
      return null;
    }
    
    const position = queuedUser.position;
    
    // Rimuovi l'utente dalla coda
    await Queue.deleteOne({ telegram_id: userId });
    
    // Aggiorna le posizioni degli altri utenti in coda
    logger.info(`Updating positions for users after position ${position}`);
    await Queue.updateMany(
      { position: { $gt: position } },
      { $inc: { position: -1 } }
    );
    
    // Aggiorna la lunghezza della coda nel sistema
    logger.info('Updating system queue length');
    const system = await System.findOne({ name: 'system' });
    if (system) {
      system.queue_length = Math.max(0, system.queue_length - 1);
      await system.save();
    }
    
    logger.info(`User ${userId} removed from queue at position ${position}`);
    
    return queuedUser;
  } catch (error) {
    logger.error(`Error removing user ${userId} from queue: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Notifica il prossimo utente in coda
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Promise<Object|null>} - Oggetto utente notificato o null se nessuno in coda
 */
async function notifyNextInQueue(bot) {
  try {
    logger.info('Checking for next user in queue to notify');
    
    // Verifica se ci sono slot disponibili
    const system = await System.findOne({ name: 'system' });
    
    if (!system || system.slots_available <= 0) {
      logger.info('No slots available, skipping notification');
      return null;
    }
    
    // Trova il prossimo utente in coda
    const nextUser = await getNextInQueue();
    
    if (!nextUser) {
      logger.info('No users in queue');
      return null;
    }
    
    // Aggiorna lo stato dell'utente in coda (notificato ma non rimosso)
    nextUser.notified = true;
    nextUser.notification_time = new Date();
    nextUser.slot_reserved = true;
    await nextUser.save();
    
    logger.info(`User ${nextUser.username} (${nextUser.telegram_id}) marked as notified and slot reserved`);
    
    // Se il bot è disponibile, invia una notifica
    if (bot) {
      logger.info(`Notifying user ${nextUser.username} (${nextUser.telegram_id}) about available slot`);
      
      const notificationMessage = formatters.formatNotificationMessage(
        nextUser.username, 
        nextUser.telegram_id, 
        config.MAX_CHARGE_TIME
      );
      
      bot.sendMessage(
        nextUser.telegram_id,
        notificationMessage,
        { parse_mode: 'Markdown' }
      );
      
      logger.info(`Notified user ${nextUser.username} (${nextUser.telegram_id}) about available slot`);
    }
    
    return nextUser;
  } catch (error) {
    logger.error(`Error notifying next user in queue: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Controlla e gestisce gli utenti che hanno ricevuto una notifica ma non hanno iniziato la ricarica
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Promise<void>}
 */
async function checkQueueTimeouts(bot) {
  try {
    const now = new Date();
    // Tempo limite: 5 minuti fa
    const timeoutThreshold = new Date(now.getTime() - 5 * 60000);
    
    logger.info('Checking for queue timeouts...');
    
    // Trova utenti notificati che non hanno iniziato la ricarica entro il tempo limite
    const timedOutUsers = await Queue.find({
      notified: true,
      notification_time: { $lt: timeoutThreshold },
      slot_reserved: true
    });
    
    logger.info(`Found ${timedOutUsers.length} users with queue timeout`);
    
    for (const user of timedOutUsers) {
      // Notifica l'utente che ha perso il suo turno
      if (bot) {
        bot.sendMessage(
          user.telegram_id,
          `⏱️ *Tempo scaduto*\n\n` +
          `@${user.username}, sono passati più di 5 minuti dalla notifica della disponibilità dello slot di ricarica. ` +
          `Il tuo turno è stato saltato e lo slot sarà assegnato al prossimo utente in coda.\n\n` +
          `Se desideri ancora ricaricare, utilizza nuovamente il comando /prenota per metterti in coda.`,
          { parse_mode: 'Markdown' }
        );
      }
      
      logger.info(`Queue timeout for user ${user.username} (${user.telegram_id}), removing from queue`);
      
      // Rimuovi l'utente dalla coda
      await removeFromQueue(user.telegram_id);
      
      // Notifica il prossimo utente in coda
      await notifyNextInQueue(bot);
    }
  } catch (error) {
    logger.error(`Error checking queue timeouts: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Verifica se l'utente ha uno slot riservato
 * @param {Number} userId - ID Telegram dell'utente
 * @returns {Promise<Boolean>} - true se l'utente ha uno slot riservato, false altrimenti
 */
async function hasReservedSlot(userId) {
  try {
    const queueEntry = await Queue.findOne({ 
      telegram_id: userId,
      slot_reserved: true
    });
    
    return queueEntry !== null;
  } catch (error) {
    logger.error(`Error checking reserved slot for user ${userId}: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Ottiene lo stato attuale del sistema
 * @returns {Promise<Object>} - Oggetto con lo stato del sistema
 */
async function getSystemStatus() {
  try {
    logger.info('getSystemStatus: Starting to get system status');
    
    // Ottieni lo stato del sistema
    logger.info('getSystemStatus: Querying system document');
    const system = await System.findOne({ name: 'system' });
    
    if (!system) {
      logger.info('getSystemStatus: System not found, creating new one');
      // Inizializza un nuovo sistema invece di lanciare un errore
      const newSystem = new System();
      await newSystem.save();
      
      logger.info('getSystemStatus: Returning empty status for new system');
      // Restituisci una struttura semplice senza sessioni o code
      return {
        total_slots: newSystem.total_slots,
        slots_available: newSystem.slots_available,
        slots_occupied: 0,
        active_sessions: [],
        queue: [],
        queue_length: 0
      };
    }
    
    logger.info('getSystemStatus: System found, getting active sessions');
    // Ottieni le sessioni attive
    const activeSessions = await Session.find({ status: 'active' })
      .sort({ end_time: 1 });
    
    logger.info(`getSystemStatus: Found ${activeSessions.length} active sessions`);
    
    // Aggiungi informazioni sul tempo rimanente
    const now = new Date();
    const sessionsWithTime = activeSessions.map(session => {
      const remainingTime = Math.max(0, Math.round((new Date(session.end_time) - now) / 60000));
      return {
        telegram_id: session.telegram_id,
        username: session.username,
        slot_number: session.slot_number,
        start_time: session.start_time,
        end_time: session.end_time,
        remaining_minutes: remainingTime
      };
    });
    
    logger.info('getSystemStatus: Getting users in queue');
    // Ottieni gli utenti in coda
    const queuedUsers = await Queue.find().sort({ position: 1 });
    
    logger.info(`getSystemStatus: Found ${queuedUsers.length} users in queue`);
    logger.info('getSystemStatus: Returning complete status');
    
    return {
      total_slots: system.total_slots,
      slots_available: system.slots_available,
      slots_occupied: system.total_slots - system.slots_available,
      active_sessions: sessionsWithTime,
      queue: queuedUsers,
      queue_length: queuedUsers.length
    };
  } catch (error) {
    logger.error(`Error in getSystemStatus: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Aggiorna il numero massimo di slot del sistema
 * @param {Number} newMaxSlots - Nuovo numero massimo di slot
 * @returns {Promise<Object>} - Oggetto sistema aggiornato
 */
async function updateMaxSlots(newMaxSlots) {
  try {
    logger.info(`Updating max slots to ${newMaxSlots}`);
    
    if (newMaxSlots < 1) {
      logger.warn(`Invalid max slots value: ${newMaxSlots}`);
      throw new Error('Il numero di slot deve essere almeno 1.');
    }
    
    let system = await System.findOne({ name: 'system' });
    
    if (!system) {
      logger.info('System not found, creating a new one');
      system = new System();
    }
    
    const oldMaxSlots = system.total_slots;
    system.total_slots = newMaxSlots;
    
    // Se il nuovo massimo è maggiore, aumenta gli slot disponibili
    if (newMaxSlots > oldMaxSlots) {
      logger.info(`Increasing available slots by ${newMaxSlots - oldMaxSlots}`);
      system.slots_available += (newMaxSlots - oldMaxSlots);
    } else if (newMaxSlots < oldMaxSlots) {
      // Se il nuovo massimo è minore, diminuisci gli slot disponibili (ma non sotto zero)
      logger.info(`Decreasing available slots by ${oldMaxSlots - newMaxSlots}`);
      system.slots_available = Math.max(0, system.slots_available - (oldMaxSlots - newMaxSlots));
    }
    
    await system.save();
    logger.info(`Updated max slots from ${oldMaxSlots} to ${newMaxSlots}`);
    
    return system;
  } catch (error) {
    logger.error(`Error updating max slots to ${newMaxSlots}: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Rimuove un utente dalla coda (comando admin)
 * @param {String} username - Username Telegram dell'utente
 * @returns {Promise<Object|null>} - Oggetto utente rimosso o null se non trovato
 */
async function adminRemoveFromQueue(username) {
  try {
    logger.info(`Admin removing user ${username} from queue`);
    
    // Trova l'utente tramite username
    const queuedUser = await Queue.findOne({ username: username.replace('@', '') });
    
    if (!queuedUser) {
      logger.info(`User ${username} not found in queue`);
      throw new Error(`Utente @${username} non trovato in coda.`);
    }
    
    logger.info(`Found user ${username} in queue, removing`);
    return await removeFromQueue(queuedUser.telegram_id);
  } catch (error) {
    logger.error(`Error admin removing ${username} from queue: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

/**
 * Ottiene statistiche complete del sistema
 * @returns {Promise<Object>} - Oggetto con le statistiche
 */
async function getSystemStats() {
  try {
    logger.info('Getting system statistics');
    
    const system = await System.findOne({ name: 'system' });
    
    if (!system) {
      logger.info('System not found, creating a new one');
      // Crea un nuovo sistema con statistiche di default
      const newSystem = new System();
      await newSystem.save();
      
      logger.info('Returning default statistics for new system');
      return {
        total_slots: newSystem.total_slots,
        total_charges_completed: 0,
        charges_today: 0,
        avg_charge_time: 0,
        total_users: 0,
        active_users: 0,
        current_status: {
          slots_available: newSystem.total_slots,
          slots_occupied: 0,
          queue_length: 0
        }
      };
    }
    
    // Calcola statistiche dalle sessioni
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    logger.info('Counting completed sessions');
    const totalSessions = await Session.countDocuments({ status: { $ne: 'active' } });
    const todaySessions = await Session.countDocuments({
      status: { $ne: 'active' },
      end_time: { $gte: today }
    });
    
    // Calcola tempo medio di ricarica
    logger.info('Calculating average charging time');
    const completedSessions = await Session.find({ status: { $ne: 'active' } });
    let totalTime = 0;
    
    completedSessions.forEach(session => {
      const startTime = new Date(session.start_time);
      const endTime = new Date(session.end_time);
      const duration = (endTime - startTime) / 60000; // in minuti
      totalTime += duration;
    });
    
    const avgTime = totalSessions > 0 ? Math.round(totalTime / totalSessions) : 0;
    
    // Statistiche utenti
    logger.info('Getting user statistics');
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({
      last_charge: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // ultimi 30 giorni
    });
    
    logger.info('Returning complete statistics');
    return {
      total_slots: system.total_slots,
      total_charges_completed: system.total_charges_completed,
      charges_today: todaySessions,
      avg_charge_time: avgTime,
      total_users: totalUsers,
      active_users: activeUsers,
      current_status: {
        slots_available: system.slots_available,
        slots_occupied: system.total_slots - system.slots_available,
        queue_length: system.queue_length
      }
    };
  } catch (error) {
    logger.error(`Error getting system stats: ${error.message}`);
    logger.error(error.stack);
    throw error;
  }
}

module.exports = {
  requestCharge,
  getQueuedUsers,
  getUserByPosition,
  getNextInQueue,
  removeFromQueue,
  notifyNextInQueue,
  checkQueueTimeouts,
  hasReservedSlot,
  getSystemStatus,
  updateMaxSlots,
  adminRemoveFromQueue,
  getSystemStats
};
