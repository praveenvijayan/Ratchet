---
title: Four framework workflows drop contents:read — checkout fails with "repository not found"
priority: high
labels: []
blocked_by: []
---

`unblock-dependents.yml`, `state-label-exclusivity.yml`, `review-verdict-sweep.yml`
and `conflicted-prs.yml` each declare a non-empty `permissions:` block that omits
`contents: read`. A non-empty block sets every unlisted scope to `none`, so
`actions/checkout` fails with `fatal: repository not found` on private repos and
the job dies before its script runs. All four are `framework`-class entries in
`ratchet-manifest.json`, so every host installs the broken copy. This is the same
defect fixed for `review-verdict.yml` in [[0115-review-verdict-contents-read]],
across four more workflows.

## Acceptance criteria
- [ ] Each of `unblock-dependents.yml`, `state-label-exclusivity.yml`,
      `review-verdict-sweep.yml` and `conflicted-prs.yml` grants `contents: read`
      in its `permissions` block, alongside its existing scopes
- [ ] A test asserts that every workflow running `actions/checkout` grants
      `contents: read`, guarding all four (and future workflows) against
      regressing to omit it
- [ ] `.ratchet-version` is bumped so hosts detect the new manifest hash and
      re-sync the patched framework workflows

## Notes
The four `.github/workflows/*.yml` files are themselves the framework templates
shipped via `ratchet-manifest.json` — patching them patches the templates. Host
copies patched locally diverge from the manifest hash and are skipped by
`ratchet-update` as locally modified until this lands and hosts re-sync (same
mechanics noted in 0115).
