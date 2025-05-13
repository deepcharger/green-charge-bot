const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegram_id: {
    type: Number,
    required: true,
    unique: true
  },
  username: {
    type: String,
    required: true
  },
  first_interaction: {
    type: Date,
    default: Date.now
  },
  total_charges: {
    type: Number,
    default: 0
  },
  total_time: {
    type: Number,
    default: 0
  },
  last_charge: {
    type: Date,
    default: null
  },
  is_admin: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// Indici per migliorare le prestazioni
userSchema.index({ username: 1 });
userSchema.index({ last_charge: -1 });

module.exports = mongoose.model('User', userSchema);
