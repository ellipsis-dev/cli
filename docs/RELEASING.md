# Releasing the CLI (maintainers)

The CLI ships only as a Homebrew formula from the `ellipsis-dev/homebrew-cli`
tap. It is never published to npm: `package.json` is `private`, has no `bin`,
and there is no `publishConfig`.

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
2. Cross-compiles four binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`,
   `linux-arm64`) with `bun build --compile`, tars each, and computes SHA-256
   checksums.
3. Creates the GitHub release with the tarballs and `checksums.txt`.
4. Regenerates `Formula/agent.rb` in the tap repo from the template and pushes
   it, so `brew install ellipsis-dev/cli/agent` picks up the new version.

The manual steps (Hunter cuts releases) are: commit the version updates and
SDK migration, ensure CI is green, then create and push the matching `v2.X.Y`
tag on the main commit to release. For CLI 2.30.0, use `v2.30.0`. The workflow
validates the committed version; it does not rewrite it.

`package.json` is the version source for development, local compiled binaries,
and releases. `bun run compile` checks the CLI/SDK pair before building;
`./agent --version` reports `2.30.0` for this version, including local builds.
Run `bun run check:versions` to check the pair without building, or
`bun run check:versions 2.30.0` to also validate an intended release version.
