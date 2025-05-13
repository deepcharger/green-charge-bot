const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const config = require('./config');
const messageHandler = require('./handlers/messageHandler');
const notifier = require('./utils/notifier');
const logger = require('./utils/logger');

// Inizializza Express
const app = express();
app.use(express.json());

// Imposta un path per il health check richiesto da Render
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Avvia il processo di connessione al database
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

// Opzioni per la connessione MongoDB per maggiore resilienza
const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 60000,
  family: 4,
  connectTimeoutMS: 30000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  maxPoolSize: 20,
  minPoolSize: 5,
  keepAlive: true,
  keepAliveInitialDelay: 300000
};

// Gestire gli eventi di MongoDB per monitorare la connessione
mongoose.connection.on('connecting', () => {
  logger.info('MongoDB: tentativo di connessione in corso...');
});

mongoose.connection.on('connected', () => {
  logger.info('MongoDB: connesso con successo');
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB: disconnesso');
  logger.info('MongoDB: tentativo di riconnessione...');
});

mongoose.connection.on('error', (err) => {
  logger.error(`MongoDB: errore di connessione: ${err.message}`);
});

// Connessione al database e avvio del bot
mongoose.connect(config.MONGODB_URI, mongooseOptions)
  .then(async () => {
    logger.info('✅ Connessione a MongoDB riuscita');
    
    // Inizializza il bot in modalità webhook (non polling)
    const bot = new TelegramBot(config.BOT_TOKEN, { polling: false });
    
    // Endpoint per ricevere aggiornamenti da Telegram
    app.post(`/webhook/${config.BOT_TOKEN}`, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    
    // Inizializza gli handler dei messaggi
    await messageHandler.init(bot);
    
    // Avvia il sistema di notifiche periodiche
    const notificationSystem = notifier.startNotificationSystem(bot);
    
    // Sistema di rilevamento risveglio da sleep
    let lastActiveTime = Date.now();
    
    // Aggiorna il timestamp ad ogni richiesta
    app.use((req, res, next) => {
      lastActiveTime = Date.now();
      next();
    });
    
    // Verifica periodicamente se il servizio è stato risvegliato
    setInterval(() => {
      const now = Date.now();
      // Se sono passati più di 20 minuti dall'ultima attività
      if (now - lastActiveTime > 20 * 60 * 1000) {
        logger.info('Rilevato possibile risveglio da spin down, riavvio sistema notifiche');
        if (notificationSystem && notificationSystem.stop) {
          notificationSystem.stop();
        }
        notifier.startNotificationSystem(bot);
        lastActiveTime = now;
      }
    }, 5 * 60 * 1000); // Controlla ogni 5 minuti
    
    logger.info('✅ Bot inizializzato correttamente in modalità webhook');
    
    // Avvia il server Express
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      logger.info(`🚀 Server webhook in ascolto sulla porta ${PORT}`);
    });
  })
  .catch(err => {
    logger.error('❌ Errore di connessione a MongoDB:', err);
    logger.error(`URI MongoDB: ${config.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//****:****@')}`);
    process.exit(1);
  });

// Gestione segnali di terminazione
process.on('SIGINT', () => {
  logger.info('Segnale SIGINT ricevuto, spegnimento bot in corso...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Segnale SIGTERM ricevuto, spegnimento bot in corso...');
  process.exit(0);
});
