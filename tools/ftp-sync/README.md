# ftp-sync — Mechanical Dreams server pack manager

A small Node.js CLI that builds the **server-side** packwiz pack locally and
pushes the `mods/` to a dedicated Minecraft server. It supports two paths:

- **`--deploy` (recommended, efficient)** — uploads only the **changed** jars as
  a **single zip** via the **Pterodactyl client API**, decompresses it
  server-side, prunes removed jars, and verifies. One HTTP upload instead of
  ~100 per-file transfers.
- **`--upload` (fallback)** — classic per-file **FTP**/**SFTP** sync, for hosts
  without API access.

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
   `mods/` directory, then via the Pterodactyl client API: zips **only the
   changed/new/missing jars**, uploads that one zip, decompresses it into
   `mods/`, deletes the temp zip, prunes jars no longer required, rewrites the
   manifest, and re-lists `mods/` to verify presence + size.
2b. **Upload (fallback)** — connects via FTP/SFTP and syncs the staged `mods/`
   to the server: uploads new/changed files (compared by **size** and
   **modified-time**, skipping unchanged ones), and with `--mirror` deletes
   remote files/dirs that no longer exist locally.

> **Note on hashing.** Neither FTP nor the Pterodactyl API can hash remote
> files. The deploy diff therefore relies on the local `.deployed.json` manifest
> (what we last deployed) plus **remote size** verification after upload. If you
> lose `.deployed.json`, the next deploy treats every jar as new and re-uploads
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

### FTP/SFTP fields — used by `--upload` (fallback)

| Field        | Type    | Notes |
|--------------|---------|-------|
| `protocol`   | string  | `"ftp"` (default) or `"sftp"`. |
| `host`       | string  | Hostname/IP, no protocol prefix. **Required for `--upload`.** |
| `port`       | number  | FTP: usually `21`. SFTP: usually `2022`. |
| `user`       | string  | Username. **Required for `--upload`.** Pterodactyl SFTP usernames look like `user.serverid`. |
| `password`   | string  | Password. **Required for `--upload`.** Never commit it. |
| `secure`     | boolean | **FTP only.** `true` = explicit FTPS (FTP over TLS); `false` = plain FTP. Ignored for SFTP. |
| `remoteBase` | string  | Remote directory the pack lives in; `mods/` is synced under it. Typically `"/"` (the server root on Pterodactyl). |

### `pterodactyl` block — used by `--deploy` (recommended)

| Field           | Type   | Notes |
|-----------------|--------|-------|
| `panelUrl`      | string | Base URL of your panel, **no trailing slash**, e.g. `"https://panel.your-host.net"`. **Required for `--deploy`.** |
| `apiKey`        | string | A **client** API key (Bearer token), starts with `ptlc_`. **Required.** Never commit it. |
| `serverId`      | string | The **short** server identifier (8 hex chars), e.g. `"a1b2c3d4"`. **Required.** |
| `remoteModsDir` | string | Mods directory relative to the server root. Default `"mods"`. |

Example `config.json`:

```json
{
  "protocol": "sftp",
  "host": "panel.your-host.net",
  "port": 2022,
  "user": "myname.a1b2c3d4",
  "password": "your-panel-password",
  "remoteBase": "/",
  "pterodactyl": {
    "panelUrl": "https://panel.your-host.net",
    "apiKey": "ptlc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "serverId": "a1b2c3d4",
    "remoteModsDir": "mods"
  }
}
```

The example file uses `"//"`-prefixed keys as inline comments (at the top level
and one level deep, e.g. inside `pterodactyl`); these are ignored by the loader.

### Creating a Pterodactyl client API key + finding the server ID

1. **API key:** in the panel, open **Account → API Credentials** (often at
   `https://<panel>/account/api`). Create a new key (a description and, if
   asked, an allowed-IP that may be left blank). Copy the token — it starts with
   `ptlc_` and is shown **once**. This is the *client* API, not the
   *application*/admin API, so it only ever touches your own server.
2. **Server ID:** open your server in the panel. The URL looks like
   `https://<panel>/server/a1b2c3d4` — the trailing `a1b2c3d4` is the
   `serverId`. (It is also the part after the dot in your SFTP username
   `user.a1b2c3d4`.)

---

## Usage

### Recommended: efficient API deploy

```sh
# Preview the diff + planned actions (builds + lists remote read-only; changes nothing)
node sync.js --deploy --dry-run

# Deploy: build, zip only the changed jars, upload+decompress, prune, verify
node sync.js --deploy
```

`--deploy` runs the build itself (mods only), so you do **not** also pass
`--build`. It exits non-zero if post-deploy verification fails.

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
| `--deploy`  | **Recommended.** Build mods-only, then via the Pterodactyl API upload only changed jars as one zip, decompress server-side, prune removed jars, verify. Uses the `pterodactyl` config block. Implies a build. |
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
| `_upload.zip`    | Temporary zip of changed jars under `.server-stage/`. Created and deleted within a single deploy run. |

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

SFTP support is implemented via `ssh2-sftp-client` and is selected purely by
`"protocol": "sftp"` — no other changes needed. FTP remains the primary,
default path.

---

## Files

| File                  | Purpose |
|-----------------------|---------|
| `sync.js`             | CLI entry point: arg parsing, config load, deploy/upload orchestration. |
| `build.js`            | Downloads the bootstrap jar and runs packwiz-installer (server side) into `.server-stage/`. |
| `deploy.js`           | The `--deploy` path: hash + diff + zip + verify logic. |
| `pteroClient.js`      | Pterodactyl **client** API wrapper (list / upload / decompress / delete). |
| `ftpClient.js`        | `basic-ftp` adapter. |
| `sftpClient.js`       | `ssh2-sftp-client` adapter (same interface as the FTP one). |
| `config.example.json` | Template — copy to `config.json`. |
| `package.json`        | Deps (`archiver`, `basic-ftp`, `ssh2-sftp-client`) + npm scripts. |
| `.gitignore`          | Ignores `node_modules/`, `config.json`, `.env`, `.server-stage/`, `.deployed.json`, `_upload.zip`. |

---

## Safety / notes

- Credentials (FTP/SFTP **and** the Pterodactyl `apiKey`) live only in
  `config.json`, which is gitignored. Nothing is hardcoded.
- `--deploy --dry-run` connects **read-only** (it lists the remote `mods/` for
  an accurate diff) but never uploads, decompresses, deletes, or writes the
  manifest. If the read-only listing fails it falls back to an empty remote view
  and says so.
- `--upload --dry-run` never connects to the server and never writes to disk
  during build.
- `--mirror` is destructive — run it with `--dry-run` first.
- FTP/SFTP file comparison uses size + modified-time. FTP modified-time
  granularity is coarse, so a 2-second slack is applied; any size mismatch
  always forces a re-upload.
- The deploy diff is hash-based (sha256) against the local `.deployed.json`
  manifest, with remote **size** verification after upload (remote files can't
  be hashed over FTP or the API).
