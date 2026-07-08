---
title: /ratchet-update records the version of the tag it pulled
priority: medium
blocked_by: [0049-release-version-writeback]
---

`ratchet-update.sh` records the upstream `.ratchet-version` *file content* over
the ref name. Once releases carry a correct `.ratchet-version` in the tagged tree
(`0049-release-version-writeback`), updating a consumer to a tag must leave that
consumer recording that tag's version — not a stale value, and not tripping over
the bare-vs-`v` convention. Close the loop so `/ratchet-update`'s later version
comparisons tell the truth.

## Acceptance criteria
- [ ] After `./scripts/ratchet-update.sh <tag>`, the consumer's `.ratchet-version` equals the version that tag carries — e.g. updating to `v1.4.0` records `1.4.0` — under the same bare-vs-`v` normalisation as the consistency check
- [ ] Updating to a tag whose tree has no `.ratchet-version` records that tag's own version string (normalised), never a stale or empty value
- [ ] An unresolvable ref (`./scripts/ratchet-update.sh does-not-exist`) fails with a clear "cannot resolve ref" message and leaves the existing `.ratchet-version` unchanged — not a stack trace or a wiped file

## Test notes
- Drive the script against a local fixture repo used as `RATCHET_REMOTE` (create it, commit a `.ratchet-version`, tag it), so the test exercises the real checkout-and-record path rather than mocking git.
- Cover both the tag-has-`.ratchet-version` and tag-lacks-`.ratchet-version` branches, and the unresolvable-ref failure, each named after its criterion.
