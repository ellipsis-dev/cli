# Releasing the CLI (maintainers)

The CLI ships only as a Homebrew formula from the `ellipsis-dev/homebrew-cli`
tap. It is never published to npm: `package.json` is `private`, has no `bin`,
and there is no `publishConfig`. The single `npm` call in the release workflow
(`npm version --no-git-tag-version`) is just a local tool to rewrite the
version field, not a registry publish.

Publishing is fully automated by `.github/workflows/release.yml`, triggered by
pushing a `vX.Y.Z` git tag (there is also a `workflow_dispatch` fallback that
takes a version input in the Actions UI). On a tag push it:

1. Stamps the version into `package.json` (the single source of truth:
   `src/lib/constants.ts` reads `pkg.version`, which bun inlines into the
   binary, so `agent --version` never drifts).
2. Cross-compiles four binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`,
   `linux-arm64`) with `bun build --compile`, tars each, and computes SHA-256
   checksums.
3. Creates the GitHub release with the tarballs and `checksums.txt`.
4. Regenerates `Formula/agent.rb` in the tap repo from the template and pushes
   it, so `brew install ellipsis-dev/cli/agent` picks up the new version.

The only manual steps (Hunter cuts releases) are: ensure CI is green, bump the
`package.json` version, commit it as `chore(release): vX.Y.Z`, then create and
push the matching `vX.Y.Z` tag. The tag version must equal the `package.json`
version, because the formula's `test do` block asserts `agent --version` equals
the released version.
