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
    'active': 'Attiva',
    'completed': 'Completata',
    'timeout': 'Scaduta',
    'admin_terminated': 'Terminata da admin'
  };
  
  return statusMap[status] || status;
}

/**
 * Genera un messaggio di stato formattato
 * @param {Object} status - Oggetto stato del sistema
 * @returns {String} - Messaggio formattato
 */
function formatStatusMessage(status) {
  let message = `Stato attuale del sistema:\n`;
  message += `- Slot occupati: ${status.slots_occupied}/${status.total_slots}\n`;
  
  if (status.active_sessions.length > 0) {
    message += `\nUtenti attualmente in ricarica:\n`;
    status.active_sessions.forEach((session, index) => {
      message += `${index + 1}. @${session.username} (termina tra ${session.remaining_minutes} min)\n`;
    });
  } else {
    message += `\nNessun utente attualmente in ricarica.\n`;
  }
  
  message += `\n`;
  
  if (status.queue.length > 0) {
    message += `Utenti in attesa: ${status.queue.length}\n`;
    message += `Tempo medio di attesa stimato: ${estimateWaitTime(status)} minuti\n`;
    
    if (status.queue.length <= 3) {
      message += `\nProssimi in coda:\n`;
      status.queue.forEach((user, index) => {
        message += `${index + 1}. @${user.username}\n`;
      });
    }
  } else {
    message += `Nessun utente in coda.`;
  }
  
  return message;
}

/**
 * Genera un messaggio di aiuto formattato
 * @returns {String} - Messaggio formattato
 */
function formatHelpMessage() {
  return `
🔋 *Comandi disponibili* 🔋

/prenota - Prenota uno slot o mettiti in coda
/iniziato - Conferma l'inizio della ricarica
/terminato - Conferma la fine della ricarica
/status - Visualizza lo stato attuale del sistema
/help - Mostra questo messaggio di aiuto

⏱️ Ricorda che ogni utente ha a disposizione massimo 30 minuti di ricarica.
👥 Per cortesia, libera la colonnina non appena hai terminato per permettere agli altri di utilizzarla.
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
Hai iniziato la ricarica alle ${formatTime(session.start_time)}.
Il tempo terminerà alle ${formatTime(session.end_time)}.
Riceverai un promemoria 5 minuti prima della scadenza.

Per terminare in anticipo, usa il comando /terminato.
`;
}

/**
 * Formatta un messaggio per la fine della ricarica
 * @param {Object} result - Oggetto risultato con sessione e durata
 * @returns {String} - Messaggio formattato
 */
function formatSessionEndMessage(result) {
  return `
✅ Ricarica terminata con successo!
Durata: ${result.durationMinutes} minuti.

Grazie per aver liberato lo slot per gli altri utenti.
`;
}

module.exports = {
  formatTime,
  formatTimeDiff,
  formatSessionStatus,
  formatStatusMessage,
  formatHelpMessage,
  estimateWaitTime,
  formatSessionStartMessage,
  formatSessionEndMessage
};
