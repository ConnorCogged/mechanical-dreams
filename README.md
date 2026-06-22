# Mechanical Dreams (v2.0)

A NeoForge **1.21.1** modpack. This repository is the **packwiz** distribution source —
the MultiMC/Prism instance auto-installs and auto-updates from here on every launch.

- **Mod loader:** NeoForge 21.1.233
- **Mods:** 122 from CurseForge/Modrinth (downloaded from source) + custom/forked jars hosted here
- **Licensing & credits:** see [CREDITS.md](CREDITS.md)

## For players — how to install

### Option A — Prism / MultiMC (auto-updating)

1. Install [Prism Launcher](https://prismlauncher.org/) (recommended) or MultiMC.
2. Download the prebuilt instance zip from the pinned release / shared link.
3. In the launcher: **Add Instance → Import from zip** → pick the file.
4. Launch. The pack downloads and updates itself automatically (a progress window appears).

That's it — no Node, no Python. The only requirement is the Java the launcher manages for you.

### Option B — CurseForge launcher (no MultiMC required)

This build is **packwiz-managed**: the import zip only sets up NeoForge and a bundled
`packwiz-installer-bootstrap.jar` + `update.bat`. packwiz then downloads the mods folder
from the same live pack the Prism instance uses, so you get identical mods and updates.

1. Download `Mechanical-Dreams-CurseForge.zip` from the pinned release / shared link.
2. CurseForge / Overwolf app → **Minecraft → Create Custom Profile → Import** → pick the zip.
3. Open the profile's folder (**… → Open Folder**) and double-click **`update.bat`**.
   It downloads every mod; tick any optional mods (shaders, Iris, EMI …) when prompted.
4. Launch from CurseForge.

**To update later:** run `update.bat` again — it pulls the newest pack version and adds /
removes / updates mods to match. CurseForge has no pre-launch hook, so this is the manual
equivalent of Prism's auto-update (which runs the same installer on every launch).

### Manual setup (if not using the instance zip)

Create a NeoForge 1.21.1 instance, drop `packwiz-installer-bootstrap.jar` into its
`.minecraft` folder, then set a **pre-launch command** (Edit Instance → Settings →
Custom Commands):

```
"$INST_JAVA" -jar packwiz-installer-bootstrap.jar https://connorcogged.github.io/mechanical-dreams/pack.toml
```

## For the maintainer — updating the pack

Edit mods/configs, then from this folder run `packwiz refresh` and push. Players get the
update on their next launch. Build tooling is [packwiz](https://packwiz.infra.link/)
(a single compiled binary — no interpreter required).

The CurseForge import zip (Option B above) is **static** — it doesn't list mods, it just
ships NeoForge + the packwiz installer, which fetches mods from the live pack at run time.
So it only needs rebuilding if you change the pack version, loader, or the updater files;
routine mod changes are picked up by players' `update.bat` with no new zip. Source lives in
`dist/cf-pack/` (`manifest.json` + `overrides/{packwiz-installer-bootstrap.jar, update.bat,
READ-ME-FIRST.txt}`). To rebuild:

```
cd dist/cf-pack
zip -r ../Mechanical-Dreams-CurseForge.zip manifest.json overrides
```

Bump the `version` / `neoforge` fields in `dist/cf-pack/manifest.json` to match `pack.toml`
when those change.
