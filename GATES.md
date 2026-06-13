<!--
GATES.md — the ONLY project-specific file in Ratchet. It holds the verification
gates the agent runs before opening a PR. /factory-init fills this in by
detecting your stack; edit it freely. Ratchet updates never overwrite this file.

Rules: run in order, fail-fast (stop at the first failure). A gate with no
command for your project should read `TODO: <gate> command`, not a guess.
-->

# Gates

Run in order, fail-fast. Replace the commands with your stack's equivalents
(or let `/factory-init` detect them).

| Order | Gate      | Command                | Pass condition |
|-------|-----------|------------------------|----------------|
| 1     | format    | `npm run format:check` | no diff        |
| 2     | typecheck | `npm run typecheck`    | exit 0         |
| 3     | lint      | `npm run lint`         | exit 0         |
| 4     | test      | `npm test`             | exit 0         |
| 5     | build     | `npm run build`        | exit 0         |
