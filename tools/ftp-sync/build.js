'use strict';

/**
 * build.js
 * --------
 * Produces a SERVER-SIDE pack (mods/ + config/ only) in a local staging dir.
 *
 * packwiz-installer downloads EVERY raw override file (shaderpacks/, resource
 * packs, options.txt, ...) regardless of "--side server", because raw files
 * carry no side metadata. A dedicated server needs none of that — only the
 * server/both mods and the configs.
 *
 * To avoid downloading tens of MB of client-only shader/texture assets, we:
 *   1. Fetch the published pack.toml + index.toml.
 *   2. Strip the index down to ONLY mods/ and config/ entries.
 *   3. Serve the trimmed pack.toml + index.toml from a tiny localhost server,
 *      302-redirecting every other path to the real GitHub Pages host (so the
 *      mod .pw.toml files and configs still download, with their real hashes).
 *   4. Run packwiz-installer against that local pack URL with "-s server".
 *
 * Result: it only ever requests mods/ + config/ — shaders/textures are never
 * downloaded, not just deleted afterwards.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

// --- Constants -------------------------------------------------------------

const DEFAULT_JAVA_BIN =
  'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.7.6-hotspot\\bin\\java.exe';

// Published pack base (GitHub Pages). pack.toml lives at <base>/pack.toml.
const PACK_BASE = 'https://connorcogged.github.io/mechanical-dreams';

const BOOTSTRAP_URL =
  'https://github.com/packwiz/packwiz-installer-bootstrap/releases/download/v0.0.3/packwiz-installer-bootstrap.jar';
const BOOTSTRAP_JAR = 'packwiz-installer-bootstrap.jar';

const STAGE_DIR = path.join(__dirname, '.server-stage');

// Index entries kept for a server build. By default ONLY mods/ — config/ is
// intentionally excluded because configs can contain sensitive data and must be
// managed by hand on the server (never fetched/overwritten). Pass withConfig
// (the --with-config flag) for a one-time initial deploy that includes config/.
// Everything else (shaderpacks/, resourcepacks/, options.txt, shader refs, ...)
// is always dropped so it is never even requested.
function keepPrefixes(withConfig) {
  return withConfig ? ['mods/', 'config/'] : ['mods/'];
}

// --- Network helpers -------------------------------------------------------

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft === 0) return reject(new Error('Too many redirects: ' + url));
          res.resume();
          return resolve(fetchText(res.headers.location, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} -> ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function downloadFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft === 0) return reject(new Error('Too many redirects: ' + url));
          res.resume();
          file.close();
          return resolve(downloadFile(res.headers.location, dest, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download ${url} -> ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => fs.unlink(dest, () => reject(err)));
  });
}

// --- Index trimming --------------------------------------------------------

/** Keep only [[files]] entries whose `file` starts with one of `keep`. */
function trimIndex(indexText, keep) {
  const start = indexText.indexOf('[[files]]');
  if (start === -1) return indexText;
  const header = indexText.slice(0, start);
  const blocks = indexText.slice(start).split(/(?=\[\[files\]\])/);
  const kept = blocks.filter((b) => {
    const m = b.match(/file\s*=\s*"([^"]*)"/);
    if (!m) return false;
    // Skip ".disabled" jars — disabled in the pack, useless dead weight on the server.
    if (m[1].endsWith('.disabled')) return false;
    return keep.some((p) => m[1].startsWith(p));
  });
  return header + kept.join('');
}

/** Replace the hash inside the [index] table of pack.toml. */
function patchPackHash(packText, newHash) {
  return packText.replace(/(\[index\][\s\S]*?\bhash\s*=\s*")[^"]*(")/, `$1${newHash}$2`);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// --- Bootstrap -------------------------------------------------------------

async function ensureBootstrap({ dryRun }) {
  if (!fs.existsSync(STAGE_DIR)) {
    if (dryRun) console.log(`[dry-run] would create staging dir: ${STAGE_DIR}`);
    else { fs.mkdirSync(STAGE_DIR, { recursive: true }); console.log(`Created staging dir: ${STAGE_DIR}`); }
  }
  const jarPath = path.join(STAGE_DIR, BOOTSTRAP_JAR);
  if (fs.existsSync(jarPath)) return jarPath;
  if (dryRun) { console.log(`[dry-run] would download bootstrap jar -> ${jarPath}`); return jarPath; }
  console.log('Downloading bootstrap jar ...');
  await downloadFile(BOOTSTRAP_URL, jarPath);
  return jarPath;
}

// --- Build -----------------------------------------------------------------

async function build({ dryRun, withConfig }) {
  const javaBin = process.env.JAVA_BIN || DEFAULT_JAVA_BIN;
  if (!dryRun && !fs.existsSync(javaBin)) {
    throw new Error(`Java not found at "${javaBin}". Set JAVA_BIN to your java executable.`);
  }

  await ensureBootstrap({ dryRun });

  const keep = keepPrefixes(withConfig);
  console.log('');
  console.log(`=== BUILD: server-side pack (${keep.join(' + ')}) ===`);
  console.log(
    withConfig
      ? 'Including config/ (one-time deploy) — excluding shaders/resource packs/options.'
      : 'mods/ only — config/ excluded (managed by hand; may contain secrets).'
  );

  if (dryRun) {
    console.log(`[dry-run] would fetch ${PACK_BASE}/pack.toml + index.toml`);
    console.log('[dry-run] would serve a trimmed pack locally and run packwiz-installer -s server');
    return STAGE_DIR;
  }

  const packToml = await fetchText(`${PACK_BASE}/pack.toml`);
  const indexToml = await fetchText(`${PACK_BASE}/index.toml`);
  const trimmedIndex = trimIndex(indexToml, keep);
  const trimmedPack = patchPackHash(packToml, sha256(trimmedIndex));

  const kept = (trimmedIndex.match(/\[\[files\]\]/g) || []).length;
  const total = (indexToml.match(/\[\[files\]\]/g) || []).length;
  console.log(`Index trimmed: ${kept}/${total} entries kept (${keep.join(' + ')}).`);

  // Local server: serve trimmed pack.toml/index.toml, redirect the rest to GitHub.
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/pack.toml') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(trimmedPack); }
    else if (url === '/index.toml') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(trimmedIndex); }
    else { res.writeHead(302, { Location: PACK_BASE + url }); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const localUrl = `http://127.0.0.1:${port}/pack.toml`;

  try {
    const args = ['-jar', BOOTSTRAP_JAR, '-g', '-s', 'server', localUrl];
    console.log(`Running: java ${args.join(' ')}`);
    console.log('');
    await new Promise((resolve, reject) => {
      const child = spawn(javaBin, args, { cwd: STAGE_DIR, stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`packwiz-installer exited with code ${code}`))
      );
    });
  } finally {
    server.close();
  }

  console.log('');
  console.log('=== BUILD complete ===');
  for (const pfx of keep) {
    const dir = pfx.replace(/\/$/, '');
    const p = path.join(STAGE_DIR, dir);
    console.log(fs.existsSync(p) ? `Staged ${dir}/ -> ${p}` : `Note: ${dir}/ not present after build.`);
  }
  console.log('');
  return STAGE_DIR;
}

module.exports = { build, STAGE_DIR };
