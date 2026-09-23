#!/usr/bin/env bash
# Helpers partilhados pelos scripts de build Linux nativos do Aion PAK Manager.
# Não executar diretamente: cada script faz `source _common.sh`.
set -euo pipefail

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

_LINUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_LINUX_DIR/../.." && pwd)"

APP_NAME="aion-pak-manager"
APP_DISPLAY="Aion PAK Manager"
APP_ID="com.aion.pak-manager"

# --- Distro / arquitetura ----------------------------------------------------

distro_id() {
  # shellcheck disable=SC1091
  ( . /etc/os-release; printf '%s' "${ID:-linux}" )
}

distro_label() {
  # shellcheck disable=SC1091
  ( . /etc/os-release; printf '%s%s' "${ID:-linux}" "${VERSION_ID:-}" )
}

arch_raw() { uname -m; }

# LINUX_FLAVOR controla o nome dos artefatos .deb/.rpm (ver package.json).
flavor_for_distro() {
  case "$(distro_id)" in
    ubuntu | debian | pop | linuxmint | zorin) echo linux-ubuntu ;;
    fedora | rhel | centos | rocky | almalinux) echo linux-fedora ;;
    *) echo "linux-$(distro_id)" ;;
  esac
}

# Alvos por omissão: instalação nativa da distro (o AppImage é opcional).
default_targets() {
  case "$(distro_id)" in
    ubuntu | debian | pop | linuxmint | zorin) echo deb ;;
    fedora | rhel | centos | rocky | almalinux) echo rpm ;;
    *) echo deb ;;
  esac
}
