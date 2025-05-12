const Session = require('../models/session');
const Queue = require('../models/queue');
const System = require('../models/system');
const User = require('../models/user');
const userHandler = require('./userHandler');
const queueHandler = require('./queueHandler');
const sessionHandler = require('./sessionHandler');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Gestisce i comandi admin
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @param {Number} userId - ID Telegram dell'amministratore
 * @param {String} command - Comando da eseguire
 * @param {String} fullText - Testo completo del messaggio
 * @returns {Promise<void>}
 */
async function handleAdminCommand(bot, chatId, userId, command, fullText) {
  try {
    // Verifica che l'utente sia effettivamente admin
    if (userId !== config.ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Comando riservato agli amministratori.');
      return;
    }
    
    const params = fullText.split(' ').slice(1);
    
    switch (command) {
      case 'status':
        await handleAdminStatus(bot, chatId);
        break;
        
      case 'stats':
        await handleAdminStats(bot, chatId);
        break;
        
      case 'reset_slot':
        if (params.length < 1) {
          bot.sendMessage(chatId, 'Uso: /admin_reset_slot @username');
          return;
        }
        await handleResetSlot(bot, chatId, params[0]);
        break;
        
      case 'remove_queue':
        if (params.length < 1) {
          bot.sendMessage(chatId, 'Uso: /admin_remove_queue @username');
          return;
        }
        await handleRemoveFromQueue(bot, chatId, params[0]);
        break;
        
      case 'set_max_slots':
        if (params.length < 1 || isNaN(parseInt(params[0]))) {
          bot.sendMessage(chatId, 'Uso: /admin_set_max_slots [numero]');
          return;
        }
        await handleSetMaxSlots(bot, chatId, parseInt(params[0]));
        break;
        
      case 'notify_all':
        if (params.length < 1) {
          bot.sendMessage(chatId, 'Uso: /admin_notify_all [messaggio]');
          return;
        }
        await handleNotifyAll(bot, chatId, params.join(' '));
        break;
        
      case 'reset_system':
        await handleResetSystem(bot, chatId);
        break;
        
      case 'help':
        await handleAdminHelp(bot, chatId);
        break;
        
      default:
        bot.sendMessage(chatId, 
          'Comando admin non riconosciuto. Usa /admin_help per la lista dei comandi disponibili.');
    }
  } catch (error) {
    logger.error(`Admin command error (${command}):`, error);
    bot.sendMessage(chatId, `Errore durante l'esecuzione del comando: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_status
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @returns {Promise<void>}
 */
async function handleAdminStatus(bot, chatId) {
  try {
    const status = await queueHandler.getSystemStatus();
    
    let message = `[ADMIN] Stato dettagliato del sistema:\n`;
    message += `- Slot totali: ${status.total_slots}\n`;
    message += `- Slot occupati: ${status.slots_occupied}/${status.total_slots}\n`;
    message += `- Slot disponibili: ${status.slots_available}\n`;
    message += `- Utenti in coda: ${status.queue_length}\n\n`;
    
    if (status.active_sessions.length > 0) {
      message += `Utenti attualmente in ricarica:\n`;
      status.active_sessions.forEach((session, index) => {
        message += `${index + 1}. @${session.username} (ID: ${session.telegram_id}) - ` +
                   `Slot ${session.slot_number}, ` +
                   `iniziato alle ${formatTime(session.start_time)}, ` +
                   `termina alle ${formatTime(session.end_time)} ` +
                   `(tra ${session.remaining_minutes} min)\n`;
      });
    } else {
      message += `Nessun utente attualmente in ricarica.\n`;
    }
    
    message += `\n`;
    
    if (status.queue.length > 0) {
      message += `Utenti in coda:\n`;
      status.queue.forEach((user, index) => {
        message += `${index + 1}. @${user.username} (ID: ${user.telegram_id}) - ` +
                   `Posizione #${user.position}, ` +
                   `in attesa da ${formatTimeDiff(user.request_time)}\n`;
      });
    } else {
      message += `Nessun utente in coda.`;
    }
    
    bot.sendMessage(chatId, message);
  } catch (error) {
    logger.error('Admin status error:', error);
    bot.sendMessage(chatId, `Errore durante il recupero dello stato: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_stats
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @returns {Promise<void>}
 */
async function handleAdminStats(bot, chatId) {
  try {
    const stats = await queueHandler.getSystemStats();
    
    let message = `[ADMIN] Statistiche del sistema:\n\n`;
    message += `Statistiche generali:\n`;
    message += `- Ricariche totali completate: ${stats.total_charges_completed}\n`;
    message += `- Ricariche completate oggi: ${stats.charges_today}\n`;
    message += `- Tempo medio di ricarica: ${stats.avg_charge_time} minuti\n\n`;
    
    message += `Statistiche utenti:\n`;
    message += `- Utenti totali registrati: ${stats.total_users}\n`;
    message += `- Utenti attivi negli ultimi 30 giorni: ${stats.active_users}\n\n`;
    
    message += `Stato attuale:\n`;
    message += `- Slot totali: ${stats.total_slots}\n`;
    message += `- Slot occupati: ${stats.current_status.slots_occupied}/${stats.total_slots}\n`;
    message += `- Slot disponibili: ${stats.current_status.slots_available}\n`;
    message += `- Utenti in coda: ${stats.current_status.queue_length}`;
    
    bot.sendMessage(chatId, message);
  } catch (error) {
    logger.error('Admin stats error:', error);
    bot.sendMessage(chatId, `Errore durante il recupero delle statistiche: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_reset_slot
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @param {String} username - Username Telegram dell'utente
 * @returns {Promise<void>}
 */
async function handleResetSlot(bot, chatId, username) {
  try {
    // Pulisci lo username da eventuali @
    username = username.replace('@', '');
    
    // Trova l'utente
    const user = await User.findOne({ username });
    
    if (!user) {
      bot.sendMessage(chatId, `Utente @${username} non trovato.`);
      return;
    }
    
    // Trova e termina la sessione attiva
    const result = await sessionHandler.endSession(user.telegram_id, 'admin_terminated');
    
    if (!result || !result.session) {
      bot.sendMessage(chatId, `Utente @${username} non ha sessioni attive.`);
      return;
    }
    
    // Notifica l'utente
    bot.sendMessage(user.telegram_id, 
      `La tua sessione di ricarica è stata terminata da un amministratore.\n` +
      `Durata: ${result.durationMinutes} minuti.`);
    
    // Notifica l'admin
    bot.sendMessage(chatId, 
      `Slot di @${username} (ID: ${user.telegram_id}) è stato resettato.\n` +
      `Durata della sessione: ${result.durationMinutes} minuti.\n` +
      `È stato inviato un avviso al prossimo utente in coda.`);
    
    // Notifica il prossimo utente in coda
    await queueHandler.notifyNextInQueue(bot);
  } catch (error) {
    logger.error(`Admin reset slot error for ${username}:`, error);
    bot.sendMessage(chatId, `Errore durante il reset dello slot: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_remove_queue
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @param {String} username - Username Telegram dell'utente
 * @returns {Promise<void>}
 */
async function handleRemoveFromQueue(bot, chatId, username) {
  try {
    // Pulisci lo username da eventuali @
    username = username.replace('@', '');
    
    // Rimuovi dalla coda
    const result = await queueHandler.adminRemoveFromQueue(username);
    
    if (!result) {
      bot.sendMessage(chatId, `Utente @${username} non trovato in coda.`);
      return;
    }
    
    // Notifica l'utente
    bot.sendMessage(result.telegram_id, 
      `Sei stato rimosso dalla coda da un amministratore.\n` +
      `Eri in posizione #${result.position}.`);
    
    // Notifica l'admin
    bot.sendMessage(chatId, 
      `@${username} (ID: ${result.telegram_id}) è stato rimosso dalla coda.\n` +
      `Era in posizione #${result.position}.`);
  } catch (error) {
    logger.error(`Admin remove from queue error for ${username}:`, error);
    bot.sendMessage(chatId, `Errore durante la rimozione dalla coda: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_set_max_slots
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @param {Number} maxSlots - Nuovo numero massimo di slot
 * @returns {Promise<void>}
 */
async function handleSetMaxSlots(bot, chatId, maxSlots) {
  try {
    if (maxSlots < 1) {
      bot.sendMessage(chatId, 'Il numero di slot deve essere almeno 1.');
      return;
    }
    
    // Aggiorna il numero massimo di slot
    const system = await queueHandler.updateMaxSlots(maxSlots);
    
    // Notifica l'admin
    bot.sendMessage(chatId, 
      `Numero massimo di slot aggiornato a ${maxSlots}.\n` +
      `Stato attuale: ${system.slots_available} slot disponibili.`);
    
    // Se sono stati aggiunti nuovi slot disponibili, notifica gli utenti in coda
    if (system.slots_available > 0) {
      await queueHandler.notifyNextInQueue(bot);
    }
  } catch (error) {
    logger.error(`Admin set max slots error (${maxSlots}):`, error);
    bot.sendMessage(chatId, `Errore durante l'aggiornamento del numero massimo di slot: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_notify_all
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @param {String} message - Messaggio da inviare a tutti gli utenti
 * @returns {Promise<void>}
 */
async function handleNotifyAll(bot, chatId, message) {
  try {
    // Ottieni tutti gli utenti
    const users = await userHandler.getUsers();
    
    if (users.length === 0) {
      bot.sendMessage(chatId, 'Nessun utente registrato.');
      return;
    }
    
    let successCount = 0;
    let errorCount = 0;
    
    // Invia il messaggio a tutti gli utenti
    for (const user of users) {
      try {
        await bot.sendMessage(
          user.telegram_id,
          `📢 ANNUNCIO AMMINISTRATORE 📢\n\n${message}`
        );
        successCount++;
      } catch (error) {
        logger.error(`Error sending message to user ${user.telegram_id}:`, error);
        errorCount++;
      }
    }
    
    // Notifica l'admin
    bot.sendMessage(chatId, 
      `Messaggio inviato a ${successCount} utenti.\n` +
      `Errori: ${errorCount}`);
  } catch (error) {
    logger.error('Admin notify all error:', error);
    bot.sendMessage(chatId, `Errore durante l'invio del messaggio: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_reset_system
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @returns {Promise<void>}
 */
async function handleResetSystem(bot, chatId) {
  try {
    // Chiedi conferma
    bot.sendMessage(chatId, 
      `⚠️ ATTENZIONE ⚠️\n\n` +
      `Stai per resettare completamente il sistema, terminando tutte le sessioni attive e svuotando la coda.\n\n` +
      `Questa operazione non può essere annullata.\n\n` +
      `Per confermare, rispondi con /admin_confirm_reset`);
      
    // La conferma dovrà essere gestita come un comando separato
  } catch (error) {
    logger.error('Admin reset system error:', error);
    bot.sendMessage(chatId, `Errore durante il reset del sistema: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_confirm_reset
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @returns {Promise<void>}
 */
async function handleConfirmReset(bot, chatId) {
  try {
    // Ottieni tutte le sessioni attive
    const activeSessions = await Session.find({ status: 'active' });
    
    // Termina tutte le sessioni attive
    for (const session of activeSessions) {
      await sessionHandler.endSession(session.telegram_id, 'admin_terminated');
      
      // Notifica l'utente
      bot.sendMessage(session.telegram_id, 
        `La tua sessione di ricarica è stata terminata a causa di un reset del sistema.\n` +
        `Il sistema è stato resettato da un amministratore.`);
    }
    
    // Ottieni tutti gli utenti in coda
    const queuedUsers = await Queue.find();
    
    // Svuota la coda
    await Queue.deleteMany({});
    
    // Notifica gli utenti in coda
    for (const user of queuedUsers) {
      bot.sendMessage(user.telegram_id, 
        `Sei stato rimosso dalla coda a causa di un reset del sistema.\n` +
        `Il sistema è stato resettato da un amministratore.`);
    }
    
    // Resetta lo stato del sistema
    const system = await System.findOne({ name: 'system' });
    if (system) {
      system.slots_available = system.total_slots;
      system.active_sessions = [];
      system.queue_length = 0;
      await system.save();
    }
    
    // Notifica l'admin
    bot.sendMessage(chatId, 
      `Sistema resettato con successo.\n` +
      `- ${activeSessions.length} sessioni attive terminate\n` +
      `- ${queuedUsers.length} utenti rimossi dalla coda\n` +
      `- ${system ? system.total_slots : 5} slot disponibili`);
  } catch (error) {
    logger.error('Admin confirm reset error:', error);
    bot.sendMessage(chatId, `Errore durante il reset del sistema: ${error.message}`);
  }
}

/**
 * Gestisce il comando admin_help
 * @param {Object} bot - Istanza del bot Telegram
 * @param {Number} chatId - ID della chat
 * @returns {Promise<void>}
 */
async function handleAdminHelp(bot, chatId) {
  const message = `
Comandi Amministratore:

/admin_status - Mostra lo stato dettagliato del sistema
/admin_stats - Mostra le statistiche del sistema
/admin_reset_slot @username - Termina forzatamente la sessione di un utente
/admin_remove_queue @username - Rimuove un utente dalla coda
/admin_set_max_slots [numero] - Imposta il numero massimo di slot
/admin_notify_all [messaggio] - Invia un messaggio a tutti gli utenti
/admin_reset_system - Resetta completamente il sistema (richiede conferma)
/admin_help - Mostra questo messaggio
`;
  
  bot.sendMessage(chatId, message);
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

/**
 * Calcola e formatta la differenza di tempo tra un timestamp e adesso
 * @param {Date|String} timestamp - Timestamp di riferimento
 * @returns {String} - Differenza di tempo formattata
 */
function formatTimeDiff(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMinutes = Math.floor((now - then) / 60000);
  
  if (diffMinutes < 60) {
    return `${diffMinutes} min`;
  } else {
    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
}

module.exports = {
  handleAdminCommand,
  handleConfirmReset // Esposto per gestire la conferma del reset
};
