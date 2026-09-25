#!/bin/sh
# Installs the Ellipsis agent CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/ellipsis-dev/cli/main/install.sh | sh
#
# Options (pass them after `sh -s --`):
#   --version <x.y.z>   install that release instead of the latest one
#   --dir <path>        where to put the binary (default: ~/.local/bin)
#   --no-modify-path    leave shell startup files alone; print the PATH line instead
#   --help              print the usage text
#
# Environment variables do the same: ELLIPSIS_VERSION, ELLIPSIS_INSTALL_DIR,
# ELLIPSIS_NO_MODIFY_PATH=1.
#
# What it does: picks the release asset for this OS and CPU, downloads it and
# checksums.txt from GitHub Releases, checks the SHA-256, and puts the binary
# at <dir>/agent. If <dir> is not on PATH it appends one marked line to the
# startup file of $SHELL; inside GitHub Actions it appends to $GITHUB_PATH
# instead. `agent update` and `agent uninstall` take it from there.
#
# Needs: curl or wget, tar, and one of sha256sum, shasum, or openssl.
set -eu

RELEASES="${ELLIPSIS_DOWNLOAD_BASE:-https://github.com/ellipsis-dev/cli/releases}"
BIN="agent"
# Keep in sync with PATH_MARKER in src/lib/install.ts: `agent uninstall`
# removes exactly the startup-file lines that carry this comment.
PATH_MARKER="Ellipsis agent installer"

VERSION="${ELLIPSIS_VERSION:-}"
INSTALL_DIR="${ELLIPSIS_INSTALL_DIR:-$HOME/.local/bin}"
MODIFY_PATH=1
if [ -n "${ELLIPSIS_NO_MODIFY_PATH:-}" ]; then MODIFY_PATH=0; fi

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'USAGE'
Usage: install.sh [--version <x.y.z>] [--dir <path>] [--no-modify-path]

  --version <x.y.z>   install that release instead of the latest one
  --dir <path>        where to put the binary (default: ~/.local/bin)
  --no-modify-path    leave shell startup files alone; print the PATH line instead

Environment: ELLIPSIS_VERSION, ELLIPSIS_INSTALL_DIR, ELLIPSIS_NO_MODIFY_PATH=1
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version=*) VERSION="${1#--version=}" ;;
    --version)
      if [ $# -lt 2 ]; then fail "--version needs a value"; fi
      VERSION="$2"
      shift
      ;;
    --dir=*) INSTALL_DIR="${1#--dir=}" ;;
    --dir)
      if [ $# -lt 2 ]; then fail "--dir needs a value"; fi
      INSTALL_DIR="$2"
      shift
      ;;
    --no-modify-path) MODIFY_PATH=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
  shift
done

# --- tools -------------------------------------------------------------------

if ! need tar; then fail "tar is required"; fi

if need curl; then
  download() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif need wget; then
  download() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi

sha256_of() {
  if need sha256sum; then
    sha256sum "$1" | awk '{ print $1 }'
  elif need shasum; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif need openssl; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  else
    fail "sha256sum, shasum, or openssl is required to verify the download"
  fi
}

# --- which build -------------------------------------------------------------

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system: $os (macOS and Linux only)" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU: $arch" ;;
esac

# A shell running under Rosetta reports x86_64 on an Apple Silicon Mac.
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
fi

# musl (Alpine and friends) needs its own build; its dynamic loader is the tell.
libc=""
if [ "$os" = linux ]; then
  for f in /lib/ld-musl-*.so.1; do
    if [ -e "$f" ]; then libc="-musl"; fi
  done
fi

target="$os-$arch$libc"
tarball="$BIN-$target.tar.gz"

if [ -n "$VERSION" ]; then
  VERSION="${VERSION#v}"
  base="$RELEASES/download/v$VERSION"
  label="$VERSION"
else
  base="$RELEASES/latest/download"
  label="latest"
fi

# --- download and verify -----------------------------------------------------

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t "$BIN")
trap 'rm -rf "$tmp"' EXIT

say "Downloading $BIN $label for $target..."
if ! download "$base/$tarball" "$tmp/$tarball"; then
  fail "could not download $base/$tarball (is $label a published release with a $target build?)"
