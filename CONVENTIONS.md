# Conventions for capnp-ts

Towncrier keeps the changelog. Cocogitto bumps the version and makes the tag. A `v*` tag push runs `.github/workflows/release.yml`, which checks that the commit is on `main`, checks that the version sites agree, builds, typechecks, runs the suite against Cap'n Proto C++ 1.4.0, packs the npm tarballs, and publishes the GitHub release. npm publish runs only when `NPM_TOKEN` is set.

## Changelog

News fragments live in `docs/newsfragments/`. Name them `<issue>.<type>.md`, or `+slug.<type>.md` when there is no issue. The types are `breaking`, `security`, `removed`, `deprecated`, `added`, `dev`, `changed`, and `fixed`. `towncrier build` writes them into `CHANGELOG.md` under the `<!-- towncrier release notes start -->` marker and deletes the fragment files. Write one fragment per user-visible change, for users. The towncrier workflow runs that check on every pull request. A docs-only or CI-only change still carries a `dev` fragment.

A release heading is `## [<version>] - <date>`, the same shape as `## [0.1.0]`. `scripts/extract-changelog.sh` ends a section at a `[version]:` link line, so that link does not go between the heading and the notes. Fixes that landed after v0.1.0 stay in fragments until the next bump, which is what puts them in the new section.

## Release

Run `cog bump --auto` on `main`. The pre-bump hooks run `scripts/bump-version.sh`, set the version in `towncrier.toml`, run `towncrier build`, and check the new section with `scripts/release_notes.py` and `scripts/extract-changelog.sh`. Cocogitto commits and tags `v<version>`. A tag that contains a hyphen is a prerelease.

`scripts/bump-version.sh` writes the same version into every file `scripts/check-release-version.sh` reads. It does not call npm. `workspace:*` dependencies stay as they are. If a write does not match, the script puts the files back. Current release: v0.1.0, package version 0.1.0.

Versions are semver, with the pre-1.0 caveat in the changelog header. A new feature bumps the minor. A fix-only release bumps the patch. A wire or API break is a `breaking` fragment.

## Issues, PRs and labels

Open one issue per gap or bug class against Cap'n Proto C++ 1.4.0. Give each a reproducer or the C++ behaviour to match, and a plain statement of done. Open one PR per series, titled in the conventional-commit style of the repo log. Its body says `Closes #N` for each issue it fixes. The labels are the GitHub defaults plus `parity`, `wire`, `codegen`, `rpc`, `dynamic`, `interop`, `security`, `ci`, and `dependencies`. `.github/labels.yml` lists them, and `scripts/sync-labels.sh` applies them. A PR merges with green CI and a fragment.

## Files

`towncrier.toml`, `cog.toml`, `docs/newsfragments/`, `scripts/release_notes.py`, `scripts/bump-version.sh`, and `scripts/sync-labels.sh` live at the repo root. The workflows are `.github/workflows/towncrier.yml`, `.github/workflows/release-prepare.yml`, and `.github/workflows/release.yml`. Issue forms and the pull request template are under `.github/`. Actions are pinned to commit SHAs.
