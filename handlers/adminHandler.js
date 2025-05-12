const Session = require('../models/session');
const Queue = require('../models/queue');
const System = require('../models/system');
const User = require('../models/user');
const config = require('../config');
const moment = require('moment');
const logger = require('../utils/logger');

/**
 * Richiede uno slot di ricarica
 * @param {Number} userId - ID Telegram dell'utente
 * @param {String} username - Username Telegram dell'utente
 * @returns {Promise<Object>} - Oggetto risultato con stato e messaggio
 */
async function requestCharge(userId, username) {
  try {
    // Controlla se l'utente è già in una sessione attiva
    const activeSession = await Session.findOne({ 
      telegram_id: userId, 
      status: 'active' 
    });
    
    if (activeSession) {
      throw new Error('Hai già una sessione di ricarica attiva.');
    }
    
    // Controlla se l'utente è già in coda
    const inQueue = await Queue.findOne({ telegram_id: userId });
    if (inQueue) {
      return {
        slotAvailable: false,
        position: inQueue.position,
        message: 'Sei già in coda.'
      };
    }
    
    // Ottieni lo stato del sistema
    let system = await System.findOne({ name: 'system' });
    if (!system) {
      // Inizializza il sistema se non esiste
      system = new System();
      await system.save();
    }
    
    // Controlla se ci sono slot disponibili
    if (system.slots_available > 0) {
      return {
        slotAvailable: true,
        message: 'Slot disponibile. Puoi procedere con la ricarica.'
      };
    } else {
      // Aggiungi l'utente alla coda
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
      
      return {
        slotAvailable: false,
        position,
        message: 'Tutti gli slot sono occupati. Sei stato aggiunto alla coda.'
      };
    }
  } catch (error) {
    logger.error('Error in requestCharge:', error);
    throw error;
  }
}

/**
 * Ottiene gli utenti in coda
 * @returns {Promise<Array>} - Array di utenti in coda
 */
async function getQueuedUsers() {
  try {
    return await Queue.find().sort({ position: 1 });
  } catch (error) {
    logger.error('Error getting queued users:', error);
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
    return await Queue.findOne({ position });
  } catch (error) {
    logger.error(`Error getting user at position ${position}:`, error);
    throw error;
  }
}

/**
 * Ottiene il prossimo utente in coda
 * @returns {Promise<Object|null>} - Oggetto utente in coda o null se non ce ne sono
 */
async function getNextInQueue() {
  try {
    return await Queue.findOne().sort({ position: 1 });
  } catch (error) {
    logger.error('Error getting next user in queue:', error);
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
    // Trova l'utente in coda
    const queuedUser = await Queue.findOne({ telegram_id: userId });
    
    if (!queuedUser) {
      return null;
    }
    
    const position = queuedUser.position;
    
    // Rimuovi l'utente dalla coda
    await Queue.deleteOne({ telegram_id: userId });
    
    // Aggiorna le posizioni degli altri utenti in coda
    await Queue.updateMany(
      { position: { $gt: position } },
      { $inc: { position: -1 } }
    );
    
    // Aggiorna la lunghezza della coda nel sistema
    const system = await System.findOne({ name: 'system' });
    if (system) {
      system.queue_length = Math.max(0, system.queue_length - 1);
      await system.save();
    }
    
    logger.info(`User ${userId} removed from queue at position ${position}`);
    
    return queuedUser;
  } catch (error) {
    logger.error(`Error removing user ${userId} from queue:`, error);
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
    // Verifica se ci sono slot disponibili
    const system = await System.findOne({ name: 'system' });
    
    if (!system || system.slots_available <= 0) {
      return null;
    }
    
    // Trova il prossimo utente in coda
    const nextUser = await getNextInQueue();
    
    if (!nextUser) {
      return null;
    }
    
    // Rimuovi l'utente dalla coda
    await removeFromQueue(nextUser.telegram_id);
    
    // Se il bot è disponibile, invia una notifica
    if (bot) {
      bot.sendMessage(
        nextUser.telegram_id,
        `@${nextUser.username} (ID: ${nextUser.telegram_id}), si è liberato uno slot! È il tuo turno.\n` +
        `Puoi procedere con la ricarica tramite l'app Antonio Green-Charge.\n` +
        `Ricorda che hai a disposizione massimo ${config.MAX_CHARGE_TIME} minuti.\n` +
        `Conferma l'inizio della ricarica con /iniziato quando attivi la colonnina.`
      );
      
      logger.info(`Notified user ${nextUser.username} (${nextUser.telegram_id}) about available slot`);
    }
    
    return nextUser;
  } catch (error) {
    logger.error('Error notifying next user in queue:', error);
    throw error;
  }
}

