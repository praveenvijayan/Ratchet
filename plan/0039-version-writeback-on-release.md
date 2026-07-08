---
title: Close the version write-back loop between releases and ratchet-update
priority: medium
blocked_by: [0038-release-422-and-default-branch]
---

The release lane bumps *tags only*: nothing ever updates `.ratchet-version`,
`plugin/.claude-plugin/plugin.json`, the README badge, or the DOCS.md header.
Meanwhile `ratchet-update.sh` deliberately records the upstream *file* version
over the ref name. From the second release onward every consumer that updates
to a tag records a stale version, and `/ratchet-update`'s comparisons lie
thereafter. Latent today (zero tags exist); guaranteed once releases flow.

## Acceptance criteria
- [ ] Cutting a release leaves the tagged tree recording its own version — `.ratchet-version` and the mirrored version strings match the tag, via a reviewable change, not a direct push to main
- [ ] After `/ratchet-update <tag>` the consumer's recorded version equals that tag's version
- [ ] A tree whose version strings disagree with each other fails a check loudly instead of shipping mixed versions
