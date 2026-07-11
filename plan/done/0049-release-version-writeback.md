---
title: Release writes the tagged version back through a reviewable PR
priority: medium
blocked_by: [0039-version-writeback-on-release]
---

Today the release lane tags `main`'s current HEAD, whose four version files
still carry the *previous* version, and never updates them — so from the second
release onward the tagged tree records a stale version. Make cutting a release
bump all four version-bearing files to the released version, surface that bump as
a reviewable pull request (never a direct push to `main`), and cut the tag on the
bumped commit so the tagged tree records its own version.

## Acceptance criteria
- [ ] Cutting a release for version `X.Y.Z` produces a commit that sets `.ratchet-version`, `plugin/.claude-plugin/plugin.json`, the README framework badge, and the DOCS.md header to `X.Y.Z`, and the release tag points at that commit (the tagged tree passes `version-consistency` at the tag's version)
- [ ] The version bump reaches `main` only through a reviewable pull request — the release lane never pushes the bump directly to `main`
- [ ] Cutting a release on a repo whose default branch is `master` still opens the bump PR and tags the bumped commit (no regression of #81's default-branch targeting)
- [ ] If the bump PR cannot be created (the branch already exists, or the API rejects it), the run fails with the API's actual error and does not leave a tag pointing at an un-bumped tree — a clear message, never a stack trace

## Notes
**Design decision to make before building — resolve in review of this issue:**
because the bump must be reviewable, the release cannot simply push to `main`.
Two lanes satisfy the criteria and should be chosen between explicitly:

- *Publish-then-bump-PR* — cut the tag/release immediately on a bumped commit on
  a release branch and open the bump PR for `main`; the release is public before
  the PR merges.
- *Two-phase* — open the bump PR first and gate publication of the tag/release on
  that PR merging; nothing is public until it is reviewed.

The first ships faster but publishes before review; the second keeps the human
merge gate in front of every published release. Pick one and state it in the PR.
Reuse the shared version-file definition and canonical-version rule introduced by
`0039-version-writeback-on-release`; do not re-list the four files here.

## Test notes
- A release whose bump PR targets a `master`-default repo tags the bumped commit and opens the PR against `master`, not a hardcoded `main`.
- The release POST and the branch/PR creation are exercised against a mocked GitHub API (as `release.test.mjs` already does), asserting the tag's target tree carries the released version.
