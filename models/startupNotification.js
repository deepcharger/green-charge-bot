const mongoose = require('mongoose');

const startupNotificationSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now
  },
  instance_id: {
    type: String,
    required: true
  },
  notification_type: {
    type: String,
    enum: ['startup', 'shutdown', 'error'],
    default: 'startup'
  },
  message: {
    type: String,
    default: ''
  }
}, { 
  timestamps: true 
});

// Indice TTL per eliminare automaticamente le notifiche vecchie (24 ore)
startupNotificationSchema.index({ 'createdAt': 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('StartupNotification', startupNotificationSchema);
