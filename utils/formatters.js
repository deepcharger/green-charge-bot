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

/**
 * Formatta uno stato di sessione in italiano
 * @param {String} status - Stato della sessione (active, completed, timeout, admin_terminated)
 * @returns {String} - Stato formattato in italiano
 */
function formatSessionStatus(status) {
  const statusMap = {
    'active': '✅ Attiva',
    'completed': '✓ Completata',
    'timeout': '⏱️ Scaduta',
    'admin_terminated': '🛑 Terminata da admin'
  };
  
  return statusMap[status] || status;
}

/**
 * Genera un messaggio di stato formattato
 * @param {Object} status - Oggetto stato del sistema
 * @returns {String} - Messaggio formattato
 */
function formatStatusMessage(status) {
  let message = `📊 *Stato attuale del sistema*\n`;
  message += `🔌 Slot occupati: *${status.slots_occupied}/${status.total_slots}*\n`;
  
  if (status.active_sessions.length > 0) {
    message += `\n⚡ *Utenti attualmente in ricarica:*\n`;
    status.active_sessions.forEach((session, index) => {
      message += `${index + 1}. @${session.username} (⏱️ termina tra *${session.remaining_minutes} min*)\n`;
    });
  } else {
    message += `\n✨ *Nessun utente attualmente in ricarica.*\n`;
  }
  
  message += `\n`;
  
  if (status.queue.length > 0) {
    message += `👥 Utenti in attesa: *${status.queue.length}*\n`;
    message += `⏱️ Tempo medio di attesa stimato: *${estimateWaitTime(status)} minuti*\n`;
    
    if (status.queue.length <= 3) {
      message += `\n🔜 *Prossimi in coda:*\n`;
      status.queue.forEach((user, index) => {
        message += `${index + 1}. @${user.username}\n`;
      });
    }
  } else {
    message += `✅ *Nessun utente in coda.*`;
  }
  
  return message;
}

/**
 * Genera un messaggio di aiuto formattato
 * @returns {String} - Messaggio formattato
 */
function formatHelpMessage() {
  return `
🔋 *Benvenuto al sistema Green-Charge* 🔋

*Comandi Utente:*

📝 */prenota* - Prenota uno slot o mettiti in coda
▶️ */iniziato* - Conferma l'inizio della ricarica
⏹️ */terminato* - Conferma la fine della ricarica
📊 */status* - Visualizza lo stato attuale del sistema
❓ */help* - Mostra questo messaggio di aiuto

*Come funziona:*
1. Usa */prenota* per richiedere un posto
2. Quando è il tuo turno, attiva la colonnina tramite l'app Antonio Green-Charge
3. Conferma l'inizio con */iniziato*
4. Al termine, conferma con */terminato*

⏱️ *Ricorda:* Ogni utente ha a disposizione massimo 30 minuti di ricarica.
👥 *Cortesia:* Libera la colonnina non appena hai terminato per permettere agli altri di utilizzarla.
`;
}

/**
 * Genera un messaggio di aiuto per amministratori
 * @returns {String} - Messaggio formattato
 */
function formatAdminHelpMessage() {
  return `
🔧 *Comandi Amministratore* 🔧

*Gestione Sistema:*
📊 */admin_status* - Stato dettagliato del sistema
📈 */admin_stats* - Statistiche del sistema
🔄 */admin_set_max_slots [numero]* - Imposta il numero massimo di slot
🔄 */admin_set_charge_time [minuti]* - Imposta il tempo massimo di ricarica
🔄 */admin_set_reminder_time [minuti]* - Imposta il tempo di promemoria
🗑️ */admin_reset_system* - Resetta completamente il sistema (richiede conferma)

*Gestione Utenti:*
⏹️ */admin_reset_slot @username* - Termina forzatamente la sessione
🚫 */admin_remove_queue @username* - Rimuove un utente dalla coda
📣 */admin_notify_all [messaggio]* - Invia un messaggio a tutti

*Diagnostica:*
🔍 */admin_dbtest* - Verifica lo stato del database
🔄 */admin_update_commands* - Aggiorna i comandi del bot

*Guida:*
❓ */admin_help* - Mostra questo messaggio
`;
}

/**
 * Stima il tempo di attesa medio basato sullo stato attuale
 * @param {Object} status - Oggetto stato del sistema
 * @returns {Number} - Tempo di attesa stimato in minuti
 */
function estimateWaitTime(status) {
  if (status.queue.length === 0) {
    return 0;
  }
  
  // Se ci sono slot liberi, il tempo di attesa è 0
  if (status.slots_available > 0) {
    return 0;
  }
  
  // Calcola il tempo medio rimanente per le sessioni attive
  let totalRemainingTime = 0;
  
  if (status.active_sessions.length > 0) {
    status.active_sessions.forEach(session => {
      totalRemainingTime += session.remaining_minutes;
    });
    
    const avgRemainingTime = Math.round(totalRemainingTime / status.active_sessions.length);
    
    // Stima basata sulla posizione in coda e sul tempo medio rimanente
    // Assumiamo che ci sia una distribuzione equa dei tempi di fine
    const queuePosition = Math.min(status.queue.length, 3); // Considera al massimo le prime 3 posizioni
    return Math.round(avgRemainingTime * queuePosition / status.active_sessions.length) + 5; // +5 minuti di buffer
  }
  
  // Fallback: stima base se non ci sono sessioni attive (improbabile)
  return 15 * Math.min(status.queue.length, 3);
}

