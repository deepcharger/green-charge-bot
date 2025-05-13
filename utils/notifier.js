const Session = require('../models/session');
const sessionHandler = require('../handlers/sessionHandler');
const queueHandler = require('../handlers/queueHandler');
const config = require('../config');
const logger = require('./logger');
const formatters = require('./formatters');
const mongoose = require('mongoose');

// Timer per le notifiche
let reminderTimer = null;
let timeoutTimer = null;
let overdueTimer = null;
let queueTimeoutTimer = null;

/**
 * Avvia il sistema di notifiche periodiche
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Object} - Riferimenti ai timer avviati
 */
function startNotificationSystem(bot) {
  if (!bot) {
    logger.error('Impossibile avviare il sistema di notifiche: bot non fornito');
    return null;
  }
  
  // Ferma eventuali timer esistenti
  stopNotificationSystem();
  
  // Timer per verificare le sessioni in scadenza (promemoria)
  reminderTimer = setInterval(async () => {
    try {
      // Verifica che la connessione MongoDB sia attiva
      if (mongoose.connection.readyState !== 1) {
        logger.warn('Sistema di notifiche: MongoDB non connesso, skip controllo sessioni in scadenza');
        return;
      }
      
      await checkExpiringSessions(bot);
    } catch (error) {
      logger.error('Errore durante il controllo delle sessioni in scadenza:', error);
    }
  }, 60000); // Controlla ogni minuto
  
  // Timer per verificare le sessioni scadute
  timeoutTimer = setInterval(async () => {
    try {
      // Verifica che la connessione MongoDB sia attiva
      if (mongoose.connection.readyState !== 1) {
        logger.warn('Sistema di notifiche: MongoDB non connesso, skip controllo sessioni scadute');
        return;
      }
      
      await checkExpiredSessions(bot);
    } catch (error) {
      logger.error('Errore durante il controllo delle sessioni scadute:', error);
    }
  }, 60000); // Controlla ogni minuto
  
  // Timer per inviare promemoria periodici per le sessioni che hanno superato il limite
  overdueTimer = setInterval(async () => {
    try {
      // Verifica che la connessione MongoDB sia attiva
      if (mongoose.connection.readyState !== 1) {
        logger.warn('Sistema di notifiche: MongoDB non connesso, skip controllo sessioni in ritardo');
        return;
      }
      
      await checkOverdueSessions(bot);
    } catch (error) {
      logger.error('Errore durante il controllo delle sessioni in ritardo:', error);
    }
  }, 300000); // Controlla ogni 5 minuti
  
  // Timer per verificare gli utenti in coda che non hanno iniziato la ricarica
  queueTimeoutTimer = setInterval(async () => {
    try {
      // Verifica che la connessione MongoDB sia attiva
      if (mongoose.connection.readyState !== 1) {
        logger.warn('Sistema di notifiche: MongoDB non connesso, skip controllo timeout della coda');
        return;
      }
      
      await queueHandler.checkQueueTimeouts(bot);
    } catch (error) {
      logger.error('Errore durante il controllo dei timeout della coda:', error);
    }
  }, 60000); // Controlla ogni minuto
  
  logger.info('Sistema di notifiche avviato');
  
  return {
    reminderTimer,
    timeoutTimer,
    overdueTimer,
    queueTimeoutTimer,
    stop: stopNotificationSystem
  };
}

/**
 * Ferma il sistema di notifiche
 */
function stopNotificationSystem() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
  
  if (timeoutTimer) {
    clearInterval(timeoutTimer);
    timeoutTimer = null;
  }
  
  if (overdueTimer) {
    clearInterval(overdueTimer);
    overdueTimer = null;
  }
  
  if (queueTimeoutTimer) {
    clearInterval(queueTimeoutTimer);
    queueTimeoutTimer = null;
  }
  
  logger.info('Sistema di notifiche fermato');
  return true;
}

/**
 * Controlla e notifica le sessioni in scadenza
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Promise<void>}
 */
