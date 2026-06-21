'use strict';

/**
 * deploy.js
 * ---------
 * The efficient `--deploy` path. Instead of re-walking and re-uploading every
 * jar like `--upload` does, it tracks what was last deployed and ships only
 * what changed as a SINGLE zip over SFTP (or FTP):
 *
 *   1. Builds the mods-only staging dir (.server-stage/mods/).
 *   2. Hashes every staged jar (sha256) -> the REQUIRED set.
 *   3. Loads .deployed.json (the local manifest of what we last deployed).
 *   4. Lists the remote mods/ dir over SFTP/FTP (drift check).
 *   5. Diffs to get toUpload (changed/new/missing-on-server) and toRemove.
 *   6. Zips ONLY the changed jars (flat, STORE/no-recompress) and uploads that
 *      one archive over SFTP/FTP (single transfer, with a progress bar).
 *   7. Decompresses it into mods/ — automatically via the Pterodactyl client
 *      API IF an apiKey is configured, otherwise by PROMPTING the user to
 *      extract it by hand (panel File Manager or WinSCP) and waiting. Then the
 *      remote zip is removed.
 *   8. Deletes the toRemove jars remotely.
 *   9. Re-lists remote mods/ and verifies presence + size; writes
 *      .deployed.json only when verification passes.
 *
 * Remote files cannot be hashed over SFTP/FTP, so the hash-diff relies on the
 * local manifest (.deployed.json) plus remote-size verification.
 *
 * --dry-run computes and prints the full diff + planned actions and changes
 * NOTHING: it does not zip, upload, decompress, delete, or write the manifest.
 * It will still connect and LIST the remote dir read-only when credentials are
 * present (so the drift detection is accurate); if that read fails or is
 * skipped it falls back to an empty remote listing and says so.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const archiver = require('archiver');

const { STAGE_DIR } = require('./build');
const FtpClient = require('./ftpClient');
const SftpClient = require('./sftpClient');
const { getPteroApi } = require('./pteroApi');

const MODS_STAGE = path.join(STAGE_DIR, 'mods');
const MANIFEST_PATH = path.join(__dirname, '.deployed.json');
const UPLOAD_ZIP_PATH = path.join(STAGE_DIR, '_upload.zip');
const UPLOAD_ZIP_NAME = '_upload.zip';

// --- Path helper -----------------------------------------------------------

/** Join remote path segments with forward slashes (SFTP/FTP are POSIX). */
function remoteJoin(...parts) {
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/+/g, '/');
  return joined.startsWith('/') ? joined : '/' + joined;
}

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
 * Decide whether (and why) a required jar must be uploaded. Returns a short
 * reason string when an upload is needed, or null when the remote copy is
 * already correct.
 *
 * The remote listing is authoritative for "is it already there": a jar that
 * exists on the server at the right SIZE is treated as up to date, even when
 * the local .deployed.json manifest is missing or stale. (Mod jar filenames are
 * version-stamped, so same name + same size means same bytes in practice.) The
 * manifest only adds one extra signal — if it records that we last deployed a
 * DIFFERENT build of this exact filename, re-upload even if the size happens to
 * match. This is what stops an empty manifest from re-uploading every jar that
 * is already on the server.
 */
function uploadReason(name, required, deployed, remoteNames, localSizes, remoteSizes) {
  if (!remoteNames.has(name)) return 'missing-on-server';
  // Wrong size on the server -> truncated/corrupt/older build; re-send.
  if (remoteSizes.has(name) && remoteSizes.get(name) !== localSizes[name]) {
    return 'size-mismatch';
  }
  // Present at the right size, but the manifest says we last deployed different
  // bytes under this name (rare: same size, different content).
  if (name in deployed && deployed[name] !== required[name]) return 'changed';
  return null;
}

/**
 * Compute the deploy diff.
 * @param {Object<string,string>} required filename -> sha256 (staged)
 * @param {Object<string,string>} deployed filename -> sha256 (.deployed.json)
 * @param {Set<string>} remoteNames jar names currently on the server
 * @returns {{ toUpload:string[], toRemove:string[], unchanged:string[] }}
 */
function computeDiff(required, deployed, remoteNames, localSizes, remoteSizes) {
  const toUpload = [];
  const unchanged = [];
  localSizes = localSizes || {};
  remoteSizes = remoteSizes || new Map();

  for (const name of Object.keys(required)) {
    const reason = uploadReason(
      name,
      required,
      deployed,
      remoteNames,
      localSizes,
      remoteSizes
    );
    if (reason) toUpload.push(name);
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

// --- Deploy ----------------------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Zip the named jars (flat, no parent dirs) from .server-stage/mods/ into
 * UPLOAD_ZIP_PATH. STORE mode (no compression): jars are already ZIP-compressed,
 * so recompressing wastes CPU for ~0 size gain. Resolves with the zip byte size.
 */
function zipJars(names) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(UPLOAD_ZIP_PATH);
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
      archive.file(path.join(MODS_STAGE, name), { name }); // flat: basename only
    }
    archive.finalize();
  });
}

