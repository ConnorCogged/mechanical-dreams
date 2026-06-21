'use strict';

/**
 * sftpClient.js
 * -------------
 * Adapter around `ssh2-sftp-client` exposing the SAME interface as
 * ftpClient.js (see that file for the contract). Selected when
 * config.protocol === "sftp". Pterodactyl panels typically expose SFTP on
 * port 2022 with a username like "user.serverid".
 */

const SftpClientLib = require('ssh2-sftp-client');

class SftpClient {
  /**
   * @param {object} cfg config.json contents
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new SftpClientLib();
  }

  async connect() {
    await this.client.connect({
      host: this.cfg.host,
      port: this.cfg.port || 2022,
      username: this.cfg.user,
      password: this.cfg.password,
      // Opt-in SSH transport compression. ssh2 negotiates zlib when both ends
      // support it and silently falls back to none otherwise, so this is safe.
      // Note: mod jars are already DEFLATE-compressed, so the on-the-wire gain
      // is usually tiny — leave off unless your link is the bottleneck.
      compress: this.cfg.compress === true,
    });
  }

  close() {
    // end() returns a promise; fire-and-forget on cleanup.
    try {
      this.client.end();
    } catch (_) {
      /* ignore */
    }
  }

  async ensureDir(remotePath) {
    // mkdir(path, true) = recursive (mkdir -p). No-op if it already exists.
    const exists = await this.client.exists(remotePath);
    if (!exists) {
      await this.client.mkdir(remotePath, true);
    }
  }

  /**
   * List a remote directory. Returns [] if it does not exist.
   * @param {string} remotePath
   * @returns {Promise<Array<{name:string,isDirectory:boolean,size:number,modifiedAt:Date|null}>>}
   */
  async list(remotePath) {
    const exists = await this.client.exists(remotePath);
    if (!exists) return [];

    const entries = await this.client.list(remotePath);
    return entries.map((e) => ({
      name: e.name,
      // ssh2-sftp-client: type 'd' === directory, '-' === file, 'l' === link
      isDirectory: e.type === 'd',
      size: typeof e.size === 'number' ? e.size : 0,
      // modifyTime is epoch milliseconds.
      modifiedAt: e.modifyTime ? new Date(e.modifyTime) : null,
    }));
  }

  /**
   * Upload a local file. If `onProgress(transferred, total)` is given, stream
   * byte-level progress via fastPut's step callback.
   */
  async uploadFrom(localPath, remotePath, onProgress) {
    if (typeof onProgress === 'function') {
      await this.client.fastPut(localPath, remotePath, {
        step: (transferred, _chunk, total) => onProgress(transferred, total),
      });
    } else {
      await this.client.put(localPath, remotePath);
    }
  }

  async removeFile(remotePath) {
    await this.client.delete(remotePath);
  }

  async removeDir(remotePath) {
    try {
      // rmdir(path, true) = recursive.
      await this.client.rmdir(remotePath, true);
    } catch (_) {
      /* best-effort */
    }
  }
}

module.exports = SftpClient;
