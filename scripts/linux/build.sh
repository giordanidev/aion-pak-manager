#!/usr/bin/env bash
# Builder Linux NATIVO do Aion PAK Manager (Electron + electron-builder).
#
# Corre DENTRO do Linux (máquina Linux, WSL ou container):
#   bash scripts/linux/build.sh
#   bash scripts/linux/build.sh --with-appimage
#   bash scripts/linux/build.sh --skip-install --with-appimage
#
# No Windows usa-se o driver WSL2 separado:
#   npm run dist:linux:wsl[:ubuntu|:fedora]
#   node scripts/dist-linux-wsl.mjs ubuntu
#
# Os artefactos são copiados para <repo>/release (ou --dest).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
. "$SCRIPT_DIR/_common.sh"

[[ "$(uname -s)" == Linux ]] ||
  die "scripts/linux/build.sh corre só em Linux. No Windows usa: node scripts/dist-linux-wsl.mjs"

WITH_APPIMAGE=0
SKIP_INSTALL=0
SKIP_ICON=0
TARGETS=""
DEST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-appimage) WITH_APPIMAGE=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-icon) SKIP_ICON=1; shift ;;
    --targets) TARGETS="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "Opção desconhecida: $1" ;;
  esac
done

DEST="${DEST:-$REPO_ROOT/release}"
WORK="${AION_BUILD_DIR:-$HOME/aion-pak-manager-build}"
FLAVOR="$(flavor_for_distro)"
[[ -n "$TARGETS" ]] || TARGETS="$(default_targets)"
if [[ "$WITH_APPIMAGE" -eq 1 ]]; then
  TARGETS="$TARGETS AppImage"
fi

# --- 1) Sincronizar o código para o filesystem Linux -------------------------
# Evita compilar sobre /mnt (lento) e não mistura node_modules Windows/Linux.
log "A sincronizar $REPO_ROOT -> $WORK"
mkdir -p "$WORK"
rsync -a --delete \
  --exclude node_modules \
  --exclude .build \
  --exclude release \
  --exclude PAKS \
  --exclude .git \
  --exclude .orchestrate \
  --exclude .vscode \
  "$REPO_ROOT"/ "$WORK"/

# --- 2) Dependências ---------------------------------------------------------
cd "$WORK"
if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  LOCK_HASH="$(sha1sum package-lock.json | cut -d' ' -f1)"
  MARKER="node_modules/.install-lock"
  if [[ ! -d node_modules ]] || [[ ! -f "$MARKER" ]] ||
    [[ "$(cat "$MARKER" 2>/dev/null)" != "$LOCK_HASH" ]]; then
    log "A instalar dependências (npm ci)…"
    npm ci
    printf '%s' "$LOCK_HASH" >"$MARKER"
  else
    log "Dependências já atualizadas."
  fi
fi

# --- 3) Versão / ícone -------------------------------------------------------
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
log "Build Linux $(arch_raw) — $APP_DISPLAY $VERSION ($(distro_label)) — alvos: $TARGETS"

if [[ "$SKIP_ICON" -eq 0 ]]; then
  npm run icon
fi

# --- 4) Bundle (renderer + main) ---------------------------------------------
npm run build:app

# --- 5) Empacotar ------------------------------------------------------------
mkdir -p release
rm -f release/*.deb release/*.rpm release/*.AppImage release/*.blockmap release/latest*.yml 2>/dev/null || true
LINUX_FLAVOR="$FLAVOR" npx electron-builder --linux $TARGETS --publish never

# --- 6) Copiar artefactos para o destino -------------------------------------
mkdir -p "$DEST"
shopt -s nullglob
ARTIFACTS=(release/*.deb release/*.rpm release/*.AppImage release/*.blockmap release/latest*.yml)
if [[ ${#ARTIFACTS[@]} -gt 0 ]]; then
  log "A copiar artefactos -> $DEST"
  cp -f "${ARTIFACTS[@]}" "$DEST/"
  for f in "${ARTIFACTS[@]}"; do printf '    %s\n' "$(basename "$f")"; done
fi

log "Concluído ($(distro_label))."
