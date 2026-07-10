---
title: Add herd config loader, validation, and init for .ratchet/herd.json
priority: medium
labels: [herd]
blocked_by: []
---

First slice of `ratchet-herd`, the headless fleet supervisor: a per-project
config file that keeps the framework pure. Which agent CLIs exist, their flags,
prompt templates, and env all live in `.ratchet/herd.json` — never in code.
This issue ships the config contract, its loader/validator inside
`scripts/herd.mjs`, and an `init` step that writes sensible defaults (claude,
codex) as config, plus the offline test harness (`scripts/herd.test.mjs`, stub
CLIs as shell scripts) that later herd issues build on.

## Acceptance criteria
- [ ] `node scripts/herd.mjs init` writes a default `.ratchet/herd.json` with claude and codex adapters, and refuses to overwrite an existing file with a clear message
- [ ] Running the supervisor with no `.ratchet/herd.json` exits nonzero with a one-line hint to run the init step
- [ ] Malformed JSON, empty `adapters`, or `routing` without a `default` entry exits nonzero with a one-line error naming the file and the problem
- [ ] Omitted optional fields default to `maxWorkers: 3`, `pollSeconds: 60`, `reworkCap: 2`, `logDir: ".ratchet/logs"`
- [ ] `{prompt}` and `{issue}` are the only placeholders substituted in adapter command arrays and prompt templates; any other brace token passes through verbatim
- [ ] Routing resolves an issue's adapter by first matching label, falling back to the `default` entry
- [ ] An adapter without a `resume` command resolves its resume command to its `launch` command
- [ ] A purity test greps `scripts/herd.mjs` and fails on any reference to specific proxies, terminal multiplexers, or model names
- [ ] `scripts/herd.test.mjs` passes offline with plain `node`, and GATES.md lists it

## Notes
Zero new dependencies — Node built-ins only, matching the existing
`scripts/*.mjs` idiom. The `env` map in an adapter merges into the worker's
environment untouched; Ratchet never interprets it.
