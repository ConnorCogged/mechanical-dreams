'use strict';

/**
 * build.js
 * --------
 * Runs the packwiz-installer against the published pack.toml to produce a
 * SERVER-SIDE pack (mods/ + config/, excluding client-only mods) inside a
 * local staging directory. Downloads the bootstrap jar if it is missing.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

// --- Constants -------------------------------------------------------------

// Java 21 location given by the maintainer. Override with JAVA_BIN env var.
const DEFAULT_JAVA_BIN =
  'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.7.6-hotspot\\bin\\java.exe';

// Published pack manifest (GitHub Pages).
const PACK_URL =
  'https://connorcogged.github.io/mechanical-dreams/pack.toml';

// packwiz-installer-bootstrap release jar.
const BOOTSTRAP_URL =
  'https://github.com/packwiz/packwiz-installer-bootstrap/releases/download/v0.0.3/packwiz-installer-bootstrap.jar';

const BOOTSTRAP_JAR = 'packwiz-installer-bootstrap.jar';

// Staging dir lives next to this script: tools/ftp-sync/.server-stage/
const STAGE_DIR = path.join(__dirname, '.server-stage');

// --- Helpers ---------------------------------------------------------------

/**
 * Download a URL to a local file, following GitHub redirects.
 * @param {string} url
 * @param {string} dest
 * @returns {Promise<void>}
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    const request = (currentUrl, redirectsLeft) => {
      https
        .get(currentUrl, (res) => {
          // Follow redirects (GitHub release assets redirect to S3/objects).
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirectsLeft === 0) {
              reject(new Error('Too many redirects downloading ' + url));
              return;
            }
            res.resume(); // discard body
            request(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Download failed (${res.statusCode}) for ${currentUrl}`
              )
            );
            res.resume();
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        })
        .on('error', (err) => {
          fs.unlink(dest, () => reject(err));
        });
    };

    request(url, 5);
  });
}

/**
 * Ensure the staging directory and bootstrap jar exist.
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @returns {Promise<string>} path to the bootstrap jar
 */
async function ensureBootstrap({ dryRun }) {
  if (!fs.existsSync(STAGE_DIR)) {
    if (dryRun) {
      console.log(`[dry-run] would create staging dir: ${STAGE_DIR}`);
    } else {
      fs.mkdirSync(STAGE_DIR, { recursive: true });
      console.log(`Created staging dir: ${STAGE_DIR}`);
    }
  }

  const jarPath = path.join(STAGE_DIR, BOOTSTRAP_JAR);
  if (fs.existsSync(jarPath)) {
    console.log(`Bootstrap jar present: ${jarPath}`);
    return jarPath;
  }

  if (dryRun) {
    console.log(
      `[dry-run] would download bootstrap jar from ${BOOTSTRAP_URL} -> ${jarPath}`
    );
    return jarPath;
  }

  console.log(`Downloading bootstrap jar from ${BOOTSTRAP_URL} ...`);
  await downloadFile(BOOTSTRAP_URL, jarPath);
  console.log(`Saved bootstrap jar: ${jarPath}`);
  return jarPath;
}

/**
 * Run the packwiz-installer to populate the staging dir with server-side
 * mods/ and config/.
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @returns {Promise<string>} STAGE_DIR
 */
async function build({ dryRun }) {
  const javaBin = process.env.JAVA_BIN || DEFAULT_JAVA_BIN;

  if (!dryRun && !fs.existsSync(javaBin)) {
    throw new Error(
      `Java not found at "${javaBin}". Set the JAVA_BIN env var to your java executable.`
    );
  }

  const jarPath = await ensureBootstrap({ dryRun });

  // packwiz-installer-bootstrap args:
  //   -g          : no GUI (headless / CI friendly)
  //   -s server   : download the "server" side set (server + universal mods)
  //   <pack url>  : the manifest to install from
  const args = [
    '-jar',
    BOOTSTRAP_JAR, // relative to cwd (STAGE_DIR) so output lands in the stage
    '-g',
    '-s',
    'server',
    PACK_URL,
  ];

  console.log('');
  console.log('=== BUILD: packwiz-installer (server side) ===');
  console.log(`java: ${javaBin}`);
  console.log(`cwd : ${STAGE_DIR}`);
  console.log(`cmd : java ${args.join(' ')}`);

  if (dryRun) {
    console.log('[dry-run] skipping actual packwiz-installer execution.');
    console.log(
      '[dry-run] (mods/ and config/ would be (re)generated under the staging dir)'
    );
    return STAGE_DIR;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(javaBin, args, {
      cwd: STAGE_DIR,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`packwiz-installer exited with code ${code}`));
    });
  });

  console.log('=== BUILD complete ===');
  console.log('');

  // Report what we produced.
  for (const dir of ['mods', 'config']) {
    const p = path.join(STAGE_DIR, dir);
    if (fs.existsSync(p)) {
      console.log(`Staged ${dir}/ -> ${p}`);
    } else {
      console.log(`Note: ${dir}/ not present after build (pack may not ship it).`);
    }
  }

  return STAGE_DIR;
}

module.exports = { build, STAGE_DIR };
