#!/usr/bin/env node
'use strict';

/**
 * sync.js — Mechanical Dreams server pack manager
 * ===============================================
 * Builds a server-side packwiz pack locally and pushes mods/ + config/ to a
 * remote Minecraft server over FTP (primary) or SFTP (optional).
 *
 * Usage:
 *   node sync.js --build
 *   node sync.js --upload
 *   node sync.js --build --upload [--mirror] [--dry-run]
 *   node sync.js --deploy [--dry-run]
 *   node sync.js --help
 *
 * See README.md for full docs.
 */

const fs = require('fs');
const path = require('path');

const { build, STAGE_DIR } = require('./build');
const FtpClient = require('./ftpClient');
const SftpClient = require('./sftpClient');
const { deploy } = require('./deploy');

// Directories synced to the server. config/ is only included with --with-config
// (configs can hold secrets and are otherwise managed by hand on the server).
function syncDirsFor(withConfig) {
  return withConfig ? ['mods', 'config'] : ['mods'];
}

const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
  const flags = {
    build: false,
    upload: false,
    deploy: false,
    mirror: false,
    dryRun: false,
    withConfig: false,
    help: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '--build':
        flags.build = true;
        break;
      case '--upload':
        flags.upload = true;
        break;
      case '--deploy':
        flags.deploy = true;
        break;
      case '--mirror':
        flags.mirror = true;
        break;
      case '--with-config':
        flags.withConfig = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        flags.help = true;
    }
  }
  return flags;
}

function printHelp() {
  console.log(`
Mechanical Dreams — server pack sync (FTP/SFTP)

USAGE
  node sync.js [options]

OPTIONS
  --build      Build the server-side pack into ${path.relative(process.cwd(), STAGE_DIR) || '.server-stage'}/
               (runs packwiz-installer with "-s server"; downloads the
               bootstrap jar if missing).
  --deploy     RECOMMENDED efficient path. Builds mods-only staging, then over
               SFTP/FTP uploads ONLY the changed jars as a SINGLE zip, prunes
               removed jars, and verifies. The zip is decompressed automatically
               if a panel "pterodactyl" apiKey is configured, otherwise you are
               prompted to extract it by hand (panel/WinSCP). Implies a build.
  --upload     FALLBACK path (FTP/SFTP). Upload the staged mods/ (and config/
               with --with-config) to the remote server, skipping files whose
               size + modified-time already match.
  --mirror     With --upload: delete remote files/dirs that no longer exist
               locally (true mirror of the staging dir). Destructive.
  --with-config  Include config/ in build + upload. OFF by default: configs can
               contain secrets and are managed by hand on the server, so they are
               never fetched or overwritten. Use only for a one-time initial deploy.
  --dry-run    Log every action without changing anything (local or remote).
  -h, --help   Show this help.

EXAMPLES
  node sync.js --deploy --dry-run            # preview the SFTP deploy diff
  node sync.js --deploy                      # efficient deploy (recommended)
  node sync.js --build --upload              # FTP/SFTP fallback (mods only)
  node sync.js --build --upload --mirror     # fallback + prune stale remote mods
  node sync.js --build --upload --with-config  # one-time: also push config/
  node sync.js --upload --dry-run            # preview the FTP/SFTP upload

NOTE
  Shaders, resource packs and options.txt are never fetched or uploaded.
  config/ is excluded unless --with-config is given (it may contain secrets).
  --deploy handles only mods/; use --upload --with-config for the one-time
  config push.

CONFIG
  Reads settings from config.json (gitignored).
  Copy config.example.json -> config.json and fill it in.
  Both --deploy and --upload use the FTP/SFTP fields
  (protocol, host, port, user, password, remoteBase).
  --deploy can OPTIONALLY use a "pterodactyl" block (panelUrl, apiKey, serverId)
  to auto-decompress the uploaded zip; omit it to decompress by hand.
`);
}

// --- Config ----------------------------------------------------------------