/**
 * Formatta un messaggio per l'inizio della ricarica
 * @param {Object} session - Oggetto sessione
 * @returns {String} - Messaggio formattato
 */
function formatSessionStartMessage(session) {
  return `
✅ *Ricarica iniziata con successo!*

⏱️ Orario di inizio: *${formatTime(session.start_time)}*
⌛ Orario di fine previsto: *${formatTime(session.end_time)}*
🔔 Riceverai un promemoria 5 minuti prima della scadenza.

Per terminare in anticipo, usa il comando */terminato*.
`;
}

/**
 * Formatta un messaggio per la fine della ricarica
 * @param {Object} result - Oggetto risultato con sessione e durata
 * @returns {String} - Messaggio formattato
 */
function formatSessionEndMessage(result) {
  return `
✅ *Ricarica terminata con successo!*

⏱️ Durata: *${result.durationMinutes} minuti*
🔋 Grazie per aver utilizzato Green-Charge!

👍 Hai liberato lo slot per gli altri utenti.
`;
}

/**
 * Formatta un messaggio di benvenuto
 * @param {String} username - Username dell'utente
 * @param {Number} userId - ID dell'utente
 * @returns {String} - Messaggio formattato
 */
function formatWelcomeMessage(username, userId) {
  return `
👋 *Benvenuto @${username}* (ID: ${userId})

Questo bot gestisce la coda per le colonnine di ricarica Green-Charge.

🔸 Usa */prenota* per metterti in coda
🔸 Usa */status* per vedere lo stato attuale
🔸 Usa */help* per vedere tutti i comandi disponibili

Buona ricarica! ⚡
`;
}

/**
 * Formatta un messaggio per un utente in coda
 * @param {String} username - Username dell'utente
 * @param {Number} userId - ID dell'utente
 * @param {Number} position - Posizione in coda
 * @returns {String} - Messaggio formattato
 */
function formatQueueMessage(username, userId, position) {
  return `
⏳ @${username} (ID: ${userId}), al momento tutti gli slot sono occupati.

🔢 Ti ho aggiunto alla coda in posizione *#${position}*.
🔔 Riceverai una notifica quando sarà il tuo turno.

Puoi controllare lo stato della coda con */status*.
`;
}

/**
 * Formatta un messaggio per un utente con slot disponibile
 * @param {String} username - Username dell'utente
 * @param {Number} userId - ID dell'utente
 * @param {Number} maxChargeTime - Tempo massimo di ricarica
 * @returns {String} - Messaggio formattato
 */
function formatSlotAvailableMessage(username, userId, maxChargeTime) {
  return `
✅ @${username} (ID: ${userId}), c'è uno slot libero! Puoi procedere con la ricarica.

1️⃣ Per favore, usa l'app Antonio Green-Charge per attivare la colonnina.
2️⃣ Ricorda che hai a disposizione massimo *${maxChargeTime} minuti*.
3️⃣ Conferma l'inizio della ricarica con */iniziato* quando attivi la colonnina.
`;
}

/**
 * Formatta un messaggio di notifica per un utente in coda
 * @param {String} username - Username dell'utente
 * @param {Number} userId - ID dell'utente
 * @param {Number} maxChargeTime - Tempo massimo di ricarica
 * @returns {String} - Messaggio formattato
 */
function formatNotificationMessage(username, userId, maxChargeTime) {
  return `
🔔 @${username} (ID: ${userId}), si è liberato uno slot! È il tuo turno.

1️⃣ Puoi procedere con la ricarica tramite l'app Antonio Green-Charge.
2️⃣ Ricorda che hai a disposizione massimo *${maxChargeTime} minuti*.
3️⃣ Conferma l'inizio della ricarica con */iniziato* quando attivi la colonnina.

⏱️ *IMPORTANTE*: Hai 5 minuti per confermare l'inizio della ricarica con */iniziato*, dopodichè lo slot sarà assegnato al prossimo utente in coda.
`;
}

/**
 * Formatta un messaggio di promemoria per la fine della ricarica
 * @param {String} username - Username dell'utente
 * @param {Number} remainingMinutes - Minuti rimanenti
 * @param {Date} endTime - Orario di fine ricarica
 * @returns {String} - Messaggio formattato
 */
function formatReminderMessage(username, remainingMinutes, endTime) {
  return `
⏰ @${username}, promemoria: ti restano *${remainingMinutes} minuti* del tuo tempo di ricarica.

🕐 Il tempo terminerà alle *${formatTime(endTime)}*.
🔸 Per favore, preparati a liberare lo slot entro tale orario.
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
⚠️ @${username}, il tuo tempo di ricarica di *${maxChargeTime} minuti* è terminato.

🔋 Per favore, libera lo slot per permettere agli altri utenti di ricaricare.
✅ Conferma con */terminato* quando hai staccato il veicolo.
`;
}

module.exports = {
  formatTime,
  formatTimeDiff,
  formatSessionStatus,
  formatStatusMessage,
  formatHelpMessage,
  formatAdminHelpMessage,
  estimateWaitTime,
  formatSessionStartMessage,
  formatSessionEndMessage,
  formatWelcomeMessage,
  formatQueueMessage,
  formatSlotAvailableMessage,
  formatNotificationMessage,
  formatReminderMessage,
  formatTimeoutMessage
};
