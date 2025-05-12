const userHandler = require('./userHandler');
const queueHandler = require('./queueHandler');
const sessionHandler = require('./sessionHandler');
const adminHandler = require('./adminHandler');
const config = require('../config');
const logger = require('../utils/logger');

function init(bot) {
  // Comando start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;

    await userHandler.registerUser(userId, username);
    
    bot.sendMessage(chatId, 
      `Benvenuto @${username} (ID: ${userId}) al sistema di gestione delle colonnine di ricarica.\n` +
      `Usa /prenota per metterti in coda, /status per vedere lo stato attuale.`);
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
      logger.error('Error handling /prenota command:', error);
      bot.sendMessage(chatId, 'Si è verificato un errore. Riprova più tardi.');
    }
  });

  // Implementa gli altri handler per i comandi: /iniziato, /terminato, /status, ecc.
  // ...

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
      await adminHandler.handleAdminCommand(bot, chatId, userId, command, msg.text);
    } catch (error) {
      logger.error('Error handling admin command:', error);
      bot.sendMessage(chatId, 'Si è verificato un errore durante l\'esecuzione del comando admin.');
    }
  });

  // Gestisce errori generali
  bot.on('polling_error', (error) => {
    logger.error('Polling error:', error);
  });
}

module.exports = { init };
