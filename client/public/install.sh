#!/bin/sh
# Installs Parley's desktop app on macOS or Linux, the terminal way:
#   curl -fsSL https://<this site>/install.sh | sh
# A download made this way doesn't get the Mac's "can't check this app" warning.
set -eu

RELEASES=https://github.com/lepreem/parley/releases/latest/download
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

install_mac() {
  case $(uname -m) in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "Parley has no build for this Mac." >&2; exit 1 ;;
  esac
  echo "Downloading Parley..."
  curl -fL --progress-bar -o "$TMP/Parley.dmg" "$RELEASES/Parley-mac-$arch.dmg"
  mount=$TMP/mount
  hdiutil attach -quiet -nobrowse -mountpoint "$mount" "$TMP/Parley.dmg"
  target=/Applications
  [ -w "$target" ] || { target=$HOME/Applications; mkdir -p "$target"; }
  rm -rf "$target/Parley.app"
  cp -R "$mount/Parley.app" "$target/"
  hdiutil detach -quiet "$mount"
  echo "Installed to $target/Parley.app. Opening it."
  open "$target/Parley.app"
}

install_linux() {
  case $(uname -m) in
    aarch64 | arm64) deb=arm64 appimage=arm64 ;;
    x86_64) deb=amd64 appimage=x86_64 ;;
    *) echo "Parley has no build for this computer." >&2; exit 1 ;;
  esac
  if command -v apt-get >/dev/null 2>&1; then
    echo "Downloading Parley..."
    curl -fL --progress-bar -o "$TMP/parley.deb" "$RELEASES/Parley-linux-$deb.deb"
    chmod a+r "$TMP/parley.deb" "$TMP"
    echo "Installing it, which asks for your password."
    sudo apt-get install -y "$TMP/parley.deb"
    echo "Installed. Open Parley from your applications."
  else
    bin=$HOME/.local/bin
    mkdir -p "$bin"
    echo "Downloading Parley..."
    curl -fL --progress-bar -o "$bin/Parley.AppImage" \
      "$RELEASES/Parley-linux-$appimage.AppImage"
    chmod +x "$bin/Parley.AppImage"
    echo "Installed to $bin/Parley.AppImage. Run it to open Parley."
  fi
}

case $(uname -s) in
  Darwin) install_mac ;;
  Linux) install_linux ;;
  *) echo "This script is for macOS and Linux." >&2; exit 1 ;;
esac
