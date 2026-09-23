# Aion PAK Manager

Desktop manager for AION `.pak` archives: browse, extract (UnPAK), decrypt and
rebuild (RePAK) packages without leaving the app. The whole pipeline — AION
`pak2zip` decoding, XML/HTML decryption and PAK writing — is implemented in
Node.js and shared with a headless CLI.

![icon](frontend/assets/icon.svg)

## Features

- **PAKS** — lists every `*.pak` under `/PAKS/pak`, lets you inspect a package's
  contents before extracting, run an individual UnPAK of selected packages, or
  **Extract full folder** (recursive): each `.pak`'s files land straight in the
  mirrored folder (no `name.pak/` wrappers) together with a single aggregate
  `.db`. Optional **UnPAK + Decrypt** does both in one pass.
- **UnPAKEDS / RePAKEDS** — decrypt or RePAK selected extract folders, then open
  a rebuilt `.pak` (tree + search) and add, replace or delete entries **without
  recompressing** the untouched data.
- **Drag & drop into RePAKEDS** — drag files or folders from the OS onto the
  rebuilt `.pak` tree (drop anywhere, or onto a specific folder to target it) to
  add or replace entries in the RePAKEDS list; existing names prompt to
  overwrite or skip.
- **View PAK contents** — open a `.pak` and browse its file tree, with
  per-folder selection, before committing to an extraction.
- **File structure** — browse the aggregate databases under `/PAKS/unpaked`.
- **Conflict handling** — when a file already exists you choose **Replace**,
  **Skip**, or apply the same answer to everything that follows; cancelling
  leaves the target untouched.
