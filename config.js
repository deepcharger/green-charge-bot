require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  MONGODB_URI: process.env.MONGODB_URI,
  ADMIN_USER_ID: parseInt(process.env.ADMIN_USER_ID),
  AUTHORIZED_GROUP_ID: process.env.AUTHORIZED_GROUP_ID ? parseInt(process.env.AUTHORIZED_GROUP_ID) : null,
  RESTRICT_TO_GROUP: process.env.RESTRICT_TO_GROUP === 'true',
  MAX_SLOTS: parseInt(process.env.MAX_SLOTS || '5'),
  MAX_CHARGE_TIME: parseInt(process.env.MAX_CHARGE_TIME || '30'),
  REMINDER_TIME: parseInt(process.env.REMINDER_TIME || '5'),
  ENVIRONMENT: process.env.NODE_ENV || 'development',
  COMMAND_PREFIX: '/'
};