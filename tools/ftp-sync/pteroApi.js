'use strict';

/**
 * pteroApi.js
 * -----------
 * OPTIONAL Pterodactyl client-API helper, used by --deploy ONLY to automate the
 * server-side decompress step (and delete the temp zip) after the zip has been
 * uploaded over SFTP. If no API credentials are configured, --deploy instead
 * prompts the user to decompress the uploaded zip by hand — this module is not
 * used at all in that case.
 *
 * It deliberately covers just two endpoints (decompress + delete); the file
 * transfer itself is done over SFTP, so there is no upload/list code here.
 *
 * Auth: a client API key (Bearer token) from Account -> API Credentials.
 * Base URL: `${panelUrl}/api/client/servers/${serverId}`
 */

/** Build a helper, or return null when credentials are absent/incomplete. */
function getPteroApi(cfg) {
  const p = cfg && cfg.pterodactyl;
  if (!p || !p.panelUrl || !p.apiKey || !p.serverId) return null;
  return new PteroApi(p);
}

/** Normalize a directory to an absolute, leading-slash POSIX path. */
function normalizeDir(dir) {
  let d = String(dir || '/').replace(/\\/g, '/');
  if (!d.startsWith('/')) d = '/' + d;
  return d.replace(/\/+/g, '/');
}

class PteroApi {
  constructor(p) {
    this.panelUrl = String(p.panelUrl).replace(/\/+$/, '');
    this.apiKey = p.apiKey;
    this.serverId = p.serverId;
    this.base = `${this.panelUrl}/api/client/servers/${this.serverId}`;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

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
      /* not JSON */
    }
    throw new Error(
      `${what} failed: HTTP ${res.status} ${res.statusText}` +
        (detail ? ` — ${detail}` : '')
    );
  }

  /** Decompress an archive that already lives under `root`. */
  async decompress(root, file) {
    const res = await fetch(`${this.base}/files/decompress`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ root: normalizeDir(root), file }),
    });
    await this._ensureOk(res, `decompress ${file}`);
  }

  /** Delete files (or dirs) under `root`. */
  async deleteFiles(root, names) {
    const list = (names || []).filter(Boolean);
    if (list.length === 0) return;
    const res = await fetch(`${this.base}/files/delete`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ root: normalizeDir(root), files: list }),
    });
    await this._ensureOk(res, `delete ${list.length} file(s)`);
  }
}

module.exports = { getPteroApi };