/**
 * Build a throttled progress callback that renders a single in-place updating
 * line: " 42%  88.0 MiB/210.0 MiB". Returns the callback; call done() to cap it
 * at 100% and move to a new line.
 */
function makeProgress(total) {
  let last = 0;
  const render = (transferred) => {
    const pct = total ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
    process.stdout.write(
      `\r  ${String(pct).padStart(3)}%  ${fmtBytes(transferred)}/${fmtBytes(total)}      `
    );
  };
  const cb = (transferred) => {
    const now = Date.now();
    if (now - last < 200 && transferred < total) return;
    last = now;
    render(transferred);
  };
  cb.done = () => {
    render(total);
    process.stdout.write('\n');
  };
  return cb;
}

/** Resolve when the user presses Enter. Errors out on a non-interactive shell. */
function waitForEnter(promptText) {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Manual decompression is required, but this shell is non-interactive.\n' +
        `Extract ${UPLOAD_ZIP_NAME} into the server's mods/ by hand, then re-run --deploy to verify.`
    );
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

/** Print manual-decompress instructions and block until the user confirms. */
async function promptManualDecompress(remoteModsDir, count, zipSize) {
  console.log('');
  console.log('================= MANUAL STEP REQUIRED =================');
  console.log(
    `Uploaded ${UPLOAD_ZIP_NAME} (${count} jar(s), ${fmtBytes(zipSize)}) to ${remoteModsDir}.`
  );
  console.log('No panel API key is configured, so this script cannot extract it for you.');
  console.log('');
  console.log('Decompress it on the server now — either:');
  console.log(
    `  - Pterodactyl panel: File Manager -> ${UPLOAD_ZIP_NAME} -> row menu -> Decompress`
  );
  console.log(
    `  - WinSCP / SFTP client: extract ${UPLOAD_ZIP_NAME} into ${remoteModsDir}/ (overwrite)`
  );
  console.log('');
  await waitForEnter('Press ENTER once the archive is extracted (Ctrl+C to abort) ... ');
}

/**
 * Run the full deploy over SFTP/FTP.
 * @param {object} cfg FTP/SFTP config block (protocol, host, user, password, remoteBase, ...)
 * @param {object} flags { dryRun }
 */
