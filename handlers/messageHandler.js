const userHandler = require('./userHandler');
const queueHandler = require('./queueHandler');
const sessionHandler = require('./sessionHandler');
const adminHandler = require('./adminHandler');
const config = require('../config');
const logger = require('../utils/logger');
const formatters = require('../utils/formatters');
const Queue = require('../models/queue');
const Session = require('../models/session');

/**
 * Verifica se l'utente è autorizzato a utilizzare il bot
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @param {Number} userId - ID dell'utente
 * @param {String} username - Username dell'utente
 * @returns {Promise<Boolean>} - true se l'utente è autorizzato, false altrimenti
 */
async function isUserAuthorized(bot, chatId, userId, username) {
  // Se non è attiva la restrizione al gruppo o è un admin, è sempre autorizzato
  if (!config.RESTRICT_TO_GROUP || userId === config.ADMIN_USER_ID) {
    return true;
  }
  
  // Verifica se l'utente è membro del gruppo autorizzato
  try {
    // Ottieni lo stato dell'utente nel gruppo
    const chatMember = await bot.getChatMember(config.AUTHORIZED_GROUP_ID, userId);
    
    // Verifica se lo stato è valido (member, administrator o creator)
    if (['member', 'administrator', 'creator'].includes(chatMember.status)) {
      logger.info(`User ${username} (${userId}) is authorized as ${chatMember.status} in group ${config.AUTHORIZED_GROUP_ID}`);
      return true;
    } else {
      logger.warn(`User ${username} (${userId}) is not authorized. Status: ${chatMember.status}`);
      return false;
    }
  } catch (error) {
    // Se c'è un errore nella verifica, probabilmente l'utente non è nel gruppo
    logger.error(`Error checking authorization for user ${username} (${userId}):`, error);
    return false;
  }
}

/**
 * Invia un messaggio di accesso negato
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @param {String} username - Username dell'utente
 */
