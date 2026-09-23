# AGENTS.md — project structure guide

## Active structure

- `frontend/` — Vue 3 renderer (UI). Styling is 100% **Tailwind CSS v4** via `@tailwindcss/vite`; there is no component CSS — `frontend/assets/app.css` only contains `@import 'tailwindcss'`, the `@theme` block (color/font tokens) and global rules (reset, scrollbars, `TransitionGroup` transitions).
- `backend/` — Electron main, IPC, services, preload (source), workers, Node core/parse, `cli/` (headless unpak/repak)
- `shared/` — shared IPC types/contracts (renderer + main + preload). No unpack/decrypt logic.
- `build/` — `icon.ico` (Windows, generated from `frontend/assets/icon.svg` by `npm run icon`) plus the `aion-pak.cmd` wrapper; Linux uses `frontend/assets/icon.png`, and the app header uses `frontend/assets/icon.svg` (single source, no copies under `build/`); `version.json` (repo root) is the tiny update manifest served as a release asset / CDN fallback
- `scripts/` — build helpers (version bump, icon, CLI bootstrap); `scripts/linux/` — **native** Linux builder (`build.sh` + `_common.sh`); `dist-linux-wsl.mjs` — Windows → **WSL2** driver (invokes the native builder inside the distros)
- `.build/` — build artifacts (gitignored)
- All logic is implemented in Node.js; target: **Aion 1**.

## Commands

- `npm run dev` — app (electron-vite)
- `npm run build` — production build
- `npm run dist` — Windows installer (NSIS) + portable into `release/` (via electron-builder, targets `nsis` + `portable`; `PAKS/`, with `pak/`, `unpaked/`, `repaked/` inside, is created next to the .exe on boot)
- `npm run dist:linux` — **native** Linux build (`scripts/linux/build.sh`): `.deb` on Ubuntu/Debian, `.rpm` on Fedora/RHEL, into `release/`; `npm run dist:linux:appimage` adds the portable `AppImage`. Runs inside Linux/WSL/container (rsync to `~/aion-pak-manager-build`, cached `npm ci`, electron-builder).
- `npm run dist:linux:wsl[:ubuntu|:fedora]` — Windows → **WSL2** (`scripts/dist-linux-wsl.mjs`), which invokes the native builder inside the distro(s): Ubuntu produces `.deb` + `AppImage`, Fedora produces `.rpm`; artifacts are copied back to `release/`. Names include the target: `aion-pak-manager-<version>-setup-windows-x64.exe`, `-portable-windows-x64.exe`, `-setup-linux-ubuntu-amd64.deb`, `-setup-linux-fedora-x86_64.rpm`, `-portable-linux-x86_64.AppImage`.
- `npm run icon` — regenerates `build/icon.ico` (Windows) and `build/icon.png` (Linux) from `frontend/assets/icon.svg`
- CI: `.github/workflows/release.yml` builds Windows + Linux and attaches them to a GitHub Release on `v*` tags
- `npm run cli|unpak|repak` — headless CLI (`.build/backend/cli.js`, entry `backend/cli/index.ts`, logic in `backend/cli/run.ts`); `precli|preunpak|prerepak` build the CLI if missing. In the packaged app: `<app>.exe cli <command>` (via `backend/index.ts`) + the `build/aion-pak.cmd` wrapper (extraFiles). `unpak`/`repak`/`decrypt` run on a Piscina pool sized by `--effort <low|medium|high|extreme|manual>` (+ `--threads <n>` for manual); without a flag, it uses `settings.json`. Each `.pak` is split into entry chunks (`scanPakEntries` + `extractPaksParallel`) to use several threads even with a single PAK.

## Rules for agents

- Node logic lives in `backend/`; IPC types in `shared/`; UI in `frontend/` (frontend does **not** import `backend/`).
- `backend/core` and `backend/parse` are Electron-free (also used by the headless CLI).
- Data directories (`PAKS/pak`, `PAKS/unpaked`, `PAKS/repaked` under `PAKS/`) are relative to the project root via `resolveProjectRoot()` — the main bundle in `.build/backend/` must not use `__dirname` for this. In a packaged app: the `.exe` folder (`PORTABLE_EXECUTABLE_DIR` in the electron-builder portable, otherwise `dirname(process.execPath)`). Legacy folders `files/`, `unpaked/`, `repaked/` are migrated one-shot into `PAKS/` by `ensureDataDirs()`.
- Folder model: `/PAKS/pak` = source PAKs (never write extracts here); `/PAKS/unpaked` = extracted content (individual UnPAK: `<name>/` with no DB; whole-folder UnPAK: each `.pak`'s files are extracted **directly** into the mirrored folder — **no** `<name.pak>/` folders — with **one** aggregate DB `PAKS/unpaked/<folder-name>/<folder-name>.db` **inside the extracted folder**, **version 4**, with `paks[]` (`relPakPath`, `destDir`, `files`/`fileCount` from the pak TOC); older extracts (v3) keep `outputFolder` + the `<name.pak>/` wrapper and the `name.pak.db` sibling, and the legacy sibling `PAKS/unpaked/<folder-name>.db` is read as a fallback and removed when the new DB is written; re-extract skipping uses the DB manifest (`!overwrite`), and writing the root DB deletes the wrappers/`.db` siblings of the legacy tree) and folders to RePAK; `/PAKS/repaked` = reconstructed/repacked `.pak` files (Reconstruct is DB-driven: it walks `paks[]`, v4 never deletes the source, v3 removes the wrapper after success). The `list-pak-databases` listing considers the first-level `<folder>/<folder>.db` under `unpaked` (with a fallback to the legacy `*.db` sibling). `/translation` and `/repak` were removed from the active code.

## UI responsiveness (required)

**No feature may freeze the app.** The renderer (Vue) must stay responsive during any operation.

### Backend / main

- IPC handlers return a `Promise` — never block the event loop with heavy synchronous work in the main process.
- Unpack, bulk decrypt, repack: workers (`piscina` in `backend/workers/`) or child processes; progress via `webContents.send('app-progress', ...)`.
- Avoid long synchronous loops in the main process; prefer `backend/core` + `backend/parse` + pool.
- Workers live in `backend/workers/`. Platform helpers: `backend/bin/platform.ts`.

### Frontend (`frontend/`)

- Every asynchronous action (IPC, scan, unpak, decrypt, repack, select folder) must:
  1. **Not block** the UI thread (use `async/await`, no busy-wait).
  2. **Show loading** in the affected area — a spinning loading icon and/or a `loading` state on the button/section.
  3. **Disable** only the controls of the operation in progress (existing pattern: `state.actionRunning` in `useAppState.ts`), not the whole window without feedback.

### Loading pattern per section

| Operation | Where to show spinner / loading |
|----------|---------------------------------|
| Refresh Lists | "Refresh Lists" button + optionally the PAK/translation lists |
| UnPAK / Decrypt / RePAK | Progress bar + `actionRunning` |
| Extract full folder | UnPAK button + section fields |
| Initial scan (mount) | Same as Refresh Lists |

Suggested implementation:

- Granular state in `useAppState.ts` (e.g. `listsRefreshing`, `pakActionLoading`) in addition to `actionRunning`.
- Spinner: Tailwind utilities `inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white` (variant `border-border border-t-accent` for light backgrounds).
- Button with loading: text replaced by or accompanied by a spinner; `:disabled="loading"` to prevent double clicks.

**Forbidden:** long awaits without visual feedback; freezing lists without an indicator; using `alert`/modal blocking for operations that last more than ~200ms.
