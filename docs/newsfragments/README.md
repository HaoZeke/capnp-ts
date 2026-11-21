# Changelog fragments (towncrier)

User-visible changes add one fragment here. On release, `towncrier build`
folds the fragments into `CHANGELOG.md` and deletes them.

One fragment per user-visible change, not one per commit. Name it
`<issue>.<type>.md` when an issue exists, or `+slug.<type>.md` when not.
Write for people who use the library, not for people who wrote the patch.

Types: `breaking`, `security`, `removed`, `deprecated`, `added`, `dev`,
`changed`, `fixed`.

Create one with `uvx towncrier create`, and preview the result with
`uvx towncrier build --draft`.

The `towncrier` workflow runs on every pull request. A change that only
touches docs or CI still needs a `dev` fragment. Do not edit a release
section by hand above the marker in `CHANGELOG.md`.