function sendUnauthorizedMessage(bot, chatId, username) {
  bot.sendMessage(chatId, 
    `⚠️ *Accesso non autorizzato*\n\n` +
    `Mi dispiace @${username}, ma per utilizzare questo bot devi essere un membro del gruppo autorizzato.\n\n` +
    `Contatta l'amministratore per maggiori informazioni.`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Inizializza la gestione dei messaggi e comandi
 * @param {Object} bot - Istanza del bot Telegram
 */
function init(bot) {
  // Verifica connessione a Telegram
  try {
    logger.info('Testing Telegram connection...');
    bot.getMe().then(async info => {
      logger.info(`Connected to Telegram as @${info.username}`);
      
      // Imposta i comandi del bot e attendi il completamento
      try {
        await setupBotCommands(bot);
      } catch (err) {
        logger.error('Error setting up bot commands:', err);
      }
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
      // Verifica se l'utente è autorizzato
      const isAuthorized = await isUserAuthorized(bot, chatId, userId, username);
      if (!isAuthorized) {
        sendUnauthorizedMessage(bot, chatId, username);
        return;
      }
      
      await userHandler.registerUser(userId, username);
      
      const welcomeMessage = formatters.formatWelcomeMessage(username, userId);
      bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
        
      logger.info(`Sent welcome message to user ${userId}`);
    } catch (error) {
      logger.error(`Error in /start command for user ${userId}:`, error);
      bot.sendMessage(chatId, '❌ Si è verificato un errore durante l\'avvio. Riprova più tardi.');
    }
  });

  // Comando prenota
  bot.onText(/\/prenota/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    logger.info(`Received /prenota command from user ${userId} (${username})`);
    
    try {
      // Verifica se l'utente è autorizzato
      const isAuthorized = await isUserAuthorized(bot, chatId, userId, username);
      if (!isAuthorized) {
        sendUnauthorizedMessage(bot, chatId, username);
        return;
      }
      
      const result = await queueHandler.requestCharge(userId, username);
      
      if (result.slotAvailable) {
        logger.info(`Slot available for user ${userId}, sending instructions`);
        const availableMessage = formatters.formatSlotAvailableMessage(username, userId, config.MAX_CHARGE_TIME);
        bot.sendMessage(chatId, availableMessage, { parse_mode: 'Markdown' });
      } else {
        logger.info(`No slots available, user ${userId} added to queue at position ${result.position}`);
        const queueMessage = formatters.formatQueueMessage(username, userId, result.position);
        bot.sendMessage(chatId, queueMessage, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      logger.error(`Error in /prenota command for user ${userId}:`, error);
      bot.sendMessage(chatId, `❌ Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando cancella
  bot.onText(/\/cancella/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    logger.info(`Received /cancella command from user ${userId} (${username})`);
    
    try {
      // Verifica se l'utente è autorizzato
      const isAuthorized = await isUserAuthorized(bot, chatId, userId, username);
      if (!isAuthorized) {
        sendUnauthorizedMessage(bot, chatId, username);
        return;
      }
      
      // Verifica se l'utente è in coda
      const inQueue = await Queue.findOne({ telegram_id: userId });
      
      if (inQueue) {
        // Rimuovilo dalla coda
        const position = inQueue.position;
        await queueHandler.removeFromQueue(userId);
        
        logger.info(`User ${userId} (${username}) removed from queue at position ${position}`);
        
        // Invia conferma all'utente
        bot.sendMessage(chatId, 
          `✅ @${username}, sei stato rimosso dalla coda con successo.\n\n` +
          `Eri in posizione *#${position}*.\n\n` +
          `Se vorrai ricaricare in futuro, usa nuovamente /prenota.`,
          { parse_mode: 'Markdown' });
        
        return;
      }
      
      // Verifica se l'utente ha una sessione attiva
      const session = await Session.findOne({ 
        telegram_id: userId,
        status: 'active'
      });
      
      if (session) {
        bot.sendMessage(chatId, 
          `ℹ️ @${username}, hai una sessione di ricarica attiva.\n\n` +
          `Se vuoi terminare la ricarica, usa il comando /terminato.`,
          { parse_mode: 'Markdown' });
        return;
      }
      
      // Se non è né in coda né in sessione
      bot.sendMessage(chatId, 
        `ℹ️ @${username}, non sei attualmente in coda né hai una sessione attiva.\n\n` +
        `Per prenotare una ricarica, usa il comando /prenota.`,
        { parse_mode: 'Markdown' });
      
    } catch (error) {
      logger.error(`Error in /cancella command for user ${userId}:`, error);
      bot.sendMessage(chatId, `❌ Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando iniziato
  bot.onText(/\/iniziato/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    logger.info(`Received /iniziato command from user ${userId} (${username})`);
    
    try {
      // Verifica se l'utente è autorizzato
      const isAuthorized = await isUserAuthorized(bot, chatId, userId, username);
      if (!isAuthorized) {
        sendUnauthorizedMessage(bot, chatId, username);
        return;
      }
      
      const session = await sessionHandler.startSession(userId, username);
      
      logger.info(`Session started for user ${userId}, slot ${session.slot_number}`);
      
      const message = formatters.formatSessionStartMessage(session);
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      
      // Aggiorna lo stato del sistema nel messaggio di stato per tutti
      const systemStatus = await queueHandler.getSystemStatus();
      bot.sendMessage(chatId, 
        `🔌 Attualmente occupati ${systemStatus.slots_occupied}/${systemStatus.total_slots} slot.`);
    } catch (error) {
      logger.error(`Error in /iniziato command for user ${userId}:`, error);
      bot.sendMessage(chatId, `❌ Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando terminato
  bot.onText(/\/terminato/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    logger.info(`Received /terminato command from user ${userId} (${username})`);
    
    try {
      // Verifica se l'utente è autorizzato
      const isAuthorized = await isUserAuthorized(bot, chatId, userId, username);
      if (!isAuthorized) {
        sendUnauthorizedMessage(bot, chatId, username);
        return;
      }
      
      const result = await sessionHandler.endSession(userId);
      
      logger.info(`Session ended for user ${userId}, duration: ${result.durationMinutes} minutes`);
      
      const message = formatters.formatSessionEndMessage(result);
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      
      // Aggiorna lo stato del sistema nel messaggio di stato per tutti
      const systemStatus = await queueHandler.getSystemStatus();
      bot.sendMessage(chatId, 
        `🔌 Attualmente occupati ${systemStatus.slots_occupied}/${systemStatus.total_slots} slot.`);
      
      // Notifica il prossimo utente in coda
      await queueHandler.notifyNextInQueue(bot);
    } catch (error) {
      logger.error(`Error in /terminato command for user ${userId}:`, error);
      bot.sendMessage(chatId, `❌ Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando status
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    logger.info(`Received /status command from user ${userId}`);
    
    try {
      // Verifica se l'utente è autorizzato
      const isAuthorized = await isUserAuthorized(bot, chatId, userId, username);
      if (!isAuthorized) {
        sendUnauthorizedMessage(bot, chatId, username);
        return;
      }
      
      const status = await queueHandler.getSystemStatus();
      logger.info(`Retrieved system status, formatting message`);
      
      const message = formatters.formatStatusMessage(status);
      
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      logger.info(`Sent status message to user ${userId}`);
    } catch (error) {
      logger.error(`Error in /status command from user ${userId}:`, error);
      logger.error(error.stack);
      bot.sendMessage(chatId, `❌ Si è verificato un errore durante il recupero dello stato.`);
    }
  });

  // Comando help
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || `user${userId}`;
    
    logger.info(`Received /help command from user ${userId}`);
    
    try {
      // Verifica se l'utente è autorizzato
      const isAuthorized = await isUserAuthorized(bot, chatId, userId, username);
      if (!isAuthorized) {
        sendUnauthorizedMessage(bot, chatId, username);
        return;
      }
      
      // Verifica se l'utente è admin per mostrare i comandi admin
      const isAdmin = userId === config.ADMIN_USER_ID;
      const message = formatters.formatHelpMessage(isAdmin);
      
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      logger.info(`Sent help message to user ${userId}`);
    } catch (error) {
      logger.error(`Error in /help command from user ${userId}:`, error);
      bot.sendMessage(chatId, `❌ Si è verificato un errore: ${error.message}`);
    }
  });

  // Comando dove_sono (per ottenere l'ID della chat corrente)
  bot.onText(/\/dove_sono/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const chatType = msg.chat.type;
    const chatTitle = msg.chat.title || "Chat privata";
    
    logger.info(`Received /dove_sono command from user ${userId} in chat ${chatId} (${chatType})`);
    
    let message = `📍 *Informazioni sulla chat attuale*\n\n`;
    
    if (chatType === 'private') {
      message += `Tipo: Chat privata con il bot\n`;
      message += `ID: \`${chatId}\`\n\n`;
      message += `Questo è l'ID della tua chat privata con il bot, non di un gruppo.`;
    } else if (chatType === 'group' || chatType === 'supergroup') {
      message += `Tipo: ${chatType === 'supergroup' ? 'Supergruppo' : 'Gruppo'}\n`;
      message += `Nome: *${chatTitle}*\n`;
      message += `ID: \`${chatId}\`\n\n`;
      message += `🔍 Questo è l'ID di questo gruppo. Per configurare il bot per l'uso esclusivo in questo gruppo, ` +
                 `l'amministratore del bot dovrà impostare questo ID nella configurazione.`;
    } else {
      message += `Tipo: ${chatType}\n`;
      message += `ID: \`${chatId}\`\n`;
    }
    
    // Aggiungi info per gli admin
    if (userId === config.ADMIN_USER_ID) {
      message += `\n\n👑 *Info per l'amministratore:*\n`;
      message += `Per configurare il bot per l'uso esclusivo in questo gruppo, imposta le variabili d'ambiente:\n`;
      message += `\`AUTHORIZED_GROUP_ID=${chatId}\`\n`;
      message += `\`RESTRICT_TO_GROUP=true\``;
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    logger.info(`Sent location info to user ${userId} for chat ${chatId}`);
  });

  // Comando admin (solo per ADMIN_USER_ID)
  bot.onText(/\/admin_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Estrai il comando base e i parametri
    const fullCommand = match[1];
    const commandParts = fullCommand.split(' ');
    const command = commandParts[0]; // Solo la prima parte è il comando effettivo
    
    logger.info(`Received /admin_${command} command from user ${userId}`);
    
    // Verifica che l'utente sia admin
    if (userId !== config.ADMIN_USER_ID) {
      logger.warn(`User ${userId} tried to use admin command but is not admin`);
      bot.sendMessage(chatId, '🚫 Comando riservato agli amministratori.');
      return;
    }
    
    try {
      // Gestisci i comandi admin
      if (command === 'confirm_reset') {
        await adminHandler.handleConfirmReset(bot, chatId);
      } else if (command === 'help') {
        // Comando help admin
        const helpMessage = formatters.formatAdminHelpMessage();
        bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
      } else if (command === 'update_commands') {
        // Comando per aggiornare i comandi del bot
        await setupBotCommands(bot);
        bot.sendMessage(chatId, '✅ Comandi del bot aggiornati con successo!');
      } else if (command === 'set_charge_time') {
        // Comando per impostare il tempo massimo di ricarica
        const params = commandParts.slice(1);
        if (params.length < 1 || isNaN(parseInt(params[0]))) {
          bot.sendMessage(chatId, '❌ Uso: /admin_set_charge_time [minuti]');
          return;
        }
        
        const minutes = parseInt(params[0]);
        if (minutes < 1 || minutes > 120) {
          bot.sendMessage(chatId, '❌ Il tempo di ricarica deve essere tra 1 e 120 minuti.');
          return;
        }
        
        // Aggiorna la configurazione
        config.MAX_CHARGE_TIME = minutes;
        
        // Aggiorna anche l'environment variable se possibile
        if (process.env.MAX_CHARGE_TIME) {
          process.env.MAX_CHARGE_TIME = minutes.toString();
        }
        
        bot.sendMessage(chatId, `✅ Tempo massimo di ricarica impostato a ${minutes} minuti.`);
      } else if (command === 'set_reminder_time') {
        // Comando per impostare il tempo di promemoria
        const params = commandParts.slice(1);
        if (params.length < 1 || isNaN(parseInt(params[0]))) {
          bot.sendMessage(chatId, '❌ Uso: /admin_set_reminder_time [minuti]');
          return;
        }
        
        const minutes = parseInt(params[0]);
        if (minutes < 1 || minutes > 30) {
          bot.sendMessage(chatId, '❌ Il tempo di promemoria deve essere tra 1 e 30 minuti.');
          return;
        }
        
        // Aggiorna la configurazione
        config.REMINDER_TIME = minutes;
        
        // Aggiorna anche l'environment variable se possibile
        if (process.env.REMINDER_TIME) {
          process.env.REMINDER_TIME = minutes.toString();
        }
        
        bot.sendMessage(chatId, `✅ Tempo di promemoria impostato a ${minutes} minuti.`);
      } else if (command === 'set_max_slots') {
        // Gestisci il comando set_max_slots direttamente qui
        const params = commandParts.slice(1);
        if (params.length < 1 || isNaN(parseInt(params[0]))) {
          bot.sendMessage(chatId, '❌ Uso: /admin_set_max_slots [numero]');
          return;
        }
        
        const maxSlots = parseInt(params[0]);
        logger.info(`Admin setting max slots to ${maxSlots}`);
        
        try {
          // Usa direttamente la funzione di queueHandler
          const system = await queueHandler.updateMaxSlots(maxSlots);
          
          // Notifica l'admin
          bot.sendMessage(chatId, 
            `✅ Numero massimo di slot aggiornato a *${maxSlots}*.\n\n` +
            `ℹ️ Stato attuale: *${system.slots_available}* slot disponibili.`,
            { parse_mode: 'Markdown' });
          
          // Se sono stati aggiunti nuovi slot disponibili, notifica gli utenti in coda
          if (system.slots_available > 0) {
            await queueHandler.notifyNextInQueue(bot);
          }
          
          logger.info(`Max slots updated to ${maxSlots}, available: ${system.slots_available}`);
        } catch (error) {
          logger.error(`Error updating max slots to ${maxSlots}:`, error);
          bot.sendMessage(chatId, `❌ Errore durante l'aggiornamento del numero massimo di slot: ${error.message}`);
        }
      } else {
        // Altri comandi admin
        await adminHandler.handleAdminCommand(bot, chatId, userId, command, msg.text);
      }
    } catch (error) {
      logger.error(`Error in admin command ${command} from user ${userId}:`, error);
      bot.sendMessage(chatId, `❌ Si è verificato un errore durante l'esecuzione del comando admin: ${error.message}`);
    }
  });

  // Comando di debug dbtest
  bot.onText(/\/dbtest/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Verifica che l'utente sia admin
    if (userId !== config.ADMIN_USER_ID) {
      logger.warn(`User ${userId} tried to use dbtest command but is not admin`);
      bot.sendMessage(chatId, '🚫 Comando riservato agli amministratori.');
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
        `📊 *Stato Database:*\n` +
        `- System documents: *${systemCount}*\n` +
        `- Session documents: *${sessionCount}*\n` +
        `- Queue documents: *${queueCount}*\n` +
        `- User documents: *${userCount}*`, 
        { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error(`Error in /dbtest command:`, error);
      bot.sendMessage(chatId, `❌ Errore durante il test del database: ${error.message}`);
    }
  });

  logger.info('Message handlers initialized');
}

/**
 * Imposta i comandi del bot su Telegram
 * @param {Object} bot - Istanza del bot Telegram
 * @returns {Promise<void>}
 */
async function setupBotCommands(bot) {
  try {
    // Imposta i comandi utente (visibili a tutti)
    await bot.setMyCommands([
      { command: 'start', description: 'Avvia il bot' },
      { command: 'prenota', description: 'Prenota uno slot o mettiti in coda' },
      { command: 'cancella', description: 'Cancella la tua prenotazione in coda' },
      { command: 'iniziato', description: 'Conferma l\'inizio della ricarica' },
      { command: 'terminato', description: 'Conferma la fine della ricarica' },
      { command: 'status', description: 'Visualizza lo stato attuale del sistema' },
      { command: 'help', description: 'Mostra i comandi disponibili' },
      { command: 'dove_sono', description: 'Mostra ID della chat corrente' }
    ]);
    
    logger.info('User commands updated successfully');
    
    // Imposta i comandi admin (visibili solo all'admin)
    try {
      if (config.ADMIN_USER_ID) {
        await bot.setMyCommands([
          // Comandi utente visibili anche all'admin
          { command: 'start', description: 'Avvia il bot' },
          { command: 'prenota', description: 'Prenota uno slot o mettiti in coda' },
          { command: 'cancella', description: 'Cancella la tua prenotazione in coda' },
          { command: 'iniziato', description: 'Conferma l\'inizio della ricarica' },
          { command: 'terminato', description: 'Conferma la fine della ricarica' },
          { command: 'status', description: 'Visualizza lo stato attuale del sistema' },
          { command: 'help', description: 'Mostra tutti i comandi disponibili' },
          { command: 'dove_sono', description: 'Mostra ID della chat corrente' },
          
          // Comandi admin
          { command: 'admin_status', description: 'Stato dettagliato del sistema' },
          { command: 'admin_stats', description: 'Statistiche del sistema' },
          { command: 'admin_set_max_slots', description: 'Imposta il numero massimo di slot' },
          { command: 'admin_set_charge_time', description: 'Imposta il tempo massimo di ricarica' },
          { command: 'admin_set_reminder_time', description: 'Imposta il tempo di promemoria' },
          { command: 'admin_reset_slot', description: 'Termina forzatamente la sessione di un utente' },
          { command: 'admin_remove_queue', description: 'Rimuove un utente dalla coda' },
          { command: 'admin_notify_all', description: 'Invia un messaggio a tutti gli utenti' },
          { command: 'admin_reset_system', description: 'Resetta completamente il sistema' },
          { command: 'admin_help', description: 'Mostra i comandi admin disponibili' },
          { command: 'dbtest', description: 'Verifica lo stato del database' },
          { command: 'admin_update_commands', description: 'Aggiorna i comandi del bot' }
        ], { scope: { type: 'chat', chat_id: config.ADMIN_USER_ID } });
        
        logger.info('Admin commands updated successfully');
      }
    } catch (error) {
      logger.error('Error setting admin commands:', error);
    }
  } catch (error) {
    logger.error('Error setting bot commands:', error);
  }
}

module.exports = { init };
