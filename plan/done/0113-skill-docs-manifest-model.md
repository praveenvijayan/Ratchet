---
title: Align ratchet-update and ratchet-uninstall skill docs with the manifest-driven scripts
priority: medium
labels: [docs, installer]
blocked_by: []
---

The update/uninstall scripts became manifest-, profile-, and hash-aware
(issues 0107, 0108, 0111), and DOCS.md/README.md were updated (0109) — but the
two SKILL.md files still describe the old model. `ratchet-update/SKILL.md`
claims a fixed framework path set with no mention of `.ratchet-install.json`,
profile scoping, the modified-file hash guard, or `--force`.
`ratchet-uninstall/SKILL.md` lists `GATES.md` as a removed framework file when
the script keeps it as `generated`, still describes the retired
"recognizably Ratchet's" heuristic, and omits `--purge-generated` and the
missing-manifest failure mode. An agent driving these skills gives users wrong
expectations about what will be touched.

## Acceptance criteria
- [ ] `ratchet-update/SKILL.md` states the updater requires `.ratchet-install.json`, pulls only the installed profiles' `framework` files from the manifest, and fails with a clear message when the install manifest is missing
- [ ] `ratchet-update/SKILL.md` documents that locally-modified framework files are listed and skipped by default and only overwritten with `--force`
- [ ] `ratchet-uninstall/SKILL.md` classifies `GATES.md` and other `generated` files as kept by default and removable only via an explicit purge flag, with no mention of the retired name-recognition heuristic
- [ ] `ratchet-uninstall/SKILL.md` states the uninstaller requires `.ratchet-install.json` and exits with a clear message changing nothing when it is absent
- [ ] The skill mirrors (`.claude/skills/`, `plugin/skills/`) are byte-identical to `.agents/skills/` for both skills after the change
- [ ] Every criterion above has exactly one test named after it
