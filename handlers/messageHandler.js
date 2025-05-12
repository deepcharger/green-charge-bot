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
  // Verifica connessione a Telegram
  try {
    logger.info('Testing Telegram connection...');
    bot.getMe().then(info => {
      logger.info(`Connected to Telegram as @${info.username}`);
    }).catch(err => {
      logger.error('Failed to connect to Telegram:', err);
    });
  } catch (error) {
    logger.error('Error during Telegram connection test:', error);
  }

  // Comando start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;

    logger.info(`Received /start command from user ${userId} (${username})`);

    try {
      await userHandler.registerUser(userId, username);
      
      bot.sendMessage(chatId, 
        `Benvenuto @${username} (ID: ${userId}) al sistema di gestione delle colonnine di ricarica.\n` +
        `Usa /prenota per metterti in coda, /status per vedere lo stato attuale.`);
        
      logger.info(`Sent welcome message to user ${userId}`);
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
    
    logger.info(`Received /prenota command from user ${userId} (${username})`);
    
    try {
      const result = await queueHandler.requestCharge(userId, username);
      
      if (result.slotAvailable) {
        logger.info(`Slot available for user ${userId}, sending instructions`);
        bot.sendMessage(chatId, 
          `@${username} (ID: ${userId}), c'è uno slot libero! Puoi procedere con la ricarica.\n` +
          `Per favore, usa l'app Antonio Green-Charge per attivare la colonnina.\n` +
          `Ricorda che hai a disposizione massimo ${config.MAX_CHARGE_TIME} minuti.\n` +
          `Conferma l'inizio della ricarica con /iniziato quando attivi la colonnina.`);
      } else {
        logger.info(`No slots available, user ${userId} added to queue at position ${result.position}`);
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
    
    logger.info(`Received /iniziato command from user ${userId} (${username})`);
    
    try {
      const session = await sessionHandler.startSession(userId, username);
      
      logger.info(`Session started for user ${userId}, slot ${session.slot_number}`);
      
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
    
    logger.info(`Received /terminato command from user ${userId} (${username})`);
    
    try {
      const result = await sessionHandler.endSession(userId);
      
      logger.info(`Session ended for user ${userId}, duration: ${result.durationMinutes} minutes`);
      
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
    const userId = msg.from.id;
    
    logger.info(`Received /status command from user ${userId}`);
    
    try {
      const status = await queueHandler.getSystemStatus();
      logger.info(`Retrieved system status, formatting message`);
      
      const message = formatters.formatStatusMessage(status);
      
      bot.sendMessage(chatId, message);
      logger.info(`Sent status message to user ${userId}`);
    } catch (error) {
      logger.error(`Error in /status command from user ${userId}:`, error);
      logger.error(error.stack);
      bot.sendMessage(chatId, `Si è verificato un errore durante il recupero dello stato.`);
    }
  });

  // Comando help
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    logger.info(`Received /help command from user ${userId}`);
    
    const message = formatters.formatHelpMessage();
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    logger.info(`Sent help message to user ${userId}`);
  });

  // Comando admin (solo per ADMIN_USER_ID)
  bot.onText(/\/admin_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    logger.info(`Received /admin_${match[1]} command from user ${userId}`);
    
    // Verifica che l'utente sia admin
    if (userId !== config.ADMIN_USER_ID) {
      logger.warn(`User ${userId} tried to use admin command but is not admin`);
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
      logger.error(`Error in admin command ${command} from user ${userId}:`, error);
      bot.sendMessage(chatId, `Si è verificato un errore durante l'esecuzione del comando admin: ${error.message}`);
    }
  });

  // Comando di debug dbtest
  bot.onText(/\/dbtest/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Verifica che l'utente sia admin
    if (userId !== config.ADMIN_USER_ID) {
      logger.warn(`User ${userId} tried to use dbtest command but is not admin`);
      bot.sendMessage(chatId, 'Comando riservato agli amministratori.');
      return;
    }
    
    logger.info(`Received /dbtest command from admin ${userId}`);
    
    try {
      const User = require('../models/user');
      const Session = require('../models/session');
      const Queue = require('../models/queue');
      const System = require('../models/system');
      
      const systemCount = await System.countDocuments();
      const sessionCount = await Session.countDocuments();
      const queueCount = await Queue.countDocuments();
      const userCount = await User.countDocuments();
      
      logger.info(`Database test results: System=${systemCount}, Session=${sessionCount}, Queue=${queueCount}, User=${userCount}`);
      
      bot.sendMessage(chatId, 
        `Database status:\n` +
        `- System documents: ${systemCount}\n` +
        `- Session documents: ${sessionCount}\n` +
        `- Queue documents: ${queueCount}\n` +
        `- User documents: ${userCount}`);
    } catch (error) {
      logger.error(`Error in /dbtest command:`, error);
      bot.sendMessage(chatId, `Errore durante il test del database: ${error.message}`);
    }
  });

  // Gestisce errori generali
  bot.on('polling_error', (error) => {
    logger.error('Telegram polling error:', error);
  });
  
  logger.info('Message handlers initialized');
}

module.exports = { init };