/** Read + parse config.json, stripping "//"-prefixed comment keys. */
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing config.json at ${CONFIG_PATH}.\n` +
        `Copy config.example.json to config.json and fill it in.`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  // Strip "//"-prefixed comment keys used in the example file (top level and
  // one level deep, e.g. inside any nested object).
  const cfg = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('//')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = {};
      for (const [ik, iv] of Object.entries(v)) {
        if (!ik.startsWith('//')) inner[ik] = iv;
      }
      cfg[k] = inner;
    } else {
      cfg[k] = v;
    }
  }
  return cfg;
}

/** Validate + normalize the FTP/SFTP config used by the --upload path. */
function loadConfig() {
  const cfg = readConfig();

  if (!cfg.host) throw new Error('config.json: "host" is required.');
  if (!cfg.user) throw new Error('config.json: "user" is required.');
  if (cfg.password === undefined)
    throw new Error('config.json: "password" is required.');

  cfg.protocol = (cfg.protocol || 'ftp').toLowerCase();
  if (cfg.protocol !== 'ftp' && cfg.protocol !== 'sftp') {
    throw new Error(`config.json: "protocol" must be "ftp" or "sftp".`);
  }
  if (!cfg.remoteBase) cfg.remoteBase = '/';
  return cfg;
}

// --- Path helpers ----------------------------------------------------------

/** Join remote path segments with forward slashes (FTP/SFTP are POSIX). */
function remoteJoin(...parts) {
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/+/g, '/'); // collapse duplicate slashes
  return joined.startsWith('/') ? joined : '/' + joined;
}

/**
 * Recursively walk a local directory, yielding files relative to `base`.
 * @param {string} base   absolute root to make paths relative to
 * @param {string} dir    absolute dir currently being walked
 * @returns {Array<{rel:string, abs:string, size:number, mtime:Date}>}
 */
function walkLocal(base, dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkLocal(base, abs));
    } else if (entry.isFile()) {
      const st = fs.statSync(abs);
      out.push({
        rel: path.relative(base, abs).split(path.sep).join('/'),
        abs,
        size: st.size,
        mtime: st.mtime,
      });
    }
  }
  return out;
}

/**
 * Decide whether a local file needs uploading vs the remote entry.
 * Skip when size matches AND the remote mtime is not older than local.
 * (FTP modified-time granularity is coarse, so we treat remote >= local as
 * up to date; any size mismatch always forces an upload.)
 */
function needsUpload(local, remote) {
  if (!remote) return true;
  if (remote.size !== local.size) return true;
  if (!remote.modifiedAt) return true; // unknown remote time -> be safe
  // Allow 2s slack for filesystem/timezone rounding.
  const remoteMs = remote.modifiedAt.getTime();
  const localMs = local.mtime.getTime();
  return remoteMs + 2000 < localMs;
}

// --- Upload / sync ---------------------------------------------------------

/**
 * Build a flat map of remote files (rel path -> RemoteEntry) under a remote
 * root by walking it recursively. Missing dirs yield an empty map.
 */
async function listRemoteRecursive(client, remoteRoot, relPrefix, acc) {
  const entries = await client.list(remoteRoot);
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      acc.dirs.add(rel);
      await listRemoteRecursive(
        client,
        remoteJoin(remoteRoot, e.name),
        rel,
        acc
      );
    } else {
      acc.files.set(rel, e);
    }
  }
  return acc;
}

async function upload(cfg, flags) {
  const { dryRun, mirror, withConfig } = flags;
  const SYNC_DIRS = syncDirsFor(withConfig);

  // Sanity: make sure something was built.
  const haveStage = SYNC_DIRS.some((d) =>
    fs.existsSync(path.join(STAGE_DIR, d))
  );
  if (!haveStage) {
    throw new Error(
      `Nothing to upload: no ${SYNC_DIRS.join('/ or ')}/ found in ${STAGE_DIR}.\n` +
        `Run with --build first.`
    );
  }

  const ClientClass = cfg.protocol === 'sftp' ? SftpClient : FtpClient;
  const client = new ClientClass(cfg);

  const counts = { uploaded: 0, skipped: 0, deleted: 0, deletedDirs: 0 };

  console.log('');
  console.log('=== UPLOAD ===');
  console.log(`protocol  : ${cfg.protocol}`);
  console.log(`host      : ${cfg.host}:${cfg.port || (cfg.protocol === 'sftp' ? 2022 : 21)}`);
  console.log(`remoteBase: ${cfg.remoteBase}`);
  console.log(`dirs      : ${SYNC_DIRS.join(', ')}${withConfig ? '' : '  (config/ excluded — managed by hand)'}`);
  console.log(`mirror    : ${mirror ? 'ON (will delete stale remote files)' : 'off'}`);
  console.log(`dry-run   : ${dryRun ? 'ON' : 'off'}`);
  console.log('');

  if (dryRun) {
    console.log('[dry-run] not connecting to the server.');
  } else {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected.');
  }

  try {
    for (const dir of SYNC_DIRS) {
      const localDir = path.join(STAGE_DIR, dir);
      if (!fs.existsSync(localDir)) {
        console.log(`Skipping ${dir}/ (not present locally).`);
        continue;
      }

      const remoteDir = remoteJoin(cfg.remoteBase, dir);
      console.log(`\n-- Syncing ${dir}/ -> ${remoteDir}`);

      // Gather local files.
      const localFiles = walkLocal(localDir, localDir);

      // Gather remote files (empty in dry-run / when dir missing remotely).
      let remote = { files: new Map(), dirs: new Set() };
      if (!dryRun) {
        await client.ensureDir(remoteDir);
        remote = await listRemoteRecursive(
          client,
          remoteDir,
          '',
          { files: new Map(), dirs: new Set() }
        );
      }

      // Track which remote parent dirs we've ensured this run.
      const ensuredDirs = new Set();

      // Upload new/changed files.
      for (const lf of localFiles) {
        const remoteEntry = remote.files.get(lf.rel);
        const remotePath = remoteJoin(remoteDir, lf.rel);

        if (!needsUpload(lf, remoteEntry)) {
          counts.skipped++;
          continue;
        }

        // Ensure the remote subdirectory exists before uploading.
        const subdir = path.posix.dirname(lf.rel);
        if (subdir && subdir !== '.' && !ensuredDirs.has(subdir)) {
          const remoteSub = remoteJoin(remoteDir, subdir);
          if (dryRun) {
            console.log(`[dry-run] ensureDir ${remoteSub}`);
          } else {
            await client.ensureDir(remoteSub);
          }
          ensuredDirs.add(subdir);
        }

        if (dryRun) {
          const reason = remoteEntry ? 'changed' : 'new';
          console.log(`[dry-run] UPLOAD (${reason}) ${lf.rel}`);
        } else {
          await client.uploadFrom(lf.abs, remotePath);
          console.log(`  uploaded ${lf.rel}`);
        }
        counts.uploaded++;
      }

      // Mirror: delete remote files not present locally.
      if (mirror) {
        const localRelSet = new Set(localFiles.map((f) => f.rel));

        for (const [rel, _entry] of remote.files) {
          if (!localRelSet.has(rel)) {
            const remotePath = remoteJoin(remoteDir, rel);
            if (dryRun) {
              console.log(`[dry-run] DELETE ${rel}`);
            } else {
              await client.removeFile(remotePath);
              console.log(`  deleted ${rel}`);
            }
            counts.deleted++;
          }
        }

        // Remove now-empty remote directories that have no local counterpart.
        const localDirSet = new Set();
        for (const f of localFiles) {
          let d = path.posix.dirname(f.rel);
          while (d && d !== '.' && d !== '/') {
            localDirSet.add(d);
            d = path.posix.dirname(d);
          }
        }
        // Delete deepest-first so parents become removable.
        const staleDirs = [...remote.dirs]
          .filter((d) => !localDirSet.has(d))
          .sort((a, b) => b.length - a.length);
        for (const d of staleDirs) {
          const remotePath = remoteJoin(remoteDir, d);
          if (dryRun) {
            console.log(`[dry-run] RMDIR ${d}`);
          } else {
            await client.removeDir(remotePath);
            console.log(`  removed dir ${d}`);
          }
          counts.deletedDirs++;
        }
      }
    }
  } finally {
    client.close();
  }

  console.log('');
  console.log('=== UPLOAD summary ===');
  console.log(`  uploaded     : ${counts.uploaded}`);
  console.log(`  skipped      : ${counts.skipped}`);
  if (mirror) {
    console.log(`  deleted files: ${counts.deleted}`);
    console.log(`  removed dirs : ${counts.deletedDirs}`);
  }
  if (dryRun) console.log('  (dry-run: nothing was actually changed)');
  console.log('');
  return counts;
}

// --- Main ------------------------------------------------------------------

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  if (!flags.build && !flags.upload && !flags.deploy) {
    console.error(
      'Nothing to do. Specify --deploy, --build and/or --upload (or --help).'
    );
    printHelp();
    process.exitCode = 1;
    return;
  }

  // --- Efficient SFTP/FTP deploy (recommended). Builds mods-only staging. ---
  if (flags.deploy) {
    const cfg = loadConfig();
    await build({ dryRun: flags.dryRun, withConfig: false });
    const result = await deploy(cfg, { dryRun: flags.dryRun });
    if (!flags.dryRun && result && result.verified === false) {
      process.exitCode = 1;
    }
    return;
  }

  // --- FTP/SFTP fallback path -------------------------------------------------
  if (flags.build) {
    await build({ dryRun: flags.dryRun, withConfig: flags.withConfig });
  }

  if (flags.upload) {
    const cfg = loadConfig();
    await upload(cfg, flags);
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
