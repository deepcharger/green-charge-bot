const mongoose = require('mongoose');

const lockSchema = new mongoose.Schema({
  name: {
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
    default: Date.now,
    expires: 60 // TTL di 60 secondi in caso di crash
  },
  last_heartbeat: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Lock', lockSchema);
