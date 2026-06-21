# ftp-sync — Mechanical Dreams server pack manager

A small Node.js CLI that builds the **server-side** packwiz pack locally and
pushes `mods/` + `config/` to a dedicated Minecraft server over **FTP**
(primary) or **SFTP** (optional).

This exists because the server runs on a Pterodactyl panel with a **locked
startup command** — packwiz cannot run on server boot — so the server's mods
and config must be pushed from the maintainer's PC instead.

- Pack: *Mechanical Dreams* (NeoForge 1.21.1, packwiz)
- Manifest: https://connorcogged.github.io/mechanical-dreams/pack.toml

---

## How it works

1. **Build** — runs `packwiz-installer-bootstrap.jar -g -s server <pack url>`
   inside a local staging dir (`.server-stage/`). This downloads **only
   server-side + universal** mods and config (client-only mods are excluded)
   into `.server-stage/mods/` and `.server-stage/config/`. The bootstrap jar
   is auto-downloaded into the staging dir if missing.
2. **Upload** — connects via FTP/SFTP and syncs the staged `mods/` and
   `config/` to the server: uploads new/changed files (compared by **size** and
   **modified-time**, skipping unchanged ones), and with `--mirror` deletes
   remote files/dirs that no longer exist locally.

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

| Field        | Type    | Notes |
|--------------|---------|-------|
| `protocol`   | string  | `"ftp"` (default) or `"sftp"`. |
| `host`       | string  | Hostname/IP, no protocol prefix. **Required.** |
| `port`       | number  | FTP: usually `21`. SFTP: usually `2022`. |
| `user`       | string  | Username. **Required.** Pterodactyl SFTP usernames look like `user.serverid`. |
| `password`   | string  | Password. **Required.** Never commit it. |
| `secure`     | boolean | **FTP only.** `true` = explicit FTPS (FTP over TLS); `false` = plain FTP. Ignored for SFTP. |
| `remoteBase` | string  | Remote directory the pack lives in; `mods/` and `config/` are synced under it. Typically `"/"` (the server root on Pterodactyl). |

The example file uses `"//"`-prefixed keys as inline comments; these are
ignored by the loader.

---

## Usage

```sh
# Build the server pack into .server-stage/
node sync.js --build

# Upload staged files (dry-run first to preview)
node sync.js --upload --dry-run
node sync.js --upload

# Full pipeline: build, then upload, mirroring deletions
node sync.js --build --upload --mirror

# Preview everything without touching disk or server
node sync.js --build --upload --mirror --dry-run

# Help
node sync.js --help
```

npm script shortcuts are also available: `npm run build`, `npm run upload`,
`npm run sync`.

### Flags

| Flag        | Effect |
|-------------|--------|
| `--build`   | Build the server-side pack into `.server-stage/`. |
| `--upload`  | Upload staged `mods/` + `config/`, skipping unchanged files. |
| `--mirror`  | With `--upload`: **delete** remote files/dirs missing locally. Destructive. |
| `--dry-run` | Log all actions, change nothing (local or remote). |
| `-h`, `--help` | Show help. |

The upload step prints a summary of **uploaded / skipped / deleted** counts.

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
| `sync.js`             | CLI entry point: arg parsing, config load, upload/sync logic, orchestration. |
| `build.js`            | Downloads the bootstrap jar and runs packwiz-installer (server side) into `.server-stage/`. |
| `ftpClient.js`        | `basic-ftp` adapter. |
| `sftpClient.js`       | `ssh2-sftp-client` adapter (same interface as the FTP one). |
| `config.example.json` | Template — copy to `config.json`. |
| `package.json`        | Deps + npm scripts. |
| `.gitignore`          | Ignores `node_modules/`, `config.json`, `.env`, `.server-stage/`. |

---

## Safety / notes

- Credentials live only in `config.json`, which is gitignored. Nothing is
  hardcoded.
- `--dry-run` never connects to the server during upload and never writes to
  disk during build.
- `--mirror` is destructive — run it with `--dry-run` first.
- File comparison uses size + modified-time. FTP modified-time granularity is
  coarse, so a 2-second slack is applied; any size mismatch always forces a
  re-upload.