- **Custom source folders** — point any list at another directory (e.g. the
  game's data folder) with the folder button next to the tab; the path is shown
  above the list and can be restored to the default.
- **CPU effort control** — pick how many logical cores the worker pool may use
  (Low/Medium/High/Extreme, or Manual thread count) from Settings.
- **Progress & activity log** — live progress bar with elapsed time, ETA and
  speed, plus a toggleable per-file log and a fullscreen modal.
- **Update check** — the app compares its version against the latest GitHub
  Release and links straight to the download page.
- **i18n** — pt-BR, en-US, es-ES.

## Requirements

- **Node.js 20+** and npm (to build or run from source)
- **git** (to clone the repository)
- **Windows 10/11** for the Windows artifacts, or a **Linux** distribution for
  the Linux artifacts (see [Building](#building))

## Getting started

Clone the repository and run the app in development mode:

```bash
git clone https://github.com/giordanidev/aion-pak-manager.git
cd aion-pak-manager
npm install
npm run dev        # Electron + Vite dev server
```

The app creates its data folders under `PAKS/` next to the project root on first
launch: put your source archives in `PAKS/pak`, and extraction/rebuild output
appears in `PAKS/unpaked` and `PAKS/repaked`.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run the app in development |
| `npm run build` | Production build into `.build/` (bumps patch version) |
| `npm run build:app` | Build the renderer/main bundle without bumping the version |
| `npm run dist` | Windows setup (NSIS) + portable into `release/` |
| `npm run dist:dir` | Unpacked Windows build (no installer) |
| `npm run dist:linux` | **Native Linux** installer (`.deb` on Ubuntu/Debian, `.rpm` on Fedora) into `release/` |
| `npm run dist:linux:appimage` | Native Linux build + portable `.AppImage` |
| `npm run dist:linux:wsl` | Windows → WSL2: builds the Ubuntu and Fedora artifacts |
| `npm run dist:linux:wsl:ubuntu` | Windows → WSL2 Ubuntu (`.deb` + AppImage) |
| `npm run dist:linux:wsl:fedora` | Windows → WSL2 Fedora (`.rpm`) |
| `npm run icon` | Regenerate `build/icon.ico` / `build/icon.png` from `frontend/assets/icon.svg` |
| `npm run typecheck` | Type-check backend (`tsc`) and frontend (`vue-tsc`) |
| `npm run cli` / `npm run unpak` / `npm run repak` | Headless CLI (see below) |

## Command-line interface

The same engine the desktop app uses is available headless, so UnPAK / RePAK /
decrypt can be scripted.

### Installed app (recommended for end users)

The Windows installer ships a console wrapper, `aion-pak.cmd`, next to the
executable:

```bat
aion-pak unpak "C:\Aion\data\data.pak"
aion-pak repak "C:\extracted\data_ptbr" -o "C:\out\data_ptbr.pak"
aion-pak decrypt "C:\extracted\data_ptbr"
```

Add the install folder to `PATH` (or run `.\aion-pak …`) to use it anywhere.
Under the hood it invokes the app executable with the `cli` subcommand, which
runs headless — no window opens.

Because the Windows build is a GUI application with no console attached, calling
the executable directly requires redirecting the output:

```bat
"aion-pak-manager.exe" cli unpak "C:\Aion\data\data.pak" > out.log 2>&1
type out.log
```

The portable build is a single file with no wrapper beside it; use the redirect
form above, or the installed version for the `aion-pak` wrapper.

### From the source tree (development)

`cli` is the name of the headless entry point. In the source tree it is
`npm run cli -- …`; the `pre*` scripts build `.build/backend/cli.js` on first
use:

```bash
npm run cli -- unpak PAKS/pak/data.pak
npm run cli -- unpak PAKS/pak -o PAKS/unpaked --decrypt
npm run cli -- repak PAKS/unpaked/data_ptbr -o PAKS/repaked/data_ptbr.pak
npm run cli -- decrypt PAKS/unpaked/data_ptbr

# Shortcuts and the raw entry point
npm run unpak -- PAKS/pak/data.pak
npm run repak -- my_folder --simple-zip
node .build/backend/cli.js unpak PAKS/pak/data.pak
```

### Usage

```
cli unpak <pak|folder...> [-o <dir>] [--decrypt] [--effort <mode>] [--threads <n>]
cli repak <folder...> [-o <pak|dir>] [--simple-zip] [--effort <mode>] [--threads <n>]
cli decrypt <folder...> [--effort <mode>] [--threads <n>]
cli help
```

| Option | Description |
| --- | --- |
| `-o`, `--out <path>` | `unpak`: base output directory (default: beside each `.pak`). `repak`: output `.pak` file, or a directory (default: `<folder>.pak` beside the source). |
| `--effort <mode>` | CPU effort: `low` \| `medium` \| `high` \| `extreme` \| `manual`. Default: the value in `settings.json`. |
| `--threads <n>` | Thread count for manual effort (implies `--effort manual`). |
| `--decrypt` | `unpak`: decrypt the extracted XML/HTML files in place. |
| `--simple-zip` | `repak`: build a simple zip-style `.pak` instead of AION. |
| `-h`, `--help` | Show the help text. |

Command notes:

- A **directory** target for `unpak` is scanned recursively for `*.pak`.
- `decrypt` rewrites AION-encoded `*.xml` / `*.html` files in place (recursive).
- All commands run on a worker pool sized to the CPU effort (the same mechanism
  as the GUI). Each `.pak` is split into entry chunks, so a **single** PAK uses
  several worker threads; multiple targets run in parallel too — `unpak` across
  `.pak` files, `repak` / `decrypt` across folders.

### CPU effort

`--effort <mode>` selects how many logical cores the pool may use:

| mode | threads |
| --- | --- |
| `low` | 30% of logical cores |
| `medium` | 60% |
| `high` | 90% (default) |
| `extreme` | 100% |
| `manual` | the value of `--threads <n>` |

- Without `--effort` / `--threads`, the value from `settings.json` is used.
- `--threads <n>` implies `--effort manual` and caps at the logical-core count.
- On SMT CPUs (e.g. 6c/12t), values above the physical core count give
  diminishing returns; use `--effort manual --threads 6` to cap at physical
  cores.

```bash
npm run cli -- unpak PAKS/pak --effort extreme
npm run cli -- repak PAKS/unpaked/data_ptbr --effort manual --threads 6
```

### Windows performance note (many small files)

The worker pool splits **each** PAK into entry chunks, so even a single PAK
extracts on several threads. On Linux this scales well for both many-small-file
and few-large-file PAKs. On Windows, extracting a PAK with thousands of tiny
files is dominated by filesystem + antivirus overhead (real-time scanning of
every written file): the same PAK that takes ~1 s on Linux can take ~10 s on
Windows. Threads still help, but wall time is I/O/AV-bound. Adding the `PAKS/`
folder to Defender's exclusions restores near-Linux speed. Measured on a 6c/12t
machine, `--effort extreme`:

| PAK | Linux | Windows |
| --- | --- | --- |
| `data_pt-BR.pak` (11 571 tiny files) | 0.55 s | ~12.5 s |
| `textures.pak` (141 large files) | 0.42 s | — |

## Building

### Windows

```bash
npm install
npm run dist        # NSIS setup + portable into release/
```

`npm run dist` regenerates the icons, builds the bundle and runs
`electron-builder` for the `nsis` and `portable` targets. The data folders
(`PAKS/pak`, `PAKS/unpaked`, `PAKS/repaked`) are created next to the executable
on first launch.

### Linux

Linux targets (`.deb`, `.rpm`, `AppImage`) are built **on Linux**. There are two
entry points, both driving the same native builder `scripts/linux/build.sh`:

| Where you run it | Command |
| --- | --- |
| Inside Linux/WSL/container (native) | `bash scripts/linux/build.sh` |
| On Windows, through WSL2 | `npm run dist:linux:wsl` |

The native builder rsyncs the sources to a Linux-side work dir
(`~/aion-pak-manager-build`), installs dependencies with `npm ci` (cached by
lock-file hash), builds the renderer/main bundle and runs `electron-builder`,
then copies the artifacts back to `release/`. Building under `/mnt` is avoided
so Windows and Linux `node_modules` never mix.

Install the toolchain first (Node.js, npm, rsync, and `rpm`/`rpmbuild` or
`dpkg`/`fakeroot` for the target package format).

#### Native Linux (recommended when you are already on Linux)

```bash
bash scripts/linux/build.sh                  # .deb on Ubuntu/Debian, .rpm on Fedora
bash scripts/linux/build.sh --with-appimage  # also builds the portable AppImage
bash scripts/linux/build.sh --skip-install   # reuse the work dir node_modules
bash scripts/linux/build.sh --targets "rpm" --dest ./release
```

Or through npm: `npm run dist:linux` / `npm run dist:linux:appimage`.

| Flag / env | Effect |
| --- | --- |
| `--with-appimage` | Adds the portable `AppImage` to the distro-native installer |
| `--targets "deb rpm AppImage"` | Explicit electron-builder Linux targets |
| `--skip-install` | Skip `npm ci` (dependencies already present) |
| `--skip-icon` | Skip `npm run icon` (reuse `build/icon.*`) |
| `--dest <dir>` | Output folder (default: `<repo>/release`) |
| `AION_BUILD_DIR` | Linux-side work dir (default: `~/aion-pak-manager-build`) |

The distro dictates the native installer (`.deb` for Ubuntu/Debian, `.rpm` for
Fedora/RHEL) and the `LINUX_FLAVOR` used in the artifact name.

#### From Windows via WSL2

The `scripts/dist-linux-wsl.mjs` driver resolves the WSL distros, normalizes the
scripts' line endings and invokes the native builder inside each distro.

```bash
# One-time: install the Node.js toolchain + rsync inside the WSL distros
wsl -d Ubuntu-24.04 -- sudo apt-get install -y nodejs npm rsync
wsl -d FedoraLinux-44 -- sudo dnf install -y nodejs npm rsync

npm run dist:linux:wsl:ubuntu   # Ubuntu: .deb + AppImage (linux-ubuntu)
npm run dist:linux:wsl:fedora   # Fedora: .rpm (linux-fedora)
npm run dist:linux:wsl          # both distros
```

Override the auto-detected distros with `WSL_UBUNTU_DISTRO` / `WSL_FEDORA_DISTRO`.

Notes:

- `AppImage` is the portable Linux artifact; the `.deb` is for Debian/Ubuntu and
  the `.rpm` for Fedora/RHEL.
- On Linux the app stores its `PAKS/` data next to the `.AppImage` file, or in
  `~/.local/share/aion-pak-manager` for the `.deb` / `.rpm` install.

### Artifact names

Builds are lowercase with hyphens and include the target platform:

| Artifact | Example |
| --- | --- |
| Windows setup | `aion-pak-manager-0.0.81-setup-windows-x64.exe` |
| Windows portable | `aion-pak-manager-0.0.81-portable-windows-x64.exe` |
| Ubuntu AppImage | `aion-pak-manager-0.0.81-portable-linux-x86_64.AppImage` |
| Ubuntu `.deb` | `aion-pak-manager-0.0.81-setup-linux-ubuntu-amd64.deb` |
| Fedora `.rpm` | `aion-pak-manager-0.0.81-setup-linux-fedora-x86_64.rpm` |

## Publishing to GitHub

A workflow at `.github/workflows/release.yml` builds **Windows and Linux** and
attaches the artifacts to a GitHub Release. Push a tag to trigger it:

```bash
git remote add origin https://github.com/<user>/aion-pak-manager.git
git push -u origin main
git tag v0.0.81 && git push origin v0.0.81   # creates the release
```

You can also run it manually from the Actions tab (`workflow_dispatch`), which
uploads the artifacts as workflow artifacts. Adjust `homepage` in `package.json`
to your real repository URL.

## Folder model

All data lives under `PAKS/` next to the project root (in a packaged app, next
to the executable):

| Path | Purpose |
| --- | --- |
| `PAKS/pak` | Source `.pak` files (never written to by UnPAK) |
| `PAKS/unpaked` | Extracted content; also the input for RePAK |
| `PAKS/repaked` | Rebuilt / repacked `.pak` files |

- Individual UnPAK → `PAKS/unpaked/<name>/` (no database).
- Full-folder extract → each `.pak`'s files go straight into the mirrored folder
  under `PAKS/unpaked` (no `<name>.pak/` wrappers) plus **one** aggregate
  database `PAKS/unpaked/<folder>/<folder>.db` (version 4, with `paks[]`
  recording `relPakPath`, `destDir` and the file manifest). Legacy v3 extracts
  keep their `<name>.pak/` wrapper + `outputFolder` and are read as fallback.
- Reconstruct rebuilds each `.pak` from that manifest (v4 sources are kept, v3
  wrappers are removed after a successful repack); plain RePAK packs a folder
  as-is. Both write to `PAKS/repaked`.

Each list can be pointed at a custom directory (persisted locally); the header
shows `Folder: <path>` and a button restores the default.

## Project structure

```
frontend/    Vue 3 renderer (UI, i18n, assets/icon.svg)
backend/     Electron main, IPC, services, workers, core/parse
  cli/       Headless CLI entry (unpak / repak / decrypt)
  core/      AION unpak, repak, decrypt (Electron-free)
  parse/     Binary XML, HTML crypt, PAK codec, format detection
  services/  Paths, counts, settings, worker pools
  workers/   Piscina worker entries
shared/      IPC contracts shared by renderer + main + preload
build/       icon.ico / icon.png (generated) + aion-pak.cmd wrapper
scripts/     Build helpers (version bump, icon, CLI bootstrap)
  linux/     Native Linux builder (build.sh + _common.sh)
  dist-linux-wsl.mjs   Windows -> WSL2 driver
```

## Notes

- Targets **Aion 1** PAKs only (default AION pak encoding).
- UnPAK / decrypt / RePAK run in Piscina workers so the UI never blocks.
- `build/icon.ico` is generated from `frontend/assets/icon.svg` and is used by
  the installer, the portable build and the dev window.
- RePAKED editing rewrites only what changes: new/replaced entries are
  compressed, kept entries are copied verbatim.
