'use strict';

/**
 * deploy.js
 * ---------
 * The efficient `--deploy` path. Instead of transferring ~100 jars one by one
 * over FTP/SFTP, it:
 *
 *   1. Builds the mods-only staging dir (.server-stage/mods/).
 *   2. Hashes every staged jar (sha256) -> the REQUIRED set.
 *   3. Loads .deployed.json (the local manifest of what we last deployed).
 *   4. Lists the remote mods/ dir via the Pterodactyl client API (drift check).
 *   5. Diffs to get toUpload (changed/new/missing-on-server) and toRemove.
 *   6. Zips ONLY the changed jars (flat) and uploads that single zip, then asks
 *      the panel to decompress it into mods/, then deletes the remote zip.
 *   7. Deletes the toRemove jars remotely (batch).
 *   8. Writes .deployed.json = REQUIRED.
 *   9. Re-lists remote mods/ and verifies presence + size for every required
 *      jar. Prints a summary.
 *
 * Remote files cannot be hashed by FTP or the Pterodactyl API, so the hash-diff
 * relies on the local manifest (.deployed.json) plus remote-size verification.
 *
 * --dry-run computes and prints the full diff + planned actions and changes
 * NOTHING: it does not upload, decompress, delete, or write the manifest. It
 * will still LIST the remote dir read-only when credentials are present (so the
 * drift detection is accurate); if that read fails or is skipped it falls back
 * to an empty remote listing and says so.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const { build, STAGE_DIR } = require('./build');
const PteroClient = require('./pteroClient');

const MODS_STAGE = path.join(STAGE_DIR, 'mods');
const MANIFEST_PATH = path.join(__dirname, '.deployed.json');
const UPLOAD_ZIP_PATH = path.join(STAGE_DIR, '_upload.zip');
const UPLOAD_ZIP_NAME = '_upload.zip';

// --- Hashing / manifest ----------------------------------------------------

/** sha256 of a file's bytes, hex. */
function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(absPath));
  return hash.digest('hex');
}

/**
 * Build the REQUIRED set: every .jar in .server-stage/mods/ -> sha256.
 * @returns {{ hashes: Object<string,string>, sizes: Object<string,number> }}
 */
function hashStagedJars() {
  const hashes = {};
  const sizes = {};
  if (!fs.existsSync(MODS_STAGE)) {
    throw new Error(
      `No staged mods at ${MODS_STAGE}. The build step must run first.`
    );
  }
  for (const entry of fs.readdirSync(MODS_STAGE, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.jar')) continue;
    const abs = path.join(MODS_STAGE, entry.name);
    hashes[entry.name] = sha256File(abs);
    sizes[entry.name] = fs.statSync(abs).size;
  }
  return { hashes, sizes };
}

/** Load the local deploy manifest; missing or invalid => {} (first deploy). */
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    console.warn(
      `Warning: .deployed.json is not valid JSON (${err.message}); treating as empty.`
    );
    return {};
  }
}

function writeManifest(required) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(required, null, 2) + '\n');
}

// --- Diff ------------------------------------------------------------------

/**
 * Compute the deploy diff.
 * @param {Object<string,string>} required filename -> sha256 (staged)
 * @param {Object<string,string>} deployed filename -> sha256 (.deployed.json)
 * @param {Set<string>} remoteNames jar names currently on the server
 * @returns {{ toUpload:string[], toRemove:string[], unchanged:string[] }}
 */
function computeDiff(required, deployed, remoteNames) {
  const toUpload = [];
  const unchanged = [];

  for (const name of Object.keys(required)) {
    const changed = required[name] !== deployed[name]; // also true if not in deployed
    const missingOnServer = !remoteNames.has(name);
    if (changed || missingOnServer) toUpload.push(name);
    else unchanged.push(name);
  }

  // Anything we previously deployed OR that is sitting on the server, but is no
  // longer required, should be pruned.
  const removeSet = new Set();
  for (const name of Object.keys(deployed)) {
    if (!(name in required)) removeSet.add(name);
  }
  for (const name of remoteNames) {
    if (!(name in required)) removeSet.add(name);
  }

  return {
    toUpload: toUpload.sort(),
    toRemove: [...removeSet].sort(),
    unchanged: unchanged.sort(),
  };
}

