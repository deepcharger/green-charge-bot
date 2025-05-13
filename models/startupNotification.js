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

// Indice TTL per eliminare automaticamente le notifiche vecchie (48 ore)
startupNotificationSchema.index({ 'createdAt': 1 }, { expireAfterSeconds: 172800 });
startupNotificationSchema.index({ instance_id: 1 });
startupNotificationSchema.index({ notification_type: 1, timestamp: -1 });

module.exports = mongoose.model('StartupNotification', startupNotificationSchema);