async function deploy(cfg, flags) {
  const dryRun = !!flags.dryRun;
  const protocol = (cfg.protocol || 'ftp').toLowerCase();
  const ClientClass = protocol === 'sftp' ? SftpClient : FtpClient;
  const remoteModsDir = remoteJoin(cfg.remoteBase || '/', 'mods');
  const api = getPteroApi(cfg);

  console.log('');
  console.log('=== DEPLOY (SFTP/FTP, single zip of changed jars) ===');
  console.log(`protocol  : ${protocol}`);
  console.log(`host      : ${cfg.host}:${cfg.port || (protocol === 'sftp' ? 2022 : 21)}`);
  console.log(`mods dir  : ${remoteModsDir}`);
  console.log(`decompress: ${api ? 'automatic (panel API key configured)' : 'MANUAL (no API key — you will be prompted)'}`);
  console.log(`dry-run   : ${dryRun ? 'ON (no remote changes)' : 'off'}`);
  console.log('');

  // 2. REQUIRED set.
  const { hashes: required, sizes: localSizes } = hashStagedJars();
  const requiredCount = Object.keys(required).length;
  console.log(`Staged jars (required): ${requiredCount}`);

  // 3. Local manifest.
  const deployed = loadManifest();
  console.log(`Last deployed manifest : ${Object.keys(deployed).length} jar(s)`);

  const client = new ClientClass(cfg);

  try {
    // 4. Remote listing (drift detection). Read-only — safe in dry-run too.
    let remoteEntries = [];
    let remoteListed = false;
    try {
      await client.connect();
      remoteEntries = await client.list(remoteModsDir);
      remoteListed = true;
    } catch (err) {
      if (dryRun) {
        console.warn(
          `[dry-run] Could not connect/list remote mods/ (${err.message}). ` +
            `Proceeding with an EMPTY remote listing for the preview.`
        );
      } else {
        throw err;
      }
    }
    const remoteJars = remoteEntries.filter(
      (e) => !e.isDirectory && e.name.toLowerCase().endsWith('.jar')
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
      remoteNames,
      localSizes,
      remoteSizes
    );

    console.log('');
    console.log('--- DIFF ---');
    console.log(`  to upload : ${toUpload.length}`);
    for (const n of toUpload) {
      const reason =
        uploadReason(n, required, deployed, remoteNames, localSizes, remoteSizes) ||
        'changed';
      console.log(`      + ${n} (${reason})`);
    }
    console.log(`  to remove : ${toRemove.length}`);
    for (const n of toRemove) console.log(`      - ${n}`);
    console.log(`  unchanged : ${unchanged.length}`);
    console.log('');

    if (dryRun) {
      const wouldBytes = toUpload.reduce((s, n) => s + (localSizes[n] || 0), 0);
      console.log('[dry-run] Planned actions (NOTHING is executed):');
      if (toUpload.length) {
        console.log(
          `[dry-run]   1. zip ${toUpload.length} jar(s) (${fmtBytes(wouldBytes)}) -> ${UPLOAD_ZIP_NAME}, ` +
            `upload to ${remoteModsDir}.`
        );
        console.log(
          `[dry-run]   2. ${
            api
              ? 'decompress via panel API, then delete the remote zip.'
              : 'PROMPT you to decompress it by hand, then delete the remote zip.'
          }`
        );
      } else {
        console.log('[dry-run]   1. (no uploads — nothing changed)');
        console.log('[dry-run]   2. (no decompress step)');
      }
      if (toRemove.length) {
        console.log(`[dry-run]   3. delete ${toRemove.length} stale remote jar(s).`);
      } else {
        console.log('[dry-run]   3. (no deletions)');
      }
      console.log('[dry-run]   4. re-list + verify presence/size.');
      console.log('[dry-run]   5. write .deployed.json if verification passes.');
      console.log('');
      console.log('=== DEPLOY summary (dry-run) ===');
      console.log(`  would upload   : ${toUpload.length}`);
      console.log(`  would remove   : ${toRemove.length}`);
      console.log(`  unchanged      : ${unchanged.length}`);
      console.log('  (dry-run: nothing was changed; manifest not written)');
      console.log('');
      return { toUpload, toRemove, unchanged, verified: null, dryRun: true };
    }

    // 6/7. Zip the changed jars, upload the single archive, then decompress.
    if (toUpload.length) {
      await client.ensureDir(remoteModsDir);
      const totalBytes = toUpload.reduce((s, n) => s + (localSizes[n] || 0), 0);
      console.log(
        `Zipping ${toUpload.length} jar(s) (${fmtBytes(totalBytes)}) -> ${UPLOAD_ZIP_NAME} (store mode) ...`
      );
      const zipSize = await zipJars(toUpload);
      console.log(`Zip built: ${fmtBytes(zipSize)}.`);

      const remoteZip = remoteJoin(remoteModsDir, UPLOAD_ZIP_NAME);
      try {
        console.log(`Uploading ${UPLOAD_ZIP_NAME} -> ${remoteModsDir} ...`);
        const progress = makeProgress(zipSize);
        await client.uploadFrom(UPLOAD_ZIP_PATH, remoteZip, progress);
        progress.done();
        console.log('Upload complete.');
      } finally {
        fs.rmSync(UPLOAD_ZIP_PATH, { force: true });
      }

      // Decompress: automated via API when configured, else manual prompt.
      if (api) {
        console.log('Decompressing on server via panel API ...');
        await api.decompress(remoteModsDir, UPLOAD_ZIP_NAME);
        await api.deleteFiles(remoteModsDir, [UPLOAD_ZIP_NAME]);
        console.log('Decompressed and removed the remote zip.');
      } else {
        await promptManualDecompress(remoteModsDir, toUpload.length, zipSize);
        // The user has extracted it; clean up the remote zip over SFTP/FTP.
        try {
          await client.removeFile(remoteZip);
          console.log(`Removed ${remoteZip}.`);
        } catch (err) {
          console.warn(
            `Could not delete the remote zip (${err.message}); delete ${UPLOAD_ZIP_NAME} by hand.`
          );
        }
      }
    } else {
      console.log('No jars to upload.');
    }

    // 8. Prune removed jars (always automatable over SFTP/FTP).
    if (toRemove.length) {
      console.log(`Deleting ${toRemove.length} stale remote jar(s) ...`);
      for (const name of toRemove) {
        await client.removeFile(remoteJoin(remoteModsDir, name));
        console.log(`  deleted ${name}`);
      }
      console.log('Deletions complete.');
    } else {
      console.log('No jars to remove.');
    }

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
        .filter((e) => !e.isDirectory)
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

    // Only record the manifest when the server actually matches what we built —
    // important for the manual path, where extraction might have been skipped.
    if (verifyOk) {
      writeManifest(required);
      console.log('Wrote .deployed.json.');
    } else {
      console.warn('Verification failed — NOT writing .deployed.json (re-run to retry).');
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
  } finally {
    client.close();
  }
}

module.exports = {
  deploy,
  // exported for unit-testing the pure logic
  computeDiff,
  hashStagedJars,
  loadManifest,
  MANIFEST_PATH,
};
