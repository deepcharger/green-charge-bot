const mongoose = require('mongoose');

/**
 * Schema per i lock del sistema
 * Supporta sia lock master che lock di esecuzione
 */
const lockSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  lock_type: {
    type: String,
    enum: ['master', 'execution'],
    required: true
  },
  instance_id: {
    type: String,
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now,
    expires: 600 // TTL di 10 minuti in caso di crash (aumentato per sicurezza)
  },
  last_heartbeat: {
    type: Date,
    default: Date.now
  }
});

// Aggiunge indici per migliorare le prestazioni
lockSchema.index({ instance_id: 1 });
lockSchema.index({ lock_type: 1, last_heartbeat: -1 });

module.exports = mongoose.model('Lock', lockSchema);
