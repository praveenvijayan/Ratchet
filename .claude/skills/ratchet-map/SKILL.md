---
name: ratchet-map
description: Regenerate memory/ARCHITECTURE.md — a coarse, language-agnostic map of the codebase the agent uses to orient and scope its reads. Use when the structure has drifted enough that incremental updates aren't enough, or to refresh a stale map. Writes the file and stops for review; never commits.
disable-model-invocation: true
allowed-tools: Read, Write, Glob, Grep, Bash(ls:*)
---

# Map the codebase

Produce a fresh, coarse `memory/ARCHITECTURE.md` from the actual repository.
Language-agnostic: do not assume any stack.

## Steps

1. **Detect the project type** from manifests (`package.json`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `pubspec.yaml`, `pom.xml`, `Gemfile`, …) and find the
   conventional source root(s) (`src/`, `lib/`, `app/`, `cmd/`, …). If you don't
   recognise the ecosystem, fall back to describing the top-level directories.

2. **Walk the top-level and source directories** and describe each one's
   **purpose** and the **major components/modules by role**. **Ignore generated
   and vendor directories entirely** — `build/`, `dist/`, `target/`, `out/`,
   `bin/`, `obj/`, `node_modules/`, `.dart_tool/`, `ios/Pods/`, `vendor/`,
   `__pycache__/`, `.next/`, and any package cache. Never read into them.

3. **Capture conventions** (layering, naming, where new code of each kind goes)
   and, cautiously, **what is not yet present**.

4. **Write `memory/ARCHITECTURE.md`** under the sections in the template
   (Project type, Source layout, Major components, Conventions, Not yet present).
   Keep the rules header. Mark it machine-generated and provisional.

5. **Report, then stop.** Summarise what you mapped. Do not commit — leave the
   diff for review, like any other memory change.

## Hard rules

- **Coarse only.** Directories and responsibilities, components by role. NEVER
  line numbers, function signatures, dependency versions, or absolute paths.
  Repo-relative paths only.
- Never read into or describe generated/vendor directories.
- Write only `memory/ARCHITECTURE.md`. Touch no other file, no code, no branch.
- Never commit or push. The map is a provisional orientation, not authority —
  when it disagrees with the code, the code wins.
