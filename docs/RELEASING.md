# Releasing the CLI (maintainers)

The CLI ships only as Bun-compiled binaries on GitHub Releases. Users install
with `install.sh` (`curl -fsSL https://raw.githubusercontent.com/ellipsis-dev/cli/main/install.sh | sh`)
and stay current with `agent update`. Both download from the release assets
and verify them against `checksums.txt`. It is never published to npm:
`package.json` is `private`, has no `bin`, and there is no `publishConfig`.

CLI **2.X.Y** always uses SDK **0.X.Y**. For example, CLI **2.30.0** uses
`@ellipsis-dev/sdk` **0.30.0**. Keep the CLI version and exact SDK dependency
in `package.json` up to date together, and commit the regenerated `bun.lock`.
Version ranges such as `^0.30.0` are not allowed. CLI-only changes also need
a matching SDK release when advancing the CLI version.

Publishing is fully automated by `.github/workflows/release.yml`, triggered by
pushing a `v2.X.Y` git tag (there is also a `workflow_dispatch` fallback that
takes a version input in the Actions UI). On a tag push it:

1. Installs dependencies with the frozen lockfile, checks that the release
   version matches `package.json` and the installed SDK follows the version
   rule, then runs typechecking and tests. Mismatches stop the release.
2. Cross-compiles six binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`,
   `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`) with
   `bun build --compile` and tars each. The list lives in the workflow and in
   `RELEASE_TARGETS` in `src/lib/install.ts`; a test keeps them equal.
3. Writes `checksums.txt` (`sha256sum` output) and creates the GitHub release
   with the tarballs and that file.

Nothing else needs to happen: `install.sh` resolves the newest release through
GitHub's `releases/latest/download/` redirect, and installed binaries learn
about it from their daily background check.

The manual steps (Hunter cuts releases) are: commit the version updates and
SDK migration, ensure CI is green, then create and push the matching `v2.X.Y`
tag on the main commit to release. For CLI 2.30.0, use `v2.30.0`. The workflow
validates the committed version; it does not rewrite it.

`package.json` is the version source for development, local compiled binaries,
and releases. `bun run compile` checks the CLI/SDK pair before building;
`./agent --version` reports `2.30.0` for this version, including local builds.
Run `bun run check:versions` to check the pair without building, or
`bun run check:versions 2.30.0` to also validate an intended release version.

## Trying the installer without a release

CI runs `install.sh` against a locally built binary served from a temporary
directory laid out like GitHub Releases (`latest/download/<tarball>` plus
`checksums.txt`), by pointing `ELLIPSIS_DOWNLOAD_BASE` at it. The same trick
works on a laptop with `python3 -m http.server`; see the install-smoke step in
`.github/workflows/ci.yml`.