// --- Zip -------------------------------------------------------------------

/**
 * Zip the named jars (flat, no parent dirs) from .server-stage/mods/ into
 * UPLOAD_ZIP_PATH. Resolves with the byte size of the resulting zip.
 * @param {string[]} names jar basenames to include
 * @returns {Promise<number>}
 */
function zipJars(names) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(UPLOAD_ZIP_PATH);
    // STORE (no compression): jars are already ZIP-compressed, so recompressing
    // wastes large amounts of CPU for ~0 size gain. Store mode zips near-instantly.
    const archive = archiver('zip', { store: true });

    output.on('close', () => resolve(archive.pointer()));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') console.warn(`zip warning: ${err.message}`);
      else reject(err);
    });

    archive.pipe(output);
    for (const name of names) {
      const abs = path.join(MODS_STAGE, name);
      archive.file(abs, { name }); // flat: store under basename only
    }
    archive.finalize();
  });
}

// --- Deploy ----------------------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Run the full deploy.
 * @param {object} pteroCfg pterodactyl config block
 * @param {object} flags { dryRun }
 */
async function deploy(pteroCfg, flags) {
  const dryRun = !!flags.dryRun;
  const remoteModsDir = pteroCfg.remoteModsDir || 'mods';

  console.log('');
  console.log('=== DEPLOY (Pterodactyl API, zip + decompress) ===');
  console.log(`panel    : ${pteroCfg.panelUrl}`);
  console.log(`server   : ${pteroCfg.serverId}`);
  console.log(`mods dir : ${PteroClient.normalizeDir(remoteModsDir)}`);
  console.log(`dry-run  : ${dryRun ? 'ON (no remote changes)' : 'off'}`);
  console.log('');

  // 2. REQUIRED set.
  const { hashes: required, sizes: localSizes } = hashStagedJars();
  const requiredCount = Object.keys(required).length;
  console.log(`Staged jars (required): ${requiredCount}`);

  // 3. Local manifest.
  const deployed = loadManifest();
  console.log(`Last deployed manifest : ${Object.keys(deployed).length} jar(s)`);

  // 4. Remote listing (drift detection). Read-only — safe in dry-run too.
  const client = new PteroClient(pteroCfg);
  let remoteEntries = [];
  let remoteListed = false;
  try {
    remoteEntries = await client.list(remoteModsDir);
    remoteListed = true;
  } catch (err) {
    if (dryRun) {
      console.warn(
        `[dry-run] Could not list remote mods/ (${err.message}). ` +
          `Proceeding with an EMPTY remote listing for the preview.`
      );
    } else {
      throw err;
    }
  }
  const remoteJars = remoteEntries.filter(
    (e) => e.isFile && e.name.toLowerCase().endsWith('.jar')
  );
  const remoteNames = new Set(remoteJars.map((e) => e.name));
  const remoteSizes = new Map(remoteJars.map((e) => [e.name, e.size]));
  console.log(
    `Remote jars on server  : ${
      remoteListed ? remoteNames.size : 'unknown (not listed)'
    }`
  );

  // 5. DIFF.
  const { toUpload, toRemove, unchanged } = computeDiff(
    required,
    deployed,
    remoteNames
  );

  console.log('');
  console.log('--- DIFF ---');
  console.log(`  to upload : ${toUpload.length}`);
  for (const n of toUpload) {
    const reason = !(n in deployed)
      ? 'new'
      : required[n] !== deployed[n]
      ? 'changed'
      : 'missing-on-server';
    console.log(`      + ${n} (${reason})`);
  }
  console.log(`  to remove : ${toRemove.length}`);
  for (const n of toRemove) console.log(`      - ${n}`);
  console.log(`  unchanged : ${unchanged.length}`);
  console.log('');

  if (dryRun) {
    console.log('[dry-run] Planned actions (NOTHING is executed):');
    if (toUpload.length) {
      console.log(
        `[dry-run]   1. zip ${toUpload.length} jar(s) -> ${UPLOAD_ZIP_NAME}, upload to ` +
          `${PteroClient.normalizeDir(remoteModsDir)}, decompress, delete the zip.`
      );
    } else {
      console.log('[dry-run]   1. (no uploads — nothing changed)');
    }
    if (toRemove.length) {
      console.log(`[dry-run]   2. delete ${toRemove.length} remote jar(s).`);
    } else {
      console.log('[dry-run]   2. (no deletions)');
    }
    console.log('[dry-run]   3. write .deployed.json with the required set.');
    console.log('[dry-run]   4. re-list + verify presence/size.');
    console.log('');
    console.log('=== DEPLOY summary (dry-run) ===');
    console.log(`  would upload   : ${toUpload.length}`);
    console.log(`  would remove   : ${toRemove.length}`);
    console.log(`  unchanged      : ${unchanged.length}`);
    console.log('  (dry-run: nothing was changed; manifest not written)');
    console.log('');
    return { toUpload, toRemove, unchanged, verified: null, dryRun: true };
  }

  // 6. Upload changed jars as ONE zip, then decompress, then remove the zip.
  if (toUpload.length) {
    console.log(`Zipping ${toUpload.length} jar(s) -> ${UPLOAD_ZIP_PATH} ...`);
    const zipSize = await zipJars(toUpload);
    console.log(`Zip built: ${fmtBytes(zipSize)}.`);
    try {
      console.log('Uploading zip ...');
      await client.uploadZip(UPLOAD_ZIP_PATH, remoteModsDir);
      console.log('Decompressing on server ...');
      await client.decompress(remoteModsDir, UPLOAD_ZIP_NAME);
      console.log('Removing remote zip ...');
      await client.deleteFiles(remoteModsDir, [UPLOAD_ZIP_NAME]);
    } finally {
      // Clean up the local temp zip regardless of outcome.
      fs.rmSync(UPLOAD_ZIP_PATH, { force: true });
    }
    console.log('Upload + extract complete.');
  } else {
    console.log('No jars to upload.');
  }

  // 7. Prune removed jars.
  if (toRemove.length) {
    console.log(`Deleting ${toRemove.length} stale remote jar(s) ...`);
    await client.deleteFiles(remoteModsDir, toRemove);
    console.log('Deletions complete.');
  } else {
    console.log('No jars to remove.');
  }

  // 8. Update the manifest.
  writeManifest(required);
  console.log('Wrote .deployed.json.');

  // 9. VERIFY.
  console.log('Verifying remote mods/ ...');
  let verifyOk = true;
  let verifiedRemote = [];
  try {
    verifiedRemote = await client.list(remoteModsDir);
  } catch (err) {
    console.warn(`Warning: verification listing failed: ${err.message}`);
    verifyOk = false;
  }
  const verifiedJars = new Map(
    verifiedRemote
      .filter((e) => e.isFile)
      .map((e) => [e.name, e.size])
  );
  let missing = 0;
  let sizeMismatch = 0;
  for (const name of Object.keys(required)) {
    if (!verifiedJars.has(name)) {
      console.warn(`  ! MISSING on server after deploy: ${name}`);
      missing++;
      verifyOk = false;
      continue;
    }
    const remoteSize = verifiedJars.get(name);
    const localSize = localSizes[name];
    if (typeof remoteSize === 'number' && remoteSize !== localSize) {
      console.warn(
        `  ! SIZE MISMATCH ${name}: local ${localSize} B, remote ${remoteSize} B`
      );
      sizeMismatch++;
      verifyOk = false;
    }
  }

  console.log('');
  console.log('=== DEPLOY summary ===');
  console.log(`  uploaded   : ${toUpload.length}`);
  console.log(`  removed    : ${toRemove.length}`);
  console.log(`  unchanged  : ${unchanged.length}`);
  console.log(
    `  verified   : ${
      verifyOk
        ? 'OK'
        : `FAILED (${missing} missing, ${sizeMismatch} size mismatch)`
    }`
  );
  console.log('');

  return { toUpload, toRemove, unchanged, verified: verifyOk, dryRun: false };
}

module.exports = {
  deploy,
  // exported for unit-testing the pure logic
  computeDiff,
  hashStagedJars,
  loadManifest,
  zipJars,
  MANIFEST_PATH,
  UPLOAD_ZIP_PATH,
  UPLOAD_ZIP_NAME,
};
