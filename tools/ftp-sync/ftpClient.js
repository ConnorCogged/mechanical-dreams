'use strict';

/**
 * ftpClient.js
 * ------------
 * Thin adapter around `basic-ftp` exposing a small, protocol-agnostic API
 * that sync.js consumes. The SFTP adapter (sftpClient.js) exposes the same
 * shape so sync.js does not care which protocol is in use.
 *
 * Common adapter interface:
 *   connect()                          -> Promise<void>
 *   close()                            -> void
 *   ensureDir(remotePath)              -> Promise<void>   (mkdir -p)
 *   list(remotePath)                   -> Promise<RemoteEntry[]>
 *   uploadFrom(localPath, remotePath)  -> Promise<void>
 *   removeFile(remotePath)             -> Promise<void>
 *   removeDir(remotePath)              -> Promise<void>   (best-effort, recursive)
 *
 * RemoteEntry = { name, isDirectory, size, modifiedAt(Date|null) }
 */

const ftp = require('basic-ftp');

class FtpClient {
  /**
   * @param {object} cfg config.json contents
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new ftp.Client();
    this.client.ftp.verbose = false;
  }

  async connect() {
    await this.client.access({
      host: this.cfg.host,
      port: this.cfg.port || 21,
      user: this.cfg.user,
      password: this.cfg.password,
      secure: !!this.cfg.secure, // explicit FTPS when true
    });
  }

  close() {
    // basic-ftp's close() is synchronous and safe to call once.
    try {
      this.client.close();
    } catch (_) {
      /* ignore */
    }
  }

  async ensureDir(remotePath) {
    // ensureDir creates the full path and leaves cwd inside it, so restore root.
    await this.client.ensureDir(remotePath);
    await this.client.cd('/');
  }

  /**
   * List a remote directory. Returns [] if it does not exist.
   * @param {string} remotePath
   * @returns {Promise<Array<{name:string,isDirectory:boolean,size:number,modifiedAt:Date|null}>>}
   */
  async list(remotePath) {
    let entries;
    try {
      entries = await this.client.list(remotePath);
    } catch (err) {
      // 550 = no such file/dir on most servers.
      return [];
    }
    return entries.map((e) => ({
      name: e.name,
      // basic-ftp: type 2 === directory (FileType.Directory)
      isDirectory: e.isDirectory === true || e.type === 2,
      size: typeof e.size === 'number' ? e.size : 0,
      modifiedAt: e.modifiedAt instanceof Date ? e.modifiedAt : null,
    }));
  }

  async uploadFrom(localPath, remotePath) {
    await this.client.uploadFrom(localPath, remotePath);
  }

  async removeFile(remotePath) {
    await this.client.remove(remotePath);
  }

  async removeDir(remotePath) {
    // removeDir is recursive in basic-ftp.
    try {
      await this.client.removeDir(remotePath);
      await this.client.cd('/');
    } catch (_) {
      /* best-effort */
    }
  }
}

module.exports = FtpClient;
