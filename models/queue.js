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

module.exports = mongoose.model('Queue', queueSchema);
