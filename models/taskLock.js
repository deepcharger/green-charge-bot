const mongoose = require('mongoose');

/**
 * Schema per i lock delle operazioni
 * Utilizzato per coordinare operazioni tra istanze diverse
 */
const taskLockSchema = new mongoose.Schema({
  task_name: {
    type: String,
    required: true,
    index: true
  },
  lock_id: {
    type: String,
    required: true,
    unique: true
  },
  instance_id: {
    type: String,
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  expires_at: {
    type: Date,
    require
