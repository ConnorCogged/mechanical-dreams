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

1. Download `Mechanical-Dreams-CurseForge.zip` from the pinned release / shared link.
2. Open the CurseForge / Overwolf app → **Minecraft → Create Custom Profile → Import**.
3. Pick the zip. CurseForge installs NeoForge 1.21.1, downloads all mods, and applies configs.
4. Play.

This is a **static snapshot** — it does *not* auto-update like the Prism instance. To get a
newer pack version, re-import the latest zip. (CurseForge profiles can't pull from packwiz.)

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

To rebuild the CurseForge import zip (Option B above):

```
packwiz refresh
packwiz curseforge export -y -o dist/Mechanical-Dreams-CurseForge.zip
```

CurseForge-sourced mods go into `manifest.json` by project/file ID; Modrinth/GitHub mods
are downloaded and bundled under `overrides/mods/`. Note: every bundled non-CurseForge jar
must be on CurseForge's [Approved Non-CurseForge Mods](https://support.curseforge.com/en/support/solutions/articles/9000197177)
list for the pack to be uploadable to CurseForge (importing locally always works).
