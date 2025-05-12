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
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'exceptions.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'rejections.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
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

module.exports = logger;
