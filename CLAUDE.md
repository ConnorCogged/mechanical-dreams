# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The **packwiz** source for *Mechanical Dreams*, a NeoForge **21.1.233** / Minecraft **1.21.1**
modpack. There's no application code here. The repo root *is* the published pack. GitHub Pages
serves it at `https://connorcogged.github.io/mechanical-dreams/pack.toml`, and every client runs
`packwiz-installer-bootstrap.jar` against that URL on each launch. Pushing to `main` therefore
ships the change to every player's next launch.

- `pack.toml` → `index.toml` (sha256 of every file) → `mods/*.pw.toml` (metadata pointing at
  Modrinth/CurseForge downloads), plus raw files (`config/`, `options.txt`, `shaderpacks/`,
  custom/forked `.jar`s in `mods/`) that are hashed byte-for-byte and served from Pages.
- `.packwizignore` keeps `dist/`, `tools/` and `*.md` out of the index.
- `.gitattributes` sets `* -text`. **Never let line endings get converted.** If served bytes stop
  matching `index.toml` hashes, installs fail.
- `.gitignore` excludes `dist/` and `tools/`, so the CurseForge zip source and the server deploy
  tool are local-only and not in git.

## Commands

packwiz is a Go binary built from source (`/c/Users/conno/go/bin/packwiz`). It may not be on PATH.

```sh
packwiz refresh                         # REQUIRED after any change: rehashes index.toml + pack.toml
packwiz modrinth install <slug>         # add a mod (preferred source, see below)
packwiz curseforge install <slug>       # add from CurseForge (server-only mods only)
packwiz update <name>                   # update one mod; `packwiz update --all` for everything
packwiz remove <name>
```

A normal commit touches the changed files **plus** `index.toml` and `pack.toml` (index hash). If
a commit removes or edits a `.pw.toml` without the matching `index.toml`/`pack.toml` diff,
`packwiz refresh` wasn't run.

Custom or forked jars (e.g. `connoradditions-*.jar`, `neoperipheral`, `cbcmodernwarfare-*-sablefix6`)
go straight into `mods/` as raw files. When bumping one, delete the old jar and refresh.
`*.jar.disabled` files are inactive alternates that are still indexed.

### Dedicated server (`tools/ftp-sync/`, Node, maintainer-only)

The Pterodactyl server's startup command is locked, so packwiz can't run there. Mods get pushed
from this PC instead. See `SERVER.md` and `tools/ftp-sync/README.md`.

```sh
cd tools/ftp-sync && npm install
node sync.js --deploy                         # recommended: zip only changed jars, upload, extract, verify
node sync.js --build --upload --mirror        # fallback: full per-file SFTP sync + delete stale
# add --dry-run to preview; --with-config only for a first deploy (server configs are hand-managed)
```

The build runs `packwiz-installer -s server` against the **published** Pages pack, so push and
wait for Pages to deploy before syncing the server. It needs Java 21. Override the path with
`JAVA_BIN`. `config.json` contains credentials.

### CurseForge-launcher zip (`dist/cf-pack/`)

This zip is static (NeoForge + bootstrap jar + `update.bat`), so it only needs rebuilding when the
pack version, loader or updater files change. Keep `dist/cf-pack/manifest.json` `version`/`neoforge`
in sync with `pack.toml`.

```sh
cd dist/cf-pack && zip -r ../Mechanical-Dreams-CurseForge.zip manifest.json overrides
```

## Rules that aren't obvious from the files

- **Side model.** `side = "client"` mods are always `[option] optional = true, default = false`
  (Sodium, shaders, EMI, minimaps…). `side = "both"` and `side = "server"` mods are required.
  Only client-side mods can be optional. A `both` mod must match between client and server, so
  "disabling" one means removing it. Take sides from the mod's Modrinth `client_side`/`server_side`.
  **Exception:** server-only tools players may want for singleplayer testing (WorldEdit, BlueMap,
  GriefLogger, CCSecureBoot/PKI) are `side = "both"` + `optional = true, default = false`, using a
  Modrinth URL. `tools/ftp-sync/build.js` serves these to the headless server installer with
  `default = true`, so the server still gets them. Only use this for mods a vanilla client can join without.
- **Worldgen/biome/dimension/structure mods must be `side = "both"`, never `"server"`.**
  Singleplayer runs an integrated server on the client. A server-only worldgen mod is missing
  there, which gives `Missing key ... worldgen/biome` crashes.
- **Anything that reaches the client (`both`/`client`) should be a Modrinth direct URL, not
  `mode = "metadata:curseforge"`.** The installer silently skips CF files that block third-party
  distribution, so the jar never shows up. Already-cached jars hide this until a mod becomes newly
  required. CF metadata is fine for server-only mods, because the server deploy copies real jars.
- **No interpreters for end users.** Player-facing install/update must work with only the
  launcher's Java (packwiz-installer) or compiled binaries. Never add a Node/Python step to the
  player workflow. `tools/ftp-sync` is acceptable only because it's maintainer-only.
- The pack is non-commercial because of bundled forks' licenses (CC BY-NC-SA, MPL-2.0). When
  adding or forking mods, update `CREDITS.md`.
