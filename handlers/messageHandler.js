const userHandler = require('./userHandler');
const queueHandler = require('./queueHandler');
const sessionHandler = require('./sessionHandler');
const adminHandler = require('./adminHandler');
const config = require('../config');
const logger = require('../utils/logger');
const formatters = require('../utils/formatters');

/**
 * Inizializza la gestione dei messaggi e comandi
 * @param {Object} bot - Istanza del bot Telegram
 */
function init(bot) {
  // Comando start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;

    try {
      await userHandler.registerUser(userId, username);
      
      bot.sendMessage(chatId, 
        `Benvenuto @${username} (ID: ${userId}) al sistema di gestione delle colonnine di ricarica.\n` +
        `Usa /prenota per metterti in coda, /status per vedere lo stato attuale.`);
    } catch (error) {
      logger.error(`Error in /start command for user ${userId}:`, error);
      bot.sendMessage(chatId, 'Si è verificato un errore durante l\'avvio. Riprova più tardi.');
    }
  });

  // Comando prenota
  bot.onText(/\/prenota/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    try {
      const result = await queueHandler.requestCharge(userId, username);
      
      if (result.slotAvailable) {
        bot.sendMessage(chatId, 
          `@${username} (ID: ${userId}), c'è uno slot libero! Puoi procedere con la ricarica.\n` +
          `Per favore, usa l'app Antonio Green-Charge per attivare la colonnina.\n` +
          `Ricorda che hai a disposizione massimo ${config.MAX_CHARGE_TIME} minuti.\n` +
          `Conferma l'inizio della ricarica con /iniziato quando attivi la colonnina.`);
      } else {
        bot.sendMessage(chatId, 
          `@${username} (ID: ${userId}), al momento tutti gli slot sono occupati.\n` +
          `Ti ho aggiunto alla coda in posizione #${result.position}.\n` +
          `Riceverai una notifica quando sarà il tuo turno.`);
      }
    } catch (error) {
      logger.error(`Error in /prenota command for user ${userId}:`, error);
      bot.sendMessage(chatId, `Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando iniziato
  bot.onText(/\/iniziato/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    try {
      const session = await sessionHandler.startSession(userId, username);
      
      const message = formatters.formatSessionStartMessage(session);
      bot.sendMessage(chatId, message);
      
      // Aggiorna lo stato del sistema nel messaggio di stato per tutti
      const systemStatus = await queueHandler.getSystemStatus();
      bot.sendMessage(chatId, 
        `Attualmente occupati ${systemStatus.slots_occupied}/${systemStatus.total_slots} slot.`);
    } catch (error) {
      logger.error(`Error in /iniziato command for user ${userId}:`, error);
      bot.sendMessage(chatId, `Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando terminato
  bot.onText(/\/terminato/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    try {
      const result = await sessionHandler.endSession(userId);
      
      const message = formatters.formatSessionEndMessage(result);
      bot.sendMessage(chatId, message);
      
      // Aggiorna lo stato del sistema nel messaggio di stato per tutti
      const systemStatus = await queueHandler.getSystemStatus();
      bot.sendMessage(chatId, 
        `Attualmente occupati ${systemStatus.slots_occupied}/${systemStatus.total_slots} slot.`);
      
      // Notifica il prossimo utente in coda
      await queueHandler.notifyNextInQueue(bot);
    } catch (error) {
      logger.error(`Error in /terminato command for user ${userId}:`, error);
      bot.sendMessage(chatId, `Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando status
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
      const status = await queueHandler.getSystemStatus();
      const message = formatters.formatStatusMessage(status);
      
      bot.sendMessage(chatId, message);
    } catch (error) {
      logger.error(`Error in /status command:`, error);
      bot.sendMessage(chatId, `Si è verificato un errore durante il recupero dello stato.`);
    }
  });

  // Comando help
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const message = formatters.formatHelpMessage();
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  });

  // Comando admin (solo per ADMIN_USER_ID)
  bot.onText(/\/admin_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Verifica che l'utente sia admin
    if (userId !== config.ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Comando riservato agli amministratori.');
      return;
    }
    
    const command = match[1];
    
    try {
      if (command === 'confirm_reset') {
        await adminHandler.handleConfirmReset(bot, chatId);
      } else {
        await adminHandler.handleAdminCommand(bot, chatId, userId, command, msg.text);
      }
    } catch (error) {
      logger.error(`Error in admin command ${command}:`, error);
      bot.sendMessage(chatId, `Si è verificato un errore durante l'esecuzione del comando admin: ${error.message}`);
    }
  });

  // Gestisce errori generali
  bot.on('polling_error', (error) => {
    logger.error('Polling error:', error);
  });
  
  logger.info('Message handlers initialized');
}

module.exports = { init };
