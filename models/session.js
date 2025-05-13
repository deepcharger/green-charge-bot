const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  telegram_id: {
    type: Number,
    required: true
  },
  username: {
    type: String,
    required: true
  },
  start_time: {
    type: Date,
    required: true
  },
  end_time: {
    type: Date,
    required: true
  },
  slot_number: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'timeout', 'admin_terminated'],
    default: 'active'
  },
  reminded: {
    type: Boolean,
    default: false
  },
  timeout_notified: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// Aggiungi indici per migliorare le prestazioni
sessionSchema.index({ telegram_id: 1, status: 1 });
sessionSchema.index({ status: 1, end_time: 1 });
sessionSchema.index({ status: 1, reminded: 1, end_time: 1 });
sessionSchema.index({ status: 1, timeout_notified: 1, end_time: 1 });

module.exports = mongoose.model('Session', sessionSchema);
