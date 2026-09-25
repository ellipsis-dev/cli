#!/usr/bin/env bash
# Local builds use the same package.json version as release builds.
set -euo pipefail
cd "$(dirname "$0")/.."
bun run check:versions
exec bun build src/cli.ts --compile --outfile agent
