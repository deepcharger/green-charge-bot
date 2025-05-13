const Session = require('../models/session');
const System = require('../models/system');
const Queue = require('../models/queue');
const User = require('../models/user');
const config = require('../config');
const moment = require('moment');
const logger = require('../utils/logger');
const mongoose = require('mongoose');
const queueHandler = require('../handlers/queueHandler');

// Riferimenti ai timer attivi
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
    
    const now = new Date();
    const reminderThreshold = new Date(now.getTime() + config.REMINDER_TIME * 60000);
    
    // Trova sessioni che stanno per scadere e non hanno ancora ricevuto un promemoria
    const expiringSessions = await Session.find({
      status: 'active',
      reminded: false,
      end_time: { 
        $gt: now, 
        $lte: reminderThreshold 
      }
    });
    
    if (expiringSessions.length > 0) {
      logger.info(`Trovate ${expiringSessions.length} sessioni in scadenza da notificare`);
    }
    
    for (const session of expiringSessions) {
      try {
        // Calcola i minuti rimanenti
        const remainingMinutes = Math.max(
          0,
          Math.round((new Date(session.end_time) - now) / 60000)
        );
        
        // Genera il messaggio di promemoria
        const reminderMessage = formatReminderMessage(
          session.username, 
          remainingMinutes, 
          session.end_time
        );
        
        // Invia la notifica
        await bot.sendMessage(
          session.telegram_id,
          reminderMessage,
          { parse_mode: 'Markdown' }
        );
        
        // Marca la sessione come notificata
        session.reminded = true;
        await session.save();
        
        logger.info(`Inviato promemoria a ${session.username} (${session.telegram_id}) - ${remainingMinutes} minuti rimanenti`);
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
    
    const now = new Date();
    
    // Trova sessioni scadute che non hanno ancora ricevuto una notifica di timeout
    const expiredSessions = await Session.find({
      status: 'active',
      timeout_notified: false,
      end_time: { $lte: now }
    });
    
    if (expiredSessions.length > 0) {
      logger.info(`Trovate ${expiredSessions.length} sessioni scadute da notificare`);
    }
    
    for (const session of expiredSessions) {
      try {
        // Genera il messaggio di timeout
        const timeoutMessage = formatTimeoutMessage(
          session.username, 
          config.MAX_CHARGE_TIME
        );
        
        // Invia la notifica
        await bot.sendMessage(
          session.telegram_id,
          timeoutMessage,
          { parse_mode: 'Markdown' }
        );
        
        // Marca la sessione come notificata per il timeout
        session.timeout_notified = true;
        await session.save();
        
        logger.info(`Inviata notifica di timeout a ${session.username} (${session.telegram_id})`);
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
    
    // Trova sessioni che sono scadute, hanno già ricevuto una notifica di timeout,
    // ma sono ancora attive (l'utente non ha confermato la fine)
    const overdueSessionsResult = await Session.find({
      status: 'active',
      timeout_notified: true,
      end_time: { $lt: now }
    });
    
    // Filtra per includere solo quelle con un ritardo significativo (più di 5 minuti)
    const overdueThreshold = new Date(now.getTime() - 5 * 60000); // 5 minuti fa
    const overdueSessions = overdueSessionsResult.filter(session => 
      new Date(session.end_time) < overdueThreshold
    );
    
    if (overdueSessions.length > 0) {
      logger.info(`Trovate ${overdueSessions.length} sessioni in ritardo da notificare`);
    }
    
    for (const session of overdueSessions) {
      try {
        // Calcola i minuti di ritardo
        const overdueMinutes = Math.round((now - new Date(session.end_time)) / 60000);
        
        // Invia solo se il ritardo è significativo (dovrebbe essere già garantito dal filtro)
        if (overdueMinutes >= 5) {
          await bot.sendMessage(
            session.telegram_id,
            `⚠️ *PROMEMORIA IMPORTANTE*\n\n` +
            `@${session.username}, il tuo tempo è scaduto da *${overdueMinutes} minuti*.\n\n` +
            `🔸 Per favore, libera immediatamente lo slot.\n` +
            `🔸 Conferma con /terminato quando hai staccato il veicolo.\n\n` +
            `Gli altri utenti stanno aspettando di poter utilizzare la colonnina. Grazie per la collaborazione!`,
            { parse_mode: 'Markdown' }
          );
          
          logger.info(`Inviato promemoria di ritardo a ${session.username} (${session.telegram_id}) - ${overdueMinutes} minuti di ritardo`);
        }
      } catch (err) {
        logger.error(`Errore nell'invio del promemoria di ritardo a ${session.username}:`, err);
      }
    }
  } catch (error) {
    logger.error('Error checking overdue sessions:', error);
    throw error;
  }
}

/**
 * Formatta un messaggio di promemoria per la fine della ricarica
 * @param {String} username - Username dell'utente
 * @param {Number} remainingMinutes - Minuti rimanenti
 * @param {Date} endTime - Orario di fine ricarica
 * @returns {String} - Messaggio formattato
 */
function formatReminderMessage(username, remainingMinutes, endTime) {
  const endTimeStr = formatTime(endTime);
  
  return `
⏰ *Promemoria ricarica, @${username}*

Ti restano solo *${remainingMinutes} minuti* prima del termine.

*Informazioni:*
- La ricarica terminerà alle *${endTimeStr}*
- Prepara il veicolo per essere scollegato
- Al termine, conferma con */terminato*

Grazie per la collaborazione! Altri utenti potrebbero essere in attesa. 👍
`;
}

/**
 * Formatta un messaggio di timeout per la fine della ricarica
 * @param {String} username - Username dell'utente
 * @param {Number} maxChargeTime - Tempo massimo di ricarica
 * @returns {String} - Messaggio formattato
 */
function formatTimeoutMessage(username, maxChargeTime) {
  return `
⚠️ *TEMPO SCADUTO, @${username}*

Il tuo tempo di ricarica di *${maxChargeTime} minuti* è terminato.

*Cosa fare immediatamente:*
1. Concludi la ricarica sull'app
2. Scollega il veicolo dalla colonnina
3. Conferma con */terminato* per liberare lo slot

⚡ Altri utenti sono in attesa per utilizzare la colonnina.
Grazie per la tua collaborazione!
`;
}

/**
 * Formatta un timestamp in formato HH:MM
 * @param {Date|String} timestamp - Timestamp da formattare
 * @returns {String} - Timestamp formattato
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

module.exports = {
  startNotificationSystem,
  stopNotificationSystem,
  checkExpiringSessions,
  checkExpiredSessions,
  checkOverdueSessions
};