/**
 * Ottiene lo stato attuale del sistema
 * @returns {Promise<Object>} - Oggetto con lo stato del sistema
 */
async function getSystemStatus() {
  try {
    // Ottieni lo stato del sistema
    const system = await System.findOne({ name: 'system' });
    
    if (!system) {
      throw new Error('Errore di sistema. Configurazione non trovata.');
    }
    
    // Ottieni le sessioni attive
    const activeSessions = await Session.find({ status: 'active' })
      .sort({ end_time: 1 });
    
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
    
    // Ottieni gli utenti in coda
    const queuedUsers = await Queue.find().sort({ position: 1 });
    
    return {
      total_slots: system.total_slots,
      slots_available: system.slots_available,
      slots_occupied: system.total_slots - system.slots_available,
      active_sessions: sessionsWithTime,
      queue: queuedUsers,
      queue_length: queuedUsers.length
    };
  } catch (error) {
    logger.error('Error getting system status:', error);
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
    if (newMaxSlots < 1) {
      throw new Error('Il numero di slot deve essere almeno 1.');
    }
    
    let system = await System.findOne({ name: 'system' });
    
    if (!system) {
      system = new System();
    }
    
    const oldMaxSlots = system.total_slots;
    system.total_slots = newMaxSlots;
    
    // Se il nuovo massimo è maggiore, aumenta gli slot disponibili
    if (newMaxSlots > oldMaxSlots) {
      system.slots_available += (newMaxSlots - oldMaxSlots);
    } else if (newMaxSlots < oldMaxSlots) {
      // Se il nuovo massimo è minore, diminuisci gli slot disponibili (ma non sotto zero)
      system.slots_available = Math.max(0, system.slots_available - (oldMaxSlots - newMaxSlots));
    }
    
    await system.save();
    logger.info(`Updated max slots from ${oldMaxSlots} to ${newMaxSlots}`);
    
    return system;
  } catch (error) {
    logger.error(`Error updating max slots to ${newMaxSlots}:`, error);
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
    // Trova l'utente tramite username
    const queuedUser = await Queue.findOne({ username: username.replace('@', '') });
    
    if (!queuedUser) {
      throw new Error(`Utente @${username} non trovato in coda.`);
    }
    
    return await removeFromQueue(queuedUser.telegram_id);
  } catch (error) {
    logger.error(`Error admin removing ${username} from queue:`, error);
    throw error;
  }
}

/**
 * Ottiene statistiche complete del sistema
 * @returns {Promise<Object>} - Oggetto con le statistiche
 */
async function getSystemStats() {
  try {
    const system = await System.findOne({ name: 'system' });
    
    if (!system) {
      throw new Error('Errore di sistema. Configurazione non trovata.');
    }
    
    // Calcola statistiche dalle sessioni
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const totalSessions = await Session.countDocuments({ status: { $ne: 'active' } });
    const todaySessions = await Session.countDocuments({
      status: { $ne: 'active' },
      end_time: { $gte: today }
    });
    
    // Calcola tempo medio di ricarica
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
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({
      last_charge: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // ultimi 30 giorni
    });
    
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
    logger.error('Error getting system stats:', error);
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
  getSystemStatus,
  updateMaxSlots,
  adminRemoveFromQueue,
  getSystemStats
};
