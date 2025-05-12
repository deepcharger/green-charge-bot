const Session = require('../models/session');
const Queue = require('../models/queue');
const System = require('../models/system');
const User = require('../models/user');
const config = require('../config');
const moment = require('moment');
const logger = require('../utils/logger');

// Richiede uno slot di ricarica
async function requestCharge(userId, username) {
  try {
    // Controlla se l'utente è già in una sessione attiva
    const activeSession = await Session.findOne({ 
      telegram_id: userId, 
      status: 'active' 
    });
    
    if (activeSession) {
      throw new Error('Hai già una sessione di ricarica attiva.');
    }
    
    // Controlla se l'utente è già in coda
    const inQueue = await Queue.findOne({ telegram_id: userId });
    if (inQueue) {
      return {
        slotAvailable: false,
        position: inQueue.position,
        message: 'Sei già in coda.'
      };
    }
    
    // Ottieni lo stato del sistema
    let system = await System.findOne({ name: 'system' });
    if (!system) {
      // Inizializza il sistema se non esiste
      system = new System();
      await system.save();
    }
    
    // Controlla se ci sono slot disponibili
    if (system.slots_available > 0) {
      return {
        slotAvailable: true,
        message: 'Slot disponibile. Puoi procedere con la ricarica.'
      };
    } else {
      // Aggiungi l'utente alla coda
      const position = system.queue_length + 1;
      
      const queueEntry = new Queue({
        telegram_id: userId,
        username,
        position
      });
      
      await queueEntry.save();
      
      // Aggiorna la lunghezza della coda nel sistema
      system.queue_length = position;
      await system.save();
      
      return {
        slotAvailable: false,
        position,
        message: 'Tutti gli slot sono occupati. Sei stato aggiunto alla coda.'
      };
    }
  } catch (error) {
    logger.error('Error in requestCharge:', error);
    throw error;
  }
}

// Implementare altre funzioni per la gestione della coda
// ...

module.exports = {
  requestCharge,
  // altre funzioni esportate
};
