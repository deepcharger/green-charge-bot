const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const config = require('./config');
const messageHandler = require('./handlers/messageHandler');
const notifier = require('./utils/notifier');
const logger = require('./utils/logger');

// Logging all'avvio
logger.info('Starting the bot...');
logger.info(`Bot token length: ${config.BOT_TOKEN ? config.BOT_TOKEN.length : 'undefined'}`);
logger.info(`MongoDB URI: ${config.MONGODB_URI ? 'Configured' : 'Not configured'}`);
logger.info(`Admin user ID: ${config.ADMIN_USER_ID || 'Not configured'}`);
logger.info(`Environment: ${config.ENVIRONMENT}`);

// Inizializzazione connessione MongoDB
logger.info('Connecting to MongoDB...');
mongoose.connect(config.MONGODB_URI)
  .then(() => {
    logger.info('Connected to MongoDB');
    startBot();
  })
  .catch(err => {
    logger.error('MongoDB connection error:', err);
    process.exit(1);
  });

function startBot() {
  try {
    // Inizializzazione bot Telegram
    logger.info('Initializing Telegram bot...');
    const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
    
    // Test della connessione a Telegram
    bot.getMe().then(info => {
      logger.info(`Bot is up and running as @${info.username}`);
    }).catch(err => {
      logger.error('Error getting bot info:', err);
    });

    // Gestione messaggi e comandi
    logger.info('Initializing message handlers...');
    messageHandler.init(bot);

    // Avvio sistema di notifiche periodiche
    logger.info('Starting notification system...');
    notifier.startNotificationSystem(bot);

    logger.info('Bot started successfully');

    // Gestione graceful shutdown
    process.on('SIGINT', () => {
      logger.info('Bot shutting down...');
      mongoose.connection.close();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Error starting the bot:', error);
    process.exit(1);
  }
}
