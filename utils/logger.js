const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Crea la cartella logs se non esiste
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Configurazione dei formati
const { combine, timestamp, printf, colorize, align } = winston.format;

// Formato personalizzato
const logFormat = printf(({ level, message, timestamp }) => {
  return `[${timestamp}] ${level}: ${message}`;
});

// Aggiunge opzioni di rotazione ai file di log
const fileOptions = {
  maxsize: 10485760, // 10MB
  maxFiles: 10,
  tailable: true,
  zippedArchive: true,
};

// Crea il logger
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    align(),
    logFormat
  ),
  transports: [
    // Log di tutti i livelli su file
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      ...fileOptions
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      ...fileOptions
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'exceptions.log'),
      ...fileOptions
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'rejections.log'),
      ...fileOptions
    })
  ]
});

// Se non in produzione, aggiungi output colorato su console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: combine(
      colorize({ all: true }),
      timestamp({ format: 'HH:mm:ss' }),
      align(),
      logFormat
    ),
    handleExceptions: true,
    handleRejections: true
  }));
}

// Helper per stampare la memoria utilizzata (per diagnostica)
logger.logMemoryUsage = function() {
  const memoryUsage = process.memoryUsage();
  
  this.debug(
    `Memory Usage - RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)} MB, ` +
    `Heap Total: ${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB, ` +
    `Heap Used: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
  );
};

// Limita la lunghezza dei messaggi di log per evitare problemi con messaggi troppo lunghi
const originalLog = logger.log;
logger.log = function(level, message, ...args) {
  if (typeof message === 'string' && message.length > 5000) {
    message = message.substring(0, 5000) + '... (messaggio troncato)';
  }
  return originalLog.call(this, level, message, ...args);
};

module.exports = logger;
