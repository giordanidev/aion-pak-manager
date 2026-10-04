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

# g++/python3 so a reserva do better-sqlite3 compila quando não há prebuild do Electron.
ensure_native_toolchain() {
  if command -v g++ >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  log "A instalar compilador C++ para better-sqlite3…"
  run_as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
      "$@"
    else
      sudo "$@"
    fi
  }
  case "$(distro_id)" in
    ubuntu | debian | pop | linuxmint | zorin)
      run_as_root apt-get update
      run_as_root apt-get install -y build-essential python3
      ;;
    fedora | rhel | centos | rocky | almalinux)
      run_as_root dnf install -y gcc-c++ make python3
      ;;
    *)
      die "Instale g++ e python3 para compilar better-sqlite3."
      ;;
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