async function checkExpiringSessions(bot) {
  try {
    if (!bot || !bot.sendMessage) {
      logger.warn('Bot non disponibile per inviare notifiche di scadenza');
      return;
    }
    
    // Verifica che la connessione MongoDB sia attiva
    if (mongoose.connection.readyState !== 1) {
      logger.warn('MongoDB non connesso, impossibile controllare sessioni in scadenza');
      return;
    }
    
    const expiringSessions = await sessionHandler.getExpiringSessions();
    
    for (const session of expiringSessions) {
      // Calcola i minuti rimanenti
      const remainingMinutes = Math.max(
        0,
        Math.round((new Date(session.end_time) - new Date()) / 60000)
      );
      
      // Invia la notifica con il formato migliorato
      const reminderMessage = formatters.formatReminderMessage(
        session.username, 
        remainingMinutes, 
        session.end_time
      );
      
      try {
        // Invia la notifica
        await bot.sendMessage(
          session.telegram_id,
          reminderMessage,
          { parse_mode: 'Markdown' }
        );
        
        // Marca la sessione come notificata
        await sessionHandler.markSessionReminded(session._id);
        
        logger.info(`Sent reminder to user ${session.username} (${session.telegram_id})`);
      } catch (err) {
        logger.error(`Errore nell'invio del promemoria a ${session.username}:`, err);
      }
    }
  } catch (error) {
    logger.error('Error checking expiring sessions:', error);
    throw error;
  }
}

/**
 * Controlla e notifica le sessioni scadute
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Promise<void>}
 */
async function checkExpiredSessions(bot) {
  try {
    if (!bot || !bot.sendMessage) {
      logger.warn('Bot non disponibile per inviare notifiche di timeout');
      return;
    }
    
    // Verifica che la connessione MongoDB sia attiva
    if (mongoose.connection.readyState !== 1) {
      logger.warn('MongoDB non connesso, impossibile controllare sessioni scadute');
      return;
    }
    
    const expiredSessions = await sessionHandler.getExpiredSessions();
    
    for (const session of expiredSessions) {
      // Invia la notifica con il formato migliorato
      const timeoutMessage = formatters.formatTimeoutMessage(
        session.username, 
        config.MAX_CHARGE_TIME
      );
      
      try {
        // Invia la notifica
        await bot.sendMessage(
          session.telegram_id,
          timeoutMessage,
          { parse_mode: 'Markdown' }
        );
        
        // Marca la sessione come notificata
        await sessionHandler.markSessionTimeoutNotified(session._id);
        
        logger.info(`Sent timeout notification to user ${session.username} (${session.telegram_id})`);
      } catch (err) {
        logger.error(`Errore nell'invio della notifica di timeout a ${session.username}:`, err);
      }
    }
  } catch (error) {
    logger.error('Error checking expired sessions:', error);
    throw error;
  }
}

/**
 * Controlla e invia promemoria per le sessioni in ritardo (oltre il limite)
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Promise<void>}
 */
async function checkOverdueSessions(bot) {
  try {
    if (!bot || !bot.sendMessage) {
      logger.warn('Bot non disponibile per inviare notifiche di ritardo');
      return;
    }
    
    // Verifica che la connessione MongoDB sia attiva
    if (mongoose.connection.readyState !== 1) {
      logger.warn('MongoDB non connesso, impossibile controllare sessioni in ritardo');
      return;
    }
    
    const now = new Date();
    const expiredSessions = await Session.find({
      status: 'active',
      timeout_notified: true,
      end_time: { $lt: now }
    });
    
    for (const session of expiredSessions) {
      // Calcola i minuti di ritardo
      const overdueMinutes = Math.round((now - new Date(session.end_time)) / 60000);
      
      // Invia solo se il ritardo è significativo (più di 5 minuti)
      if (overdueMinutes >= 5) {
        try {
          await bot.sendMessage(
            session.telegram_id,
            `⚠️ *PROMEMORIA IMPORTANTE*\n\n` +
            `@${session.username}, il tuo tempo è scaduto da *${overdueMinutes} minuti*.\n\n` +
            `🔸 Per favore, libera immediatamente lo slot.\n` +
            `🔸 Conferma con /terminato quando hai staccato il veicolo.\n\n` +
            `Gli altri utenti stanno aspettando di poter utilizzare la colonnina. Grazie per la collaborazione!`,
            { parse_mode: 'Markdown' }
          );
          
          logger.info(`Sent overdue reminder to user ${session.username} (${session.telegram_id}) - ${overdueMinutes} minutes overdue`);
        } catch (err) {
          logger.error(`Errore nell'invio del promemoria di ritardo a ${session.username}:`, err);
        }
      }
    }
  } catch (error) {
    logger.error('Error checking overdue sessions:', error);
    throw error;
  }
}

module.exports = {
  startNotificationSystem,
  stopNotificationSystem,
  checkExpiringSessions,
  checkExpiredSessions,
  checkOverdueSessions
};
