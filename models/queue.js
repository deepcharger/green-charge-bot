const mongoose = require('mongoose');

const queueSchema = new mongoose.Schema({
  telegram_id: {
    type: Number,
    required: true,
    unique: true
  },
  username: {
    type: String,
    required: true
  },
  position: {
    type: Number,
    required: true
  },
  request_time: {
    type: Date,
    default: Date.now
  },
  notified: {
    type: Boolean,
    default: false
  },
  notification_time: {
    type: Date,
    default: null
  },
  slot_reserved: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// Aggiungi indici per migliorare le prestazioni
queueSchema.index({ position: 1 });
queueSchema.index({ telegram_id: 1 });
queueSchema.index({ notified: 1, notification_time: 1, slot_reserved: 1 });

module.exports = mongoose.model('Queue', queueSchema);
