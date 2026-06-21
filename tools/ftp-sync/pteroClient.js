'use strict';

/**
 * pteroClient.js
 * --------------
 * Thin wrapper around the Pterodactyl **client** API (the per-user API, not the
 * application/admin API). Used by the `--deploy` path in sync.js to push a
 * single zip of changed jars, decompress it server-side, prune removed jars,
 * and re-list for verification — far cheaper than per-file FTP/SFTP transfers.
 *
 * Auth: a client API key (Bearer token) created under
 *   Account -> API Credentials in the Pterodactyl panel.
 *
 * Base URL: `${panelUrl}/api/client/servers/${serverId}`
 *
 * Endpoints used (all relative to base):
 *   GET  /files/list?directory=<urlenc dir>   -> list a directory
 *   GET  /files/upload                         -> signed one-time upload URL
 *   POST <uploadUrl>&directory=<dir>           -> multipart upload (field "files")
 *   POST /files/decompress  {root, file}       -> extract an archive in-place
 *   POST /files/delete      {root, files[]}    -> delete files/dirs
 *
 * Node 24 ships a global `fetch` / `FormData` / `Blob`, so no HTTP deps needed.
 */

const fs = require('fs');
const path = require('path');

class PteroError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'PteroError';
    this.status = status;
    this.body = body;
  }
}

class PteroClient {
  /**
   * @param {object} cfg pterodactyl config block:
   *   { panelUrl, apiKey, serverId, remoteModsDir }
   */
  constructor(cfg) {
    if (!cfg) throw new Error('PteroClient: missing pterodactyl config.');
    if (!cfg.panelUrl) throw new Error('pterodactyl.panelUrl is required.');
    if (!cfg.apiKey) throw new Error('pterodactyl.apiKey is required.');
    if (!cfg.serverId) throw new Error('pterodactyl.serverId is required.');

    this.panelUrl = String(cfg.panelUrl).replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.serverId = cfg.serverId;
    this.base = `${this.panelUrl}/api/client/servers/${this.serverId}`;
  }

  /** Headers for the JSON endpoints. */
  _jsonHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Normalize a directory to an absolute, leading-slash POSIX path.
   * "mods" -> "/mods", "/mods" -> "/mods".
   */
  static normalizeDir(dir) {
    let d = String(dir || '/').replace(/\\/g, '/');
    if (!d.startsWith('/')) d = '/' + d;
    return d.replace(/\/+/g, '/');
  }

  /** Throw a descriptive error for a non-2xx response. */
  async _ensureOk(res, what) {
    if (res.ok) return;
    let body = '';
    try {
      body = await res.text();
    } catch (_) {
      /* ignore */
    }
    let detail = body;
    try {
      const json = JSON.parse(body);
      if (json && Array.isArray(json.errors) && json.errors.length) {
        detail = json.errors
          .map((e) => e.detail || e.code || JSON.stringify(e))
          .join('; ');
      }
    } catch (_) {
      /* not JSON; use raw body */
    }
    throw new PteroError(
      `${what} failed: HTTP ${res.status} ${res.statusText}` +
        (detail ? ` — ${detail}` : ''),
      res.status,
      body
    );
  }

  /**
   * List a remote directory.
   * @param {string} dir e.g. "mods" or "/mods"
   * @returns {Promise<Array<{name,size,isFile,isDirectory,mimetype,modifiedAt}>>}
   */
  async list(dir) {
    const d = PteroClient.normalizeDir(dir);
    const url = `${this.base}/files/list?directory=${encodeURIComponent(d)}`;
    const res = await fetch(url, { headers: this._jsonHeaders() });
    await this._ensureOk(res, `list ${d}`);
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map((item) => {
      const a = item.attributes || {};
      return {
        name: a.name,
        size: typeof a.size === 'number' ? a.size : 0,
        isFile: a.is_file === true,
        isDirectory: a.is_file === false,
        mimetype: a.mimetype || null,
        modifiedAt: a.modified_at ? new Date(a.modified_at) : null,
      };
    });
  }

  /**
   * Request a signed, one-time upload URL.
   * @returns {Promise<string>}
   */
  async getUploadUrl() {
    const url = `${this.base}/files/upload`;
    const res = await fetch(url, { headers: this._jsonHeaders() });
    await this._ensureOk(res, 'get upload URL');
    const json = await res.json();
    const signed = json && json.attributes && json.attributes.url;
    if (!signed) {
      throw new PteroError('get upload URL: response had no attributes.url', 200);
    }
    return signed;
  }

  /**
   * Upload a local file to `dir` via a signed upload URL (multipart/form-data,
   * field name "files"). Pterodactyl preserves the uploaded file's basename.
   * @param {string} localPath absolute path to the file to upload
   * @param {string} dir target directory, e.g. "mods"
   * @returns {Promise<string>} the basename stored on the server
   */
  async uploadZip(localPath, dir) {
    const d = PteroClient.normalizeDir(dir);
    const signed = await this.getUploadUrl();
    const sep = signed.includes('?') ? '&' : '?';
    const target = `${signed}${sep}directory=${encodeURIComponent(d)}`;

    const buf = fs.readFileSync(localPath);
    const name = path.basename(localPath);

    const form = new FormData();
    // global Blob/File via undici (Node 18+). Use Blob to control the filename.
    form.append('files', new Blob([buf], { type: 'application/zip' }), name);

    // NOTE: do NOT set Content-Type here — fetch sets the multipart boundary.
    const res = await fetch(target, { method: 'POST', body: form });
    await this._ensureOk(res, `upload ${name}`);
    return name;
  }

  /**
   * Decompress an archive that already lives under `root`.
   * @param {string} root directory containing the archive, e.g. "mods"
   * @param {string} file archive basename, e.g. "_upload.zip"
   */
  async decompress(root, file) {
    const r = PteroClient.normalizeDir(root);
    const url = `${this.base}/files/decompress`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this._jsonHeaders(),
      body: JSON.stringify({ root: r, file }),
    });
    await this._ensureOk(res, `decompress ${file}`);
  }

  /**
   * Delete files (or dirs) under `root`.
   * @param {string} root e.g. "mods"
   * @param {string[]} names basenames relative to root
   */
  async deleteFiles(root, names) {
    const list = (names || []).filter(Boolean);
    if (list.length === 0) return;
    const r = PteroClient.normalizeDir(root);
    const url = `${this.base}/files/delete`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this._jsonHeaders(),
      body: JSON.stringify({ root: r, files: list }),
    });
    await this._ensureOk(res, `delete ${list.length} file(s)`);
  }
}

module.exports = PteroClient;
module.exports.PteroError = PteroError;
