const Session = require('../models/session');
const System = require('../models/system');
const Queue = require('../models/queue');
const User = require('../models/user');
const userHandler = require('./userHandler');
const queueHandler = require('./queueHandler');
const config = require('../config');
const moment = require('moment');
const logger = require('../utils/logger');

/**
 * Inizia una nuova sessione di ricarica
 * @param {Number} userId - ID Telegram dell'utente
 * @param {String} username - Username Telegram dell'utente
 * @returns {Promise<Object>} - Oggetto sessione creata
 */
async function startSession(userId, username) {
  try {
    // Verifica se l'utente ha già una sessione attiva
    const existingSession = await Session.findOne({
      telegram_id: userId,
      status: 'active'
    });
    
    if (existingSession) {
      throw new Error('Hai già una sessione di ricarica attiva.');
    }
    
    // Verifica se ci sono slot disponibili
    const system = await System.findOne({ name: 'system' });
    
    if (!system) {
      throw new Error('Errore di sistema. Configurazione non trovata.');
    }
    
    // Verifica se l'utente ha uno slot riservato in coda
    const hasReserved = await queueHandler.hasReservedSlot(userId);
    
    if (hasReserved) {
      // Se l'utente ha uno slot riservato, rimuovilo dalla coda
      await queueHandler.removeFromQueue(userId);
      logger.info(`User ${userId} had reserved slot, removed from queue`);
    } else {
      // Se non ha slot riservato, verifica che ci siano slot disponibili
      if (system.slots_available <= 0) {
        throw new Error('Non ci sono slot disponibili al momento. Usa /prenota per metterti in coda.');
      }
    }
    
    // Trova il prossimo slot disponibile
    const usedSlots = await Session.find({ status: 'active' }).distinct('slot_number');
    let slotNumber = 1;
    
    while (usedSlots.includes(slotNumber) && slotNumber <= system.total_slots) {
      slotNumber++;
    }
    
    if (slotNumber > system.total_slots) {
      throw new Error('Tutti gli slot sono occupati.');
    }
    
    // Calcola il tempo di fine
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + config.MAX_CHARGE_TIME * 60000);
    
    // Crea una nuova sessione
    const session = new Session({
      telegram_id: userId,
      username,
      start_time: startTime,
      end_time: endTime,
      slot_number: slotNumber,
      status: 'active'
    });
    
    await session.save();
    
    // Aggiorna lo stato del sistema
    system.slots_available -= 1;
    system.active_sessions.push(session._id);
    await system.save();
    
    logger.info(`New charging session started for user ${username} (${userId}) in slot ${slotNumber}`);
    
    return session;
  } catch (error) {
    logger.error(`Error starting session for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Termina una sessione di ricarica
 * @param {Number} userId - ID Telegram dell'utente
 * @param {String} status - Stato finale della sessione ('completed', 'timeout', 'admin_terminated')
 * @returns {Promise<Object>} - Oggetto sessione aggiornata
 */
async function endSession(userId, status = 'completed') {
  try {
    // Trova la sessione attiva dell'utente
    const session = await Session.findOne({
      telegram_id: userId,
      status: 'active'
    });
    
    if (!session) {
      throw new Error('Non hai nessuna sessione di ricarica attiva.');
    }
    
    // Calcola la durata della sessione in minuti
    const startTime = new Date(session.start_time);
    const endTime = new Date();
    const durationMinutes = Math.round((endTime - startTime) / 60000);
    
    // Aggiorna la sessione
    session.status = status;
    session.end_time = endTime;
    await session.save();
    
    // Aggiorna lo stato del sistema
    const system = await System.findOne({ name: 'system' });
    
    if (system) {
      system.slots_available += 1;
      system.active_sessions = system.active_sessions.filter(id => !id.equals(session._id));
      system.total_charges_completed += 1;
      await system.save();
      
      // Aggiorna le statistiche dell'utente
      await userHandler.updateUserStats(userId, durationMinutes);
      
      // Notifica il prossimo utente in coda
      await queueHandler.notifyNextInQueue();
    }
    
    logger.info(`Charging session ended for user ${session.username} (${userId}) - Duration: ${durationMinutes} minutes, Status: ${status}`);
    
    return {
      session,
      durationMinutes
    };
  } catch (error) {
    logger.error(`Error ending session for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Ottiene tutte le sessioni attive
 * @returns {Promise<Array>} - Array di sessioni attive
 */
async function getActiveSessions() {
  try {
    return await Session.find({ status: 'active' }).sort({ start_time: 1 });
  } catch (error) {
    logger.error('Error getting active sessions:', error);
    throw error;
  }
}

/**
 * Ottiene la sessione attiva di un utente
 * @param {Number} userId - ID Telegram dell'utente
 * @returns {Promise<Object|null>} - Oggetto sessione o null se non trovata
 */
async function getUserActiveSession(userId) {
  try {
    return await Session.findOne({
      telegram_id: userId,
      status: 'active'
    });
  } catch (error) {
    logger.error(`Error getting active session for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Ottiene le sessioni in scadenza (per inviare promemoria)
 * @returns {Promise<Array>} - Array di sessioni in scadenza
 */
async function getExpiringSessions() {
  try {
    const now = new Date();
    const reminderThreshold = new Date(now.getTime() + config.REMINDER_TIME * 60000);
    
    return await Session.find({
      status: 'active',
      reminded: false,
      end_time: { 
        $gt: now, 
        $lte: reminderThreshold 
      }
    });
  } catch (error) {
    logger.error('Error getting expiring sessions:', error);
    throw error;
  }
}

/**
 * Ottiene le sessioni scadute (per notificare il termine)
 * @returns {Promise<Array>} - Array di sessioni scadute
 */
async function getExpiredSessions() {
  try {
    const now = new Date();
    
    return await Session.find({
      status: 'active',
      timeout_notified: false,
      end_time: { $lte: now }
    });
  } catch (error) {
    logger.error('Error getting expired sessions:', error);
    throw error;
  }
}

/**
 * Marca una sessione come notificata per il promemoria
 * @param {String} sessionId - ID della sessione
 * @returns {Promise<Object>} - Oggetto sessione aggiornata
 */
async function markSessionReminded(sessionId) {
  try {
    const session = await Session.findById(sessionId);
    
    if (session) {
      session.reminded = true;
      await session.save();
    }
    
    return session;
  } catch (error) {
    logger.error(`Error marking session ${sessionId} as reminded:`, error);
    throw error;
  }
}

/**
 * Marca una sessione come notificata per il timeout
 * @param {String} sessionId - ID della sessione
 * @returns {Promise<Object>} - Oggetto sessione aggiornata
 */
async function markSessionTimeoutNotified(sessionId) {
  try {
    const session = await Session.findById(sessionId);
    
    if (session) {
      session.timeout_notified = true;
      await session.save();
    }
    
    return session;
  } catch (error) {
    logger.error(`Error marking session ${sessionId} as timeout notified:`, error);
    throw error;
  }
}

/**
 * Termina una sessione forzatamente (comando admin)
 * @param {String} username - Username Telegram dell'utente
 * @returns {Promise<Object|null>} - Oggetto sessione terminata o null se non trovata
 */
async function adminTerminateSession(username) {
  try {
    // Trova l'utente tramite username
    const user = await User.findOne({ username: username.replace('@', '') });
    
    if (!user) {
      throw new Error(`Utente @${username} non trovato.`);
    }
    
    // Termina la sessione attiva dell'utente
    const session = await Session.findOne({
      telegram_id: user.telegram_id,
      status: 'active'
    });
    
    if (!session) {
      throw new Error(`Utente @${username} non ha sessioni attive.`);
    }
    
    return await endSession(user.telegram_id, 'admin_terminated');
  } catch (error) {
    logger.error(`Error admin terminating session for ${username}:`, error);
    throw error;
  }
}

module.exports = {
  startSession,
  endSession,
  getActiveSessions,
  getUserActiveSession,
  getExpiringSessions,
  getExpiredSessions,
  markSessionReminded,
  markSessionTimeoutNotified,
  adminTerminateSession
};
