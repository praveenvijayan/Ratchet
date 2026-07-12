---
title: Publish GitHub releases so the documented install command works
priority: high
labels: [release, install]
blocked_by: []
---

No git tag or GitHub release has ever been published on this repository, so the
README quick-install command
(`curl -fsSL https://raw.githubusercontent.com/praveenvijayan/Ratchet/<tag>/scripts/bootstrap.sh | bash -s -- --version <tag>`)
returns `curl: (56) The requested URL returned error: 404` for every tag a user
tries. Installation is completely broken for new users.

## Acceptance criteria
- [ ] Running the release workflow with `RATCHET_RELEASE=true` publishes a git tag and GitHub release whose version matches `.ratchet-version` on the default branch
- [ ] After a release publishes, an automated smoke check fetches `scripts/bootstrap.sh` at the new tag over HTTPS and runs it with `--dry-run`, failing the workflow visibly if the fetch or the run fails
- [ ] README install instructions give a command that succeeds verbatim (fetches the bootstrap script from a ref guaranteed to exist), with no unresolved `<tag>` placeholder in the copy-paste path
- [ ] When `RATCHET_RELEASE` is not `true`, the workflow run reports that it was skipped and why, instead of silently doing nothing
- [ ] Every criterion above has exactly one test named after it

## Notes
Root cause found during triage: `git ls-remote --tags origin` and
`gh release list` are both empty. `release.yml` is `workflow_dispatch`-only and
gated on the repo variable `RATCHET_RELEASE`, which was never set, so the
release lane has never run and no install URL can resolve. Enabling the
variable and dispatching the first release is a maintainer action; this issue
covers making the pipeline, its post-publish verification, and the documented
install path provably work end-to-end.
