---
name: ratchet-herd
description: Operate the ratchet-herd fleet supervisor. Validates `.ratchet/herd.json` and surfaces the init hint when it is missing (starting nothing), starts the supervisor when none is running, or attaches to a running one and summarizes its state — live workers, attempts, and pending escalations. A thin convenience over `scripts/herd.mjs`; the script is the product and does all the work.
disable-model-invocation: true
allowed-tools: Read, Bash(node:*), Bash(pgrep:*)
---

# Ratchet herd — run the fleet supervisor

`scripts/herd.mjs` is the headless supervisor: it surveys GitHub, reconciles a
state file, dispatches at most one worker per poll, monitors exits, and verifies
herd-opened PRs. **The script is the product; this skill is convenience.** Every
step below is a plain `node scripts/herd.mjs …` invocation or a read of a file
the script writes — the skill adds no behavior of its own, so an operator with
no skill runs the exact same commands by hand.

The supervisor never merges, approves, closes, or labels anything, and neither
does this skill — human review is the only gate.

## 1. Validate the config — start nothing

Preflight with a single, non-spawning pass:

```sh
node scripts/herd.mjs run --dry-run
```

`--dry-run` validates `.ratchet/herd.json`, prints the plan, and spawns no
workers (it implies a single pass, so it never enters the poll loop).

- **Config missing** → the script prints the init hint and exits non-zero,
  having started nothing:
  `` .ratchet/herd.json not found. Run `node scripts/herd.mjs init` to create it. ``
  Surface that line, run `node scripts/herd.mjs init` to write the default
  config, tell the operator to edit `.ratchet/herd.json` (adapters, routing),
  then stop. Do not start the supervisor.
- **Config invalid** → the script prints one line naming the file and the exact
  problem, and exits non-zero. Report it verbatim and stop.
- **Config OK** → the dry-run prints the reconciled plan. Proceed to step 2.

## 2. Start, or attach and summarize

Detect a running supervisor:

```sh
pgrep -f "herd.mjs run"
```

**None running → start it.** Run the poll loop in the foreground:

```sh
node scripts/herd.mjs run          # polls every pollSeconds until stopped
node scripts/herd.mjs run --once   # one pass, then exit (bounded check)
node scripts/herd.mjs run --max 2  # override maxWorkers for this run
```

**One already running → attach and summarize.** Do not launch a second
supervisor. The running one keeps all shared state in the files it writes — read
them and report:

- **Live workers, attempts, status, PR** — `.ratchet/herd-state.json`, keyed by
  issue: `{ adapter, pid, logFile, attempts, status, pr }`. A worker is live
  when its `pid` is still running.
- **Pending escalations** — `.ratchet/herd-escalations.md`, the append-only log
  of anomalies the supervisor could not resolve and handed to a human.

For a freshly reconciled snapshot without launching a persistent supervisor, run
`node scripts/herd.mjs run --once`: it surveys reality, reconciles the state
file, and prints a one-line summary (ready, in-progress, open PRs, live
workers).

## Hard rules

- The script is the product. Every action here is `node scripts/herd.mjs …` or a
  read of a file it writes — never reimplement its logic in the skill.
- Config missing or invalid → surface the script's message and start nothing.
- Never run two supervisors at once; attach to the running one instead.
- Never merge, approve, close, or label — human review is the only gate.
- Edit this skill only at `.agents/skills/ratchet-herd/SKILL.md`, then run
  `./setup.sh` to regenerate the `.claude` and `plugin` mirrors. Never edit the
  mirrors directly.
