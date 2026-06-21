# ftp-sync — Mechanical Dreams server pack manager

A small Node.js CLI that builds the **server-side** packwiz pack locally and
pushes the `mods/` to a dedicated Minecraft server over **SFTP** (or FTP). It
supports two paths:

- **`--deploy` (recommended, efficient)** — zips only the **changed** jars
  (tracked via a local manifest) and uploads that **single archive** over
  SFTP/FTP, then decompresses it — automatically via the panel API if a key is
  configured, otherwise by **prompting you to extract it by hand** (panel File
  Manager or WinSCP). Prunes removed jars and verifies. Skips the ~95% of jars
  that didn't change between deploys.
- **`--upload` (fallback)** — full per-file **FTP**/**SFTP** sync that re-walks
  the whole staging dir, skipping files whose size + mtime already match. Fully
  automated (no decompress step), good when only a few files changed.

This exists because the server runs on a Pterodactyl panel with a **locked
startup command** — packwiz cannot run on server boot — so the server's mods
must be pushed from the maintainer's PC instead.

- Pack: *Mechanical Dreams* (NeoForge 1.21.1, packwiz)
- Manifest: https://connorcogged.github.io/mechanical-dreams/pack.toml

---

## How it works

1. **Build** — runs `packwiz-installer-bootstrap.jar -g -s server <pack url>`
   inside a local staging dir (`.server-stage/`). This downloads **only
   server-side + universal** mods (client-only mods are excluded) into
   `.server-stage/mods/` (config/ only with `--with-config`). The bootstrap jar
   is auto-downloaded into the staging dir if missing.
2a. **Deploy (recommended)** — hashes every staged jar (sha256), diffs against a
   local manifest (`.deployed.json`) **and** a live listing of the remote
   `mods/` directory, then **zips only the changed/new/missing jars** (flat,
   STORE/no-recompress) and uploads that one archive over SFTP/FTP. It then
   decompresses the zip into `mods/` — via the panel client API if an `apiKey`
   is set, otherwise by prompting you to extract it by hand and waiting —
   removes the remote zip, prunes jars no longer required, re-lists `mods/` to
   verify presence + size, and writes the manifest only if verification passes.
2b. **Upload (fallback)** — connects via FTP/SFTP and syncs the staged `mods/`
   to the server: uploads new/changed files (compared by **size** and
   **modified-time**, skipping unchanged ones), and with `--mirror` deletes
   remote files/dirs that no longer exist locally.

> **Note on hashing.** SFTP/FTP cannot hash remote files. The deploy diff
> therefore relies on the local `.deployed.json` manifest (what we last
> deployed) plus **remote size** verification after upload. If you lose
> `.deployed.json`, the next deploy treats every jar as new and re-uploads
> them — correct, just less efficient that one time.

---

## Requirements

- **Node.js** 18+ (developed on v24).
- **Java 21** — defaults to
  `C:\Program Files\Eclipse Adoptium\jdk-21.0.7.6-hotspot\bin\java.exe`.
  Override with the `JAVA_BIN` environment variable if your path differs.

---

## Setup

```sh
cd tools/ftp-sync
npm install
cp config.example.json config.json   # then edit config.json
```

`config.json` is **gitignored** — it holds your credentials and is never
committed.

---

## Config fields (`config.json`)

### FTP/SFTP fields — used by **both** `--deploy` and `--upload`

| Field        | Type    | Notes |
|--------------|---------|-------|
| `protocol`   | string  | `"sftp"` (default; Pterodactyl) or `"ftp"`. |
| `host`       | string  | Hostname/IP, no protocol prefix. **Required.** |
| `port`       | number  | SFTP: usually `2022`. FTP: usually `21`. |
| `user`       | string  | Username. **Required.** Pterodactyl SFTP usernames look like `user.serverid`. |
| `password`   | string  | Password. **Required.** Never commit it. |
| `secure`     | boolean | **FTP only.** `true` = explicit FTPS (FTP over TLS); `false` = plain FTP. Ignored for SFTP. |
| `remoteBase` | string  | Remote directory the pack lives in; `mods/` is synced under it. Typically `"/"` (the server root on Pterodactyl). |
| `concurrency`| number  | `--upload` only: parallel connections. Default `4`. |
| `compress`   | boolean | **SFTP only.** SSH transport compression. Default `false` (jars are already compressed). |

### `pterodactyl` block — OPTIONAL, used by `--deploy`

| Field      | Type   | Notes |
|------------|--------|-------|
| `panelUrl` | string | Base URL of your panel, no trailing slash, e.g. `"https://panel.your-host.net"`. |
| `apiKey`   | string | A **client** API key (Account → API Credentials), starts with `ptlc_`. Never commit it. |
| `serverId` | string | Short server id from the panel URL (`/server/<serverId>`), e.g. `"a1b2c3d4"`. |

**Omit this block entirely** to use the manual-decompress prompt. When present,
`--deploy` extracts the uploaded zip for you via the panel API instead.

Example `config.json` (SFTP only, manual decompress):

```json
{
  "protocol": "sftp",
  "host": "panel.your-host.net",
  "port": 2022,
  "user": "myname.a1b2c3d4",
  "password": "your-panel-password",
  "remoteBase": "/"
}
```

The example file uses `"//"`-prefixed keys as inline comments (top level and one
level deep, e.g. inside `pterodactyl`); these are ignored by the loader.

### Finding your Pterodactyl SFTP details

In the panel, open your server and go to the **Settings** tab — the **SFTP
Details** card shows the host, port (usually `2022`), and username (of the form
`user.serverid`). The password is your panel account password. (The
`serverid` after the dot is the short server identifier from the panel URL
`https://<panel>/server/<serverid>`.)

---

## Usage

### Recommended: efficient SFTP deploy

```sh
# Preview the diff + planned actions (builds + lists remote read-only; changes nothing)
node sync.js --deploy --dry-run

# Deploy: build, zip the changed jars, upload one archive, decompress, prune, verify
node sync.js --deploy
```

`--deploy` runs the build itself (mods only), so you do **not** also pass
`--build`. It exits non-zero if post-deploy verification fails.

**Without a `pterodactyl` apiKey**, the deploy pauses after the upload and asks
you to extract `_upload.zip` into `mods/` on the server (panel File Manager →
Decompress, or WinSCP). Press **Enter** once done and it finishes (removes the
zip, prunes, verifies). With an apiKey set, that step is automatic.

### Fallback: FTP/SFTP upload

```sh
# Build the server pack into .server-stage/
node sync.js --build

# Upload staged files (dry-run first to preview)
node sync.js --upload --dry-run
node sync.js --upload

# Full pipeline: build, then upload, mirroring deletions
node sync.js --build --upload --mirror

# One-time: also push config/
node sync.js --build --upload --with-config

# Help
node sync.js --help
```

npm script shortcuts are also available: `npm run build`, `npm run upload`,
`npm run sync`, `npm run deploy`.

### Flags

| Flag        | Effect |
|-------------|--------|
| `--deploy`  | **Recommended.** Build mods-only, then zip the changed jars, upload one archive over SFTP/FTP, decompress (panel API if `apiKey` set, else manual prompt), prune removed jars, verify. Implies a build. |
| `--build`   | Build the server-side pack into `.server-stage/`. |
| `--upload`  | **Fallback.** Upload staged `mods/` (and `config/` with `--with-config`) via FTP/SFTP, skipping unchanged files. |
| `--mirror`  | With `--upload`: **delete** remote files/dirs missing locally. Destructive. |
| `--with-config` | Include `config/` in build + upload (one-time; may contain secrets). |
| `--dry-run` | Log all actions, change nothing (local or remote). |
| `-h`, `--help` | Show help. |

The deploy step prints a summary of **uploaded / removed / unchanged / verified**;
the upload step prints **uploaded / skipped / deleted** counts.

---

## Deploy state files (gitignored)

| File            | Purpose |
|-----------------|---------|
| `.deployed.json` | Manifest `{ filename: sha256 }` of what was last successfully deployed. The deploy diff compares the freshly-built staging against this. Safe to delete (forces a full re-upload next deploy). |
| `_upload.zip`    | Temporary archive of the changed jars under `.server-stage/`. Created during a deploy and deleted once uploaded. |

Both are in `.gitignore` and must never be committed.

---

## SFTP note (Pterodactyl)

Most **Pterodactyl** panels do **not** expose plain FTP — they expose **SFTP**
on port **2022**, with a username of the form **`user.serverid`** (your panel
username, a dot, and the short server ID shown in the panel). If that's your
host, set in `config.json`:

```json
{
  "protocol": "sftp",
  "host": "panel.your-host.net",
  "port": 2022,
  "user": "myname.a1b2c3d4",
  "password": "your-panel-password",
  "remoteBase": "/"
}
```

SFTP is the **default** path (implemented via `ssh2-sftp-client`) and is used by
both `--deploy` and `--upload`. Set `"protocol": "ftp"` to fall back to plain
FTP/FTPS via `basic-ftp` instead — no other changes needed.

---

## Files

| File                  | Purpose |
|-----------------------|---------|
| `sync.js`             | CLI entry point: arg parsing, config load, deploy/upload orchestration. |
| `build.js`            | Downloads the bootstrap jar and runs packwiz-installer (server side) into `.server-stage/`. |
| `deploy.js`           | The `--deploy` path: hash + manifest diff + zip + single SFTP/FTP upload + decompress (auto/manual) + verify logic. |
| `pteroApi.js`         | OPTIONAL Pterodactyl client-API helper — auto-decompress + delete the temp zip when an `apiKey` is configured. Unused otherwise. |
| `ftpClient.js`        | `basic-ftp` adapter. |
| `sftpClient.js`       | `ssh2-sftp-client` adapter (same interface as the FTP one). |
| `config.example.json` | Template — copy to `config.json`. |
| `package.json`        | Deps (`archiver`, `basic-ftp`, `ssh2-sftp-client`) + npm scripts. |
| `.gitignore`          | Ignores `node_modules/`, `config.json`, `.env`, `.server-stage/`, `.deployed.json`, `_upload.zip`. |

---

## Safety / notes

- Credentials (the FTP/SFTP `password`) live only in `config.json`, which is
  gitignored. Nothing is hardcoded.
- `--deploy --dry-run` connects **read-only** (it lists the remote `mods/` for
  an accurate diff) but never zips, uploads, decompresses, deletes, or writes
  the manifest. If the read-only listing fails it falls back to an empty remote
  view and says so.
- The manual-decompress prompt needs an **interactive terminal**. In a
  non-interactive shell (CI, piped) `--deploy` uploads the zip then errors,
  telling you to extract it and re-run; configure a `pterodactyl` apiKey to make
  the whole flow non-interactive.
- The manifest is written **only after** post-deploy verification passes, so a
  skipped/failed manual extraction won't be recorded as deployed.
- `--upload --dry-run` never connects to the server and never writes to disk
  during build.
- `--mirror` is destructive — run it with `--dry-run` first.
- FTP/SFTP file comparison uses size + modified-time. FTP modified-time
  granularity is coarse, so a 2-second slack is applied; any size mismatch
  always forces a re-upload.
- The deploy diff is hash-based (sha256) against the local `.deployed.json`
  manifest, with remote **size** verification after upload (remote files can't
  be hashed over SFTP/FTP).