fi
if ! download "$base/checksums.txt" "$tmp/checksums.txt"; then
  fail "could not download $base/checksums.txt"
fi

expected=$(grep "[[:space:]]$tarball\$" "$tmp/checksums.txt" | awk '{ print $1 }')
if [ -z "$expected" ]; then fail "checksums.txt has no entry for $tarball"; fi
actual=$(sha256_of "$tmp/$tarball")
if [ "$actual" != "$expected" ]; then
  fail "checksum mismatch for $tarball: expected $expected, got $actual"
fi

tar -xzf "$tmp/$tarball" -C "$tmp"
if [ ! -f "$tmp/$BIN" ]; then fail "$tarball does not contain $BIN"; fi

# --- install -----------------------------------------------------------------

if ! mkdir -p "$INSTALL_DIR"; then fail "cannot create $INSTALL_DIR (try --dir, or sudo)"; fi
if [ -e "$INSTALL_DIR/$BIN" ] || [ -L "$INSTALL_DIR/$BIN" ]; then
  say "Replacing the existing $INSTALL_DIR/$BIN"
fi

# Stage next to the destination so the final rename is atomic, even over a
# binary that is running right now.
staged="$INSTALL_DIR/.$BIN.install.$$"
if ! cp "$tmp/$BIN" "$staged" || ! chmod 755 "$staged" || ! mv -f "$staged" "$INSTALL_DIR/$BIN"; then
  rm -f "$staged"
  fail "cannot write to $INSTALL_DIR (try --dir, or sudo)"
fi

if ! installed=$("$INSTALL_DIR/$BIN" --version 2>/dev/null); then
  fail "$INSTALL_DIR/$BIN does not run on this machine"
fi
say "Installed $BIN $installed to $INSTALL_DIR/$BIN"

# --- PATH --------------------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

# Write $HOME symbolically so the line survives a home directory move.
case "$INSTALL_DIR" in
  "$HOME"/*) dir_expr="\$HOME${INSTALL_DIR#"$HOME"}" ;;
  *) dir_expr="$INSTALL_DIR" ;;
esac
export_line="export PATH=\"$dir_expr:\$PATH\""

append_line() {
  mkdir -p "$(dirname "$1")"
  if [ -f "$1" ] && grep -qF "$PATH_MARKER" "$1"; then return 0; fi
  printf '\n%s\n' "$2" >>"$1"
  say "Added $INSTALL_DIR to PATH in $1"
}

if [ "$on_path" = 1 ]; then
  resolved=$(command -v "$BIN" 2>/dev/null || true)
  if [ -n "$resolved" ] && [ "$resolved" != "$INSTALL_DIR/$BIN" ]; then
    say "Note: $resolved comes before $INSTALL_DIR on your PATH, so \`$BIN\` still runs that one."
  fi
elif [ -n "${GITHUB_PATH:-}" ]; then
  echo "$INSTALL_DIR" >>"$GITHUB_PATH"
  say "Added $INSTALL_DIR to GITHUB_PATH, so later steps can run $BIN."
elif [ "$MODIFY_PATH" = 0 ]; then
  say "$INSTALL_DIR is not on your PATH. Add this line to your shell startup file:"
  say "  $export_line"
else
  hint="$export_line"
  case "$(basename "${SHELL:-sh}")" in
    zsh) append_line "$HOME/.zshrc" "$export_line # $PATH_MARKER" ;;
    fish)
      hint="set -gx PATH $dir_expr \$PATH"
      append_line "$HOME/.config/fish/config.fish" "$hint # $PATH_MARKER"
      ;;
    bash)
      append_line "$HOME/.bashrc" "$export_line # $PATH_MARKER"
      if [ "$os" = darwin ]; then
        # Terminal.app opens login shells, which read the first of these that
        # exists (bash's own order). Create .bash_profile only when none exist,
        # so an existing .profile keeps being read.
        login_rc="$HOME/.bash_profile"
        for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
          if [ -f "$f" ]; then
            login_rc="$f"
            break
          fi
        done
        append_line "$login_rc" "$export_line # $PATH_MARKER"
      fi
      ;;
    *) append_line "$HOME/.profile" "$export_line # $PATH_MARKER" ;;
  esac
  say "Open a new shell, or run now: $hint"
fi

say "Next: run \`$BIN auth login\` to authenticate."
