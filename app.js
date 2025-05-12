const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const config = require('./config');
const messageHandler = require('./handlers/messageHandler');
const notifier = require('./utils/notifier');
const logger = require('./utils/logger');

// Logging all'avvio
logger.info('====== AVVIO BOT GREEN-CHARGE ======');
logger.info(`Versione Node: ${process.version}`);
logger.info(`Versione mongoose: ${mongoose.version}`);
logger.info(`Bot token length: ${config.BOT_TOKEN ? config.BOT_TOKEN.length : 'undefined'}`);
logger.info(`MongoDB URI: ${config.MONGODB_URI ? 'Configurato' : 'Non configurato'}`);
logger.info(`Admin user ID: ${config.ADMIN_USER_ID || 'Non configurato'}`);
logger.info(`Environment: ${config.ENVIRONMENT}`);
logger.info(`MAX_SLOTS: ${config.MAX_SLOTS}`);
logger.info(`MAX_CHARGE_TIME: ${config.MAX_CHARGE_TIME}`);
logger.info(`REMINDER_TIME: ${config.REMINDER_TIME}`);

// Inizializzazione connessione MongoDB
logger.info('Tentativo di connessione a MongoDB...');
mongoose.connect(config.MONGODB_URI)
  .then(() => {
    logger.info('✅ Connessione a MongoDB riuscita');
    startBot();
  })
  .catch(err => {
    logger.error('❌ Errore di connessione a MongoDB:', err);
    logger.error(`URI MongoDB: ${config.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//****:****@')}`); // Nasconde credenziali nei log
    process.exit(1);
  });

function startBot() {
  try {
    logger.info('Inizializzazione bot Telegram...');
    
    // Inizializzazione bot Telegram
    const bot = new TelegramBot(config.BOT_TOKEN, { 
      polling: true,
      // Aggiungi parametri per gestione errori polling
      polling_error_timeout: 10000,
      onlyFirstMatch: false,
      request: {
        timeout: 30000,
        // Aggiungi agent per debug
        agentOptions: {
          keepAlive: true
        }
      } 
    });
    
    // Logging di eventi di polling
    bot.on('polling_error', (error) => {
      logger.error('❌ Errore di polling Telegram:', error);
      logger.error('Stack trace:', error.stack);
    });
    
    // Test della connessione a Telegram
    logger.info('Verifica connessione a Telegram...');
    bot.getMe().then(info => {
      logger.info(`✅ Bot connesso correttamente come @${info.username} (ID: ${info.id})`);
      
      // Ping di prova per verificare che tutto funzioni
      if (config.ADMIN_USER_ID) {
        logger.info(`Tentativo di invio messaggio di avvio all'admin ${config.ADMIN_USER_ID}...`);
        bot.sendMessage(config.ADMIN_USER_ID, 
          `🤖 *Green-Charge Bot avviato*\n\nIl bot è ora online e pronto all'uso.\n\nVersione: 1.0.0\nAvviato: ${new Date().toLocaleString('it-IT')}`,
          { parse_mode: 'Markdown' })
          .then(() => logger.info('✅ Messaggio di avvio inviato all\'admin'))
          .catch(err => logger.warn('⚠️ Impossibile inviare messaggio all\'admin:', err.message));
      }
    }).catch(err => {
      logger.error('❌ Errore nella connessione a Telegram:', err);
      logger.error('Stack trace:', err.stack);
      logger.error(`Token bot: ${config.BOT_TOKEN.substring(0, 5)}...${config.BOT_TOKEN.substring(config.BOT_TOKEN.length - 5)}`); // Mostra solo parte del token
    });

    // Gestione messaggi e comandi
    logger.info('Inizializzazione handler messaggi...');
    messageHandler.init(bot);

    // Avvio sistema di notifiche periodiche
    logger.info('Avvio sistema di notifiche...');
    const notifierSystem = notifier.startNotificationSystem(bot);
    if (notifierSystem) {
      logger.info('✅ Sistema di notifiche avviato correttamente');
    } else {
      logger.error('❌ Errore nell\'avvio del sistema di notifiche');
    }

    logger.info('✅ Bot avviato con successo');
    logger.logMemoryUsage(); // Log dell'utilizzo memoria

    // Gestione graceful shutdown
    process.on('SIGINT', () => {
      logger.info('Spegnimento bot in corso...');
      
      // Chiudi la connessione a MongoDB
      mongoose.connection.close().then(() => {
        logger.info('Connessione MongoDB chiusa');
        process.exit(0);
      });
    });
    
    // Gestione uncaught exceptions
    process.on('uncaughtException', (err) => {
      logger.error('❌ Eccezione non gestita:', err);
      logger.error('Stack trace:', err.stack);
      logger.logMemoryUsage();
    });
    
    // Gestione unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('❌ Promise rejection non gestita:', reason);
      logger.logMemoryUsage();
    });
    
  } catch (error) {
    logger.error('❌ Errore critico durante l\'avvio del bot:', error);
    logger.error('Stack trace:', error.stack);
    process.exit(1);
  }
}
