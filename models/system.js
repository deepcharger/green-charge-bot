const mongoose = require('mongoose');

const systemSchema = new mongoose.Schema({
  name: {
    type: String,
    default: 'system',
    unique: true
  },
  total_slots: {
    type: Number,
    default: 5
  },
  slots_available: {
    type: Number,
    default: 5
  },
  active_sessions: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'Session',
    default: []
  },
  queue_length: {
    type: Number,
    default: 0
  },
  total_charges_completed: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// Indice per il nome del sistema per recupero rapido
systemSchema.index({ name: 1 });

module.exports = mongoose.model('System', systemSchema);
