#!/usr/bin/env sh
# Verify a downloaded Ellipsis CLI release archive against the checksums file
# published with that release.
#
# Usage: scripts/verify-release.sh <version> <archive>
#
#   scripts/verify-release.sh 2.35.0 ~/Downloads/ellipsis-2.35.0-darwin-arm64.tar.gz
set -eu

version="$1"
archive="$2"
checksums_url="https://github.com/ellipsis-dev/cli/releases/download/v${version}/checksums.txt"

expected=$(curl -fsSL "$checksums_url" | grep $(basename $archive) | cut -d' ' -f1)
actual=$(sha256sum "$archive" | cut -d' ' -f1)

if [ $expected == $actual ]; then
  echo "ok: $archive matches v$version"
else
  echo "checksum mismatch for $archive (expected $expected, got $actual)"
fi
