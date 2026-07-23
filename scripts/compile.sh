#!/usr/bin/env bash
# Local/dev compile. Stamps the binary's version from `git describe` so
# `./agent --version` reports exactly what it was built from, e.g.
# "1.6.0-2-g08ea24d-dirty" = 2 commits past v1.6.0 at 08ea24d with
# uncommitted changes (a tagged, clean checkout reads the bare "1.6.0").
# package.json's version field is NOT the truth for local builds: releases
# stopped bumping it (the release workflow rewrites it at tag time and
# builds directly, without this script), so it goes stale on main by design.
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(git describe --tags --always --dirty | sed 's/^v//')"
exec bun build src/cli.tsx --compile --outfile agent \
  --define "BUILD_GIT_VERSION=\"${version}\""
