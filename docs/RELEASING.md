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

The only manual steps (Hunter cuts releases) are: ensure CI is green, then
create and push the `vX.Y.Z` tag on the main commit to release. No
`package.json` bump commit is needed — the workflow's `npm version` step
stamps the tag's version into `package.json` before building, so the field on
main goes stale by design (releases since v1.4.0 tag main directly).

Because the field is stale, local builds don't read their version from it:
`bun run compile` (scripts/compile.sh) stamps the binary from
`git describe --tags`, so `./agent --version` reports exactly what it was
built from — `1.6.0` on a clean tagged checkout, `1.6.0-2-g08ea24d-dirty` two
commits past the tag with uncommitted changes. Only `tsx` dev runs fall back
to the stale `package.json` field.
