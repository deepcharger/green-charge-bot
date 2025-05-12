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

module.exports = mongoose.model('Session', sessionSchema);
