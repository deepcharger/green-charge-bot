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
logger.info('Tentativo di connessione a MongoDB...');
mongoose.connect(config.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 60000
})
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
  notifier.startNotificationSystem(bot, null, null);
  
  logger.info('✅ Bot inizializzato correttamente in modalità webhook');
  
  // Avvia il server Express
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`🚀 Server webhook in ascolto sulla porta ${PORT}`);
  });
})
.catch(err => {
  logger.error('❌ Errore di connessione a MongoDB:', err);
  process.exit(1);
});
