---
title: Bootstrap fails clearly when the requested version ref does not exist
priority: medium
labels: [install]
blocked_by: []
---

`scripts/bootstrap.sh` never checks that the ref passed via `--version` exists
on the remote. A typo'd or unpublished tag surfaces as raw curl 404 errors
partway through the install instead of a clear up-front failure.

## Acceptance criteria
- [ ] When the `--version` ref does not exist on the remote, bootstrap exits non-zero before writing any file to the target project
- [ ] The failure message names the requested ref and tells the user how to find valid versions (the releases page, or `--version main` to track latest), never a raw curl 404 error
- [ ] A ref that exists installs exactly as before (regression guard)
- [ ] Every criterion above has exactly one test named after it
