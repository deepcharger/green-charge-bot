const mongoose = require('mongoose');

/**
 * Schema per i lock delle operazioni
 * Utilizzato per coordinare operazioni tra istanze diverse
 */
const taskLockSchema = new mongoose.Schema({
  task_name: {
    type: String,
    required: true,
    index: true
  },
  lock_id: {
    type: String,
    required: true,
    unique: true
  },
  instance_id: {
    type: String,
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  expires_at: {
    type: Date,
    required: true,
    expires: 0 // TTL index, rimuove automaticamente i documenti scaduti
  }
});

// Indice composto per velocizzare la ricerca per nome e scadenza
taskLockSchema.index({ task_name: 1, expires_at: 1 });
taskLockSchema.index({ instance_id: 1 });

module.exports = mongoose.model('TaskLock', taskLockSchema);
