const Session = require('../models/session');
const sessionHandler = require('../handlers/sessionHandler');
const queueHandler = require('./queueHandler');
const config = require('../config');
const logger = require('./logger');
const formatters = require('./formatters');

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
  
  // Timer per verificare le sessioni in scadenza (promemoria)
  const reminderTimer = setInterval(async () => {
    try {
      await checkExpiringSessions(bot);
    } catch (error) {
      logger.error('Errore durante il controllo delle sessioni in scadenza:', error);
    }
  }, 60000); // Controlla ogni minuto
  
  // Timer per verificare le sessioni scadute
  const timeoutTimer = setInterval(async () => {
    try {
      await checkExpiredSessions(bot);
    } catch (error) {
      logger.error('Errore durante il controllo delle sessioni scadute:', error);
    }
  }, 60000); // Controlla ogni minuto
  
  // Timer per inviare promemoria periodici per le sessioni che hanno superato il limite
  const overdueTimer = setInterval(async () => {
    try {
      await checkOverdueSessions(bot);
    } catch (error) {
      logger.error('Errore durante il controllo delle sessioni in ritardo:', error);
    }
  }, 300000); // Controlla ogni 5 minuti
  
  logger.info('Sistema di notifiche avviato');
  
  return {
    reminderTimer,
    timeoutTimer,
    overdueTimer
  };
}

/**
 * Controlla e notifica le sessioni in scadenza
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Promise<void>}
 */
async function checkExpiringSessions(bot) {
  try {
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
      
      // Invia la notifica
      bot.sendMessage(
        session.telegram_id,
        reminderMessage,
        { parse_mode: 'Markdown' }
      );
      
      // Marca la sessione come notificata
      await sessionHandler.markSessionReminded(session._id);
      
      logger.info(`Sent reminder to user ${session.username} (${session.telegram_id})`);
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
    const expiredSessions = await sessionHandler.getExpiredSessions();
    
    for (const session of expiredSessions) {
      // Invia la notifica con il formato migliorato
      const timeoutMessage = formatters.formatTimeoutMessage(
        session.username, 
        config.MAX_CHARGE_TIME
      );
      
      // Invia la notifica
      bot.sendMessage(
        session.telegram_id,
        timeoutMessage,
        { parse_mode: 'Markdown' }
      );
      
      // Marca la sessione come notificata
      await sessionHandler.markSessionTimeoutNotified(session._id);
      
      logger.info(`Sent timeout notification to user ${session.username} (${session.telegram_id})`);
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
        bot.sendMessage(
          session.telegram_id,
          `⚠️ *PROMEMORIA IMPORTANTE*\n\n` +
          `@${session.username}, il tuo tempo è scaduto da *${overdueMinutes} minuti*.\n\n` +
          `🔸 Per favore, libera immediatamente lo slot.\n` +
          `🔸 Conferma con /terminato quando hai staccato il veicolo.\n\n` +
          `Gli altri utenti stanno aspettando di poter utilizzare la colonnina. Grazie per la collaborazione!`,
          { parse_mode: 'Markdown' }
        );
        
        logger.info(`Sent overdue reminder to user ${session.username} (${session.telegram_id}) - ${overdueMinutes} minutes overdue`);
      }
    }
  } catch (error) {
    logger.error('Error checking overdue sessions:', error);
    throw error;
  }
}

module.exports = {
  startNotificationSystem,
  checkExpiringSessions,
  checkExpiredSessions,
  checkOverdueSessions
};
