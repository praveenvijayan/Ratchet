---
title: Make ratchet-uninstall remove everything Ratchet installed, and only that
priority: high
labels: [installer]
blocked_by: [0103-install-manifest-and-profiles, 0105-bootstrap-installer]
---

`scripts/ratchet-uninstall.sh` removes only a hard-coded subset of workflows
and scripts, leaving behind `pr-gates.yml`, `release.yml`,
`review-verdict.yml`, `state-label-exclusivity.yml`,
`archive-closed-plans.yml`, and most framework scripts. A fresh install
followed by uninstall does not return the project to its prior state. The
uninstaller should operate on the installation manifest: remove exactly what
was recorded as installed, and nothing the host owns.

## Acceptance criteria
- [ ] After bootstrap-install then uninstall in a previously Ratchet-free repository, no Ratchet-installed `framework` file remains — the working tree matches its pre-install state except for files the host created or explicitly chose to keep
- [ ] Files the host project owns (its own workflows, scripts, README, LICENSE) are untouched by uninstall, even when they share directories with removed framework files
- [ ] Files recorded as `generated` (GATES.md, memory/, plan/ content) are kept by default, and removed only with an explicit flag after listing them
- [ ] A framework file the host has locally modified is listed and skipped by default, so uninstall never destroys local changes silently
- [ ] Running the uninstaller with no installation manifest present fails with a clear message explaining the manifest is missing and what to do, changing nothing — never a partial removal
- [ ] Every criterion above has exactly one test named after it
