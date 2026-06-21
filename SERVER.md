# Running a Mechanical Dreams dedicated server (Pterodactyl)

This pack is built so a dedicated server installs **only server-side mods** — all client-only
mods (Sodium, shaders, EMI, minimaps, etc.) are excluded automatically via packwiz `side`
metadata. You push the server pack from your PC over FTP/SFTP using the tool in
[`tools/ftp-sync/`](tools/ftp-sync/), because the panel's startup command is locked and can't
run packwiz on boot.

- Pack URL: `https://connorcogged.github.io/mechanical-dreams/pack.toml`
- Minecraft `1.21.1` · NeoForge `21.1.233` · **Java 21 required**

---

## 1. Panel prerequisites (do these first)

These are the two things that will otherwise stop the server from ever loading mods:

1. **Java 21, not 25.** Set the server's **Docker Image** to a **Java 21** build.
   NeoForge 1.21.1 targets Java 21; Java 25 is not supported and will fail.
2. **Use a NeoForge (or Forge) egg — not Paper.** A Paper egg cannot load NeoForge/Forge
   mods at all. The egg must install **NeoForge 21.1.233** so that
   `libraries/net/neoforged/neoforge/21.1.233/unix_args.txt` exists. The standard
   Forge/NeoForge startup command then boots it:
   ```
   java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.233/unix_args.txt nogui
   ```
   If your host only offers a Paper/vanilla egg, ask them to add a NeoForge egg or enable a
   custom startup command.
3. Accept the EULA: edit `eula.txt` → `eula=true`.

> The locked startup command is fine — it only runs NeoForge. packwiz never runs on the
> server; you push the mods from your PC (next section).

---

## 2. Deploy / update the mods (from your PC)

The [`tools/ftp-sync/`](tools/ftp-sync/) Node tool builds the server-side pack locally
(client-only mods excluded) and uploads it over FTP or SFTP.

```sh
cd tools/ftp-sync
npm install
cp config.example.json config.json     # then edit — see below
```

`config.json` (gitignored — never commit credentials):

| field        | value                                                              |
|--------------|--------------------------------------------------------------------|
| `protocol`   | `"sftp"` for Pterodactyl (most panels), or `"ftp"`                 |
| `host`       | your panel's SFTP/FTP host                                          |
| `port`       | `2022` for Pterodactyl SFTP (`21` for plain FTP)                    |
| `user`       | Pterodactyl SFTP username, usually `yourname.serverid`             |
| `password`   | your panel password                                                |
| `secure`     | `true` for FTPS (FTP only); ignore for SFTP                        |
| `remoteBase` | remote root to sync into, usually `"/"`                            |

Then:

```sh
node sync.js --build --upload --dry-run   # preview: build server pack + show what would upload
node sync.js --build --upload             # build + push changed files
node sync.js --build --upload --mirror    # also delete remote files no longer in the pack
```

- `--build` stages **mods only** into `tools/ftp-sync/.server-stage/` (only `mods/` is
  fetched — shaders, resource packs, options.txt are never downloaded).
- **config/ is excluded by default** — configs can contain secrets and are managed by hand
  on the server, so the tool never fetches or overwrites them. Add `--with-config` only for a
  one-time initial deploy if you want to push the pack's default configs.
- `--upload` syncs by size+mtime, skipping unchanged files.
- `--mirror` removes stale remote files (use after you remove mods from the pack).

**To update the server later:** push a pack change to GitHub (it deploys to Pages), then just
re-run `node sync.js --build --upload --mirror`. Restart the server to load changes.

---

## 3. What goes where

- **Server gets:** the 12 `side=server` mods + the `side=both` mods (required gameplay).
- **Server never gets:** the `side=client` mods (Sodium, shaders, EMI, etc.) — excluded by
  `-s server`, so they can't crash the dedicated server.
- **Clients** install via the launcher release and connect normally; the `both` mods match the
  server, and client-only mods are theirs to toggle.

---

## 4. Troubleshooting

- **Server crashes on boot referencing a rendering/client class** → a client-only mod leaked
  in. Re-check its `side` in the pack and rebuild; `node sync.js --build` then `--upload --mirror`.
- **Client can't join ("mod mismatch")** → a `both`-side mod differs between client and server.
  Make sure both are on the same pack version (clients auto-update on launch; restart the server
  after pushing).
- **Server runs Paper / mods don't load** → wrong egg. You need a NeoForge egg (section 1).
- **`java.lang.UnsupportedClassVersionError`** → wrong Java. Set the Docker image to Java 21.
