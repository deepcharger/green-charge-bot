const fs = require('fs');
const path = require('path');

/**
 * Classe per la gestione dei lock locali (su file system)
 */
class LocalLockManager {
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.lockFilePath = path.join(process.cwd(), '.bot_lock');
  }

  /**
   * Crea un lock file locale con l'ID dell'istanza
   * @returns {boolean} true se il lock è stato creato con successo
   */
  createLockFile() {
    try {
      // Crea il file di lock con l'ID dell'istanza
      fs.writeFileSync(this.lockFilePath, this.instanceId);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Verifica se esiste un lock file e se appartiene a questa istanza
   * @returns {boolean} true se il lock file esiste ed è di questa istanza
   */
  checkLockFile() {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        const lockContent = fs.readFileSync(this.lockFilePath, 'utf8');
        return lockContent === this.instanceId;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Rimuove il lock file se appartiene a questa istanza
   * @returns {boolean} true se il lock file è stato rimosso con successo
   */
  removeLockFile() {
    try {
      if (this.checkLockFile()) {
        fs.unlinkSync(this.lockFilePath);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }
}

module.exports = LocalLockManager;
