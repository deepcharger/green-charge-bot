const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const config = require('./config');
const messageHandler = require('./handlers/messageHandler');
const notifier = require('./utils/notifier');
const logger = require('./utils/logger');

// Inizializzazione connessione MongoDB
mongoose.connect(config.MONGODB_URI)
  .then(() => {
    logger.info('Connected to MongoDB');
  })
  .catch(err => {
    logger.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Inizializzazione bot Telegram
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// Gestione messaggi e comandi
messageHandler.init(bot);

// Avvio sistema di notifiche periodiche
notifier.startNotificationSystem(bot);

logger.info('Bot started successfully');

// Gestione graceful shutdown
process.on('SIGINT', () => {
  logger.info('Bot shutting down...');
  mongoose.connection.close();
  process.exit(0);
});
