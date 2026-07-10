---
title: Document the installer flow and add end-to-end installation tests
priority: medium
labels: [installer, docs]
blocked_by: [0105-bootstrap-installer, 0107-manifest-aware-update, 0108-manifest-aware-uninstall, 0111-updater-modified-file-protection]
---

README.md still instructs users to copy the full Ratchet repository into their
project, and no test exercises the install → update → uninstall lifecycle
against a real repository. Once the bootstrapper, manifest-aware updater, and
manifest-aware uninstaller exist, the docs must describe the new flow and an
end-to-end suite must protect it.

## Acceptance criteria
- [ ] README.md's installation section documents the bootstrap flow (pinned-version download-and-run as the primary path, with the copy-the-repo instructions removed) including profile selection and the `/ratchet-init` follow-up
- [ ] DOCS.md documents the manifest classifications, the available profiles, and the update/uninstall contracts (what is refreshed, preserved, and removed)
- [ ] Documentation warns against unpinned `curl | bash` installs and shows the download-then-inspect-then-run alternative
- [ ] An end-to-end test creates a temporary git repository, runs bootstrap-install, update to a newer fixture version, and uninstall, asserting the working tree at each step — and fails with the differing paths when any step ships, misses, or leaves behind a file
- [ ] Every criterion above has exactly one test named after it
