---
title: Plans declare exclusive resources and the sync serializes plans that claim the same resource
priority: high
labels: [scripts, planning]
blocked_by: [0191-plan-size-budget]
---

Three migration collisions and a route collision happened because independent
plans silently claimed the same exclusive resource and ran concurrently. A plan
file declares what it locks (for example `locks: [migration, route:/home,
file:src/db/schema.ts]`); the sync refuses to mark two plans ready that claim
the same resource token, serializing the later one behind the earlier one via
the existing blocked-state machinery instead.

## Acceptance criteria
- [ ] A plan file may declare `locks: [<token>, ...]` in frontmatter; the sync accepts the key without an unknown-frontmatter-key warning
- [ ] When two plan files with open issues claim the same lock token, the sync marks at most one `state:ready`; the other syncs `state:blocked` with the conflicting slug named in its issue body — selection is deterministic (priority, then slug order)
- [ ] When the issue holding a contested lock closes, the serialized issue is unblocked by the existing unblock machinery without manual edits
- [ ] Lock tokens are compared as exact strings; every detected conflict pair is logged in the sync output
- [ ] A malformed `locks` value (not a list of strings) aborts the sync non-zero, naming the file
- [ ] `plan/README.md` documents the key with the token conventions (`migration`, `route:<path>`, `file:<path>`)
