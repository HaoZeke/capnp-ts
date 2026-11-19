# Conventions for capnp-ts

This copies the setup in OmniPotentRPC/rgpot and TheochemUI/eOn, cut down for an adapter library. Both use towncrier for the changelog and cocogitto for the bump. A tag push runs the release workflow. Labels are the GitHub defaults plus a few project ones. Neither repo has issue or PR templates, so the ones under `setup/` are small and optional.

## Changelog

News fragments live in `docs/newsfragments/`. Name them `<issue>.<type>.md`, or `+slug.<type>.md` without an issue. The types are the rgpot set: `breaking`, `security`, `removed`, `deprecated`, `added`, `dev`, `changed` and `fixed`. A release build writes the fragments into `CHANGELOG.md` under the `<!-- towncrier release notes start -->` marker and deletes them. Write one fragment per user-visible change, for users. A `towncrier check` job runs on every pull request. A docs-only or CI-only change carries a `dev` fragment.

The current `CHANGELOG.md` is hand-written Keep a Changelog with an `[Unreleased]` block. The setup PR puts the marker above that block. It turns the bullets into fragments, so nothing is lost. The heading disappears on the next build. Files in `fragments/` match the series in `MAP.md` and use `+slug` names. Rename each to `<issue>.<type>.md` once the issue exists.

## Release

Run `cog bump --auto` on `main`. The pre-bump hooks update the version files and run `towncrier build`. A last hook checks that the new section can be extracted. Cocogitto commits and tags `v<version>`. The tag push runs `release.yml`. That workflow fails when `CHANGELOG.md` has no section for the tag. Otherwise it extracts the section with `scripts/release_notes.py` and creates the GitHub release with it as the notes. A tag with a hyphen is a prerelease. No tags or releases exist yet. The first release is v0.1.0, and the draft bumps every workspace package with `npm version`. That hook is untested against the workspace layout.

Versions are semver, with the pre-1.0 caveat in the changelog header. A new feature bumps the minor. A fix-only release bumps the patch. A wire or API break goes under Breaking. Current tag: none yet (package.json says 0.1.0-dev). Suggested next: 0.1.0.

## Issues, PRs and labels

Open one issue per gap or bug class against Cap'n Proto C++ 1.4.0. Give each a reproducer or the C++ behaviour to match, and a plain statement of done. Open one PR per series, titled in the conventional-commit style of the repo log. Its body says `Closes #N` for each issue it fixes. The labels are the GitHub defaults plus `parity`, `wire`, `codegen`, `rpc`, `dynamic`, `interop`, `security`, `ci` and `dependencies`. The file `setup/.github/labels.yml` lists them, and `setup/scripts/sync-labels.sh` applies them. A PR merges with green CI and a fragment.

## Files under setup/

The draft has `towncrier.toml`, `cog.toml`, the fragment README and `.gitkeep`, three workflows (`towncrier.yml`, `release.yml`, `release-prepare.yml`), `scripts/release_notes.py`, the label list and sync script, two issue forms and the PR template. The workflows use floating action tags. Pin them to commit hashes when landing, as rgpot and eOn do. None of it has run in the repo. The first PR should show the towncrier and release-prepare jobs green before anyone pushes a tag.
