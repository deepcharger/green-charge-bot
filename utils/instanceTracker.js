/**
 * Sistema di gestione istanze
 * Tiene traccia delle informazioni sulla vita dell'istanza corrente
 */
class InstanceTracker {
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.startTime = new Date();
    this.restartCount = 0;
    this.lastRestartTime = null;
    this.isTerminating = false;
    this.terminationReason = null;
  }

  /**
   * Registra un tentativo di riavvio
   */
  trackRestart() {
    this.restartCount++;
    this.lastRestartTime = new Date();
  }

  /**
   * Inizia il processo di terminazione
   * @param {string} reason - Motivo della terminazione
   */
  startTermination(reason) {
    if (!this.isTerminating) {
      this.isTerminating = true;
      this.terminationReason = reason;
    }
  }

  /**
   * Ottiene la durata di vita dell'istanza in millisecondi
   * @returns {number} Durata di vita in ms
   */
  getLifetime() {
    return new Date() - this.startTime;
  }

  /**
   * Ottiene informazioni sull'istanza in formato oggetto
   * @returns {Object} Informazioni sull'istanza
   */
  getInfo() {
    return {
      instanceId: this.instanceId,
      startTime: this.startTime,
      uptime: this.getLifetime(),
      restartCount: this.restartCount,
      lastRestartTime: this.lastRestartTime,
      isTerminating: this.isTerminating,
      terminationReason: this.terminationReason
    };
  }
}

module.exports = InstanceTracker;
