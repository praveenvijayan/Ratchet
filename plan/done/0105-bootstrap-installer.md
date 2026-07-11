---
title: Build a bootstrap installer that installs Ratchet into a host project
priority: high
labels: [installer]
blocked_by: [0103-install-manifest-and-profiles]
---

Installation today means copying the entire Ratchet repository into the host
project — backlog, tests, branding and all — then running `setup.sh`.
`ratchet-update.sh` cannot bootstrap because it requires itself to already
exist in the target. A `scripts/bootstrap.sh` should download a pinned Ratchet
release, read the manifest from `0103-install-manifest-and-profiles`, and
install only the files the selected profile requires — safely, visibly, and
non-destructively.

## Acceptance criteria
- [ ] Running the bootstrapper in a git repository with a pinned `--version <tag>` installs exactly the manifest's `framework` files for the selected profile(s), writes `.ratchet-version` and an installation manifest recording every installed path, and prints the next steps including `/ratchet-init`
- [ ] Files classified `excluded` in the manifest (Ratchet plans, `plan/done/`, `plan/examples/`, `*.test.mjs`, branding, README/DOCS) are absent from the host project after install
- [ ] `--dry-run` prints what would be created, skipped, or conflicted and leaves the host project byte-for-byte unchanged
- [ ] An existing host file at a path the installer would write is never overwritten without `--force`: the run lists each conflict and exits non-zero, changing nothing
- [ ] Running outside a git repository fails with a clear "not a git repository" message before downloading anything
- [ ] Running without `--version` either requires an explicit `--version main` opt-in or prints a prominent warning that an unpinned install is not reproducible
- [ ] An unresolvable version/tag or failed download fails with a clear message naming the ref and leaves the host project unchanged — never a partial install
- [ ] Archive extraction rejects entries that would escape the target directory (path traversal), failing with a clear message
- [ ] The bootstrapper never creates GitHub labels, secrets, branch protection, or issues, and never copies `.env`, tokens, or local settings files
- [ ] Every criterion above has exactly one test named after it

## Test notes
- Drive the script end-to-end against a local fixture remote (a bare repo with a tagged tree) in a temporary directory, exercising the real download-select-install path rather than mocking git.
